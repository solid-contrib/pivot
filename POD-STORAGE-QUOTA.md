# Pod Storage Quota — Performance Analysis & Design (2026-08-11)

Pivot runs on the Community Solid Server (CSS) file backend with a per-pod quota
(`css:config/storage/backend/pod-quota-file.json`, enabled from `config/prod.json`).

**Problem:** the quota is enforced by recursively walking the whole pod tree on
every write. With tens of thousands of files (e.g. a large inbox) this becomes
extremely slow and, under concurrent writes, fills memory and takes the server
down. Disabling the quota (config-only) removes the cost but loses the feature.

---

## 1. How quota works today (CSS v7.x)

Three moving parts:

### 1.1 `QuotaValidator` (`dist/storage/validators/QuotaValidator.js`)
Runs on every write/PATCH pipeline and:
1. `getAvailableSpace()` **before** the write → full pod walk.
2. `createQuotaGuard()` — a streaming guard wrapped around the write body.
3. `getAvailableSpace()` **again** after the write (`afterWrite` flush).

### 1.2 `QuotaStrategy.createQuotaGuard()` — the real killer
```js
async transform(chunk, enc, done) {
    total += await reporter.calculateChunkSize(chunk);
    const availableSpace = await that.getAvailableSpace(identifier); // ← FULL POD WALK, PER CHUNK
    ...
}
```
`getAvailableSpace()` → `getTotalSpaceUsed()` → `reporter.getSize(podRoot)` →
full recursive `FileSizeReporter.getTotalSize()` walk. So a single multi-chunk
upload walks the **entire pod once per stream chunk**. This is `chunks × O(N)`.

### 1.3 `FileSizeReporter.getTotalSize()` (`dist/storage/size-reporter/FileSizeReporter.js`)
```js
if (stat.isFile()) return stat.size;
const childFiles = await fs.readdir(fileLocation);   // one big dirent array
let totalSize = stat.size;
for (const current of childFiles) {
    // skip ignoreFolders (e.g. /.internal/)
    totalSize += await this.getTotalSize(childFileLocation); // recursion
}
```
Sequential `stat` + `readdir` per entry — O(N) syscalls per walk, one large
dirent array per directory in the Node heap.

### Cost profile
| | Per write |
|---|---|
| Pre-check | 1 full walk |
| Streaming guard | 1 full walk **per chunk** |
| Post-check | 1 full walk |

Concurrent writes multiply the walks → memory exhaustion (dirent arrays + stat
results + in-flight async walks pile up in the Node heap).

---

## 2. Backend impact (memory / database)

CSS has **only one size reporter: `FileSizeReporter`** (filesystem-specific).
There is no memory or database reporter.

| Backend | Quota wired? | Notes |
|---|---|---|
| **File** (`file.json`, `pod-quota-file.json`) | ✅ | The O(N)-per-write problem above. |
| **Memory** (`memory.json`, `MemoryDataAccessor`) | ❌ none | No quota at all. 10k-file inbox lives in RAM (inherent to backend). If quota wanted, size calc is trivial (sum contentLength in-memory) and an incremental counter needs no persistence. |
| **Database** (`sparql.json`) | ❌ none | No quota. "Size" is ambiguous (bytes vs quads); counter would be a table + delta queries. |

The recursive-walk problem is specific to the **file backend** (what pivot uses).
Design C targets the file backend first, keeping the reporter/counter pluggable.

---

## 3. Fix directions

### A. Stop the per-chunk full walk (mandatory, lowest risk)
Compute `availableSpace` **once** before the stream; during streaming only track
the current write's byte delta and compare:

```js
availableSpace = await strategy.getAvailableSpace(identifier); // once
transform(chunk) {
    total += chunk.length;
    if (availableSpace.amount < total) throw Quota exceeded;
    push(chunk);
}
```
Correct: `getAvailableSpace` already subtracts the overwritten resource's size,
and nothing else about the pod changes mid-write. Atomic writes go to
`/.internal/` (ignored by the walk) anyway.
Cost: `chunks × O(N)` → **~2 × O(N) per write** (pre + post). Kills the memory
blowup from concurrent chunk-streams.

### B. Cache / memoize the pod size
Wrap `getSize(pod)` with a per-pod cache:
- **TTL variant:** cache `{ size, expiresAt }` (e.g. 1–5 s); one walk per expiry.
- **Invalidation variant:** drop the pod's cache entry when a write completes.
Combined with A, roughly **1 walk per pod per TTL window / per invalidation**.
Caveat: TTL window staleness (concurrent writes may exceed the limit undetected
within the window; CSS already documents tolerance of races).

### C. Incremental per-pod counter (durable end-state)
Per-write O(1); one full walk only for bootstrap/recovery. See §4.

---

## 4. Design C — incremental per-pod byte counter

### 4.1 Counter store
- **In-memory:** `Map<podPath, { total: number, valid: boolean }>` — O(1) reads.
- **Persistence:** per-pod sidecar, e.g. `<podRoot>/.internal/pivot-quota.json`
  (`.internal/` is already ignored by size accounting). Written **atomically**
  (write temp + rename) on each write → crash-safe.

### 4.2 Recount (bootstrap / recovery)
- First access to a pod with no valid counter → **one** full walk to seed it.
- Startup: load sidecar if present (no walk); else lazy recount on first access.
- Crash between write and persist: mark dirty / recount on next access.

### 4.3 Delta hooks
A pivot store wrapper (like the existing `RdfPatchingStore`) around the backend:
- **Before:** `oldSize = accessor.getSize(identifier)` (O(1) single `stat`).
- Perform write/delete.
- **After:** `newSize = accessor.getSize(identifier)`.
- `Δ = newSize − oldSize` → `counter[pod] += Δ`.

Cases:
- Create: `Δ = file size`. Overwrite: `Δ = new − old` (can be negative).
- Delete: `Δ = −oldSize`. Auxiliary writes (`.acl`/`.meta`): included (matches today).
- Atomic temp files: no special handling (rename exposes only the final file).

### 4.4 Read path
`getSize(pod)` → `counter[pod].total` if valid, else recount. Plugs into the
**existing** `PodQuotaStrategy`/`QuotaValidator` unchanged — only
`urn:solid-server:default:SizeReporter` is replaced (plus the delta store
wrapper). No validator/strategy changes.

### 4.5 Concurrency
- Per-pod mutex serializes `counter += Δ`.
- Sidecar atomic rename per write (cheap). Optional mode: persist periodically +
  always recount on startup (simpler, costs a startup walk per pod).

### 4.6 Edge cases / staleness
- Out-of-band file changes → stale counter. Mitigations: on-demand recount
  endpoint, or periodic background recount. Documented limitation.
- Pod deletion → remove counter entry.

### 4.7 Config wiring (pivot)
- New pivot components: `IncrementalSizeReporter` (counter + recount) and a
  quota-delta store wrapper.
- Override `urn:solid-server:default:SizeReporter` and insert the wrapper in the
  store chain via `pivot:config/storage/backend/...`, keeping
  `pod-quota-file.json`'s validator/strategy. No CSS fork.

### 4.8 Staleness detection & recovery (added 2026-08-15)

The counter is **only an optimization — the filesystem is the source of
truth**, and `du` is a cheap way to re-derive truth. So a de-synchronized
counter is never permanent or catastrophic: it self-heals on next access.

**Causes of de-sync**

| Cause | How it happens |
|---|---|
| Out-of-band changes | Files added/removed directly on disk (admin, scripts, restore, sync tool) — bypasses the delta hook |
| Crash between write & persist | Data write lands, but the process dies before the sidecar rename — counter short by that one delta |
| Migration/bootstrap | Pods created before the feature → no sidecar (handled lazily at first access) |
| Auxiliary writes bypassing the hook | A code path (`.acl`/`.meta`, temp files, future store change) that forgets to report its delta |
| Manual tampering | Sidecar edited/deleted/restored from a backup without the pod |

**Detection — cheap validity checks on read** (no walk required):

1. `valid` flag / generation marker — sidecar records `{ total, valid,
   version }`. Any path that can't guarantee a delta flips `valid: false`.
2. **Pod-root mtime comparison** — sidecar stores the pod root's
   `lastRecordedMtime`; on read, one `stat` of the pod root — if newer than
   `lastRecordedMtime`, the counter may be behind → invalidate → recount.
   Catches out-of-band writes for the cost of a single `stat`.
3. **Sanity bound** — if `total` is wildly inconsistent with expectation
   (e.g. 0 but the pod has files), treat as dirty.

**Recovery — reuse the lazy path**: invalidation just means "delete/flag the
sidecar"; the existing lazy-bootstrap path does the rest — next access to
that pod runs one `du` and re-seeds.

- On suspicion (mtime/flag/`valid:false`) → mark dirty → recount on next
  access. One `du`, non-blocking.
- Crash window — atomic rename keeps the sidecar internally consistent (old
  or new, never torn); add `fsync` before the rename completes the response,
  shrinking the window. If a crash still lands in it, the pod-root mtime
  check catches it on next access.
- Admin/on-demand recount — small CLI/HTTP/admin hook to force recount of one
  pod or all pods (delete sidecars → next accesses recount, or an explicit
  sweep).
- Optional background reconciliation — low-priority idle job walks pods with
  `du` every few hours to bound drift over time. Never at startup, never
  blocking writes.

**Bottom line:** de-sync is detected cheaply (mtime/valid flag, one `stat`)
and fixed cheaply (`du` recount on next access). Worst persistent state is
"counter slightly behind until next access of that pod", which then
self-heals.

---

## 5. Using `du` as the fast walk / recount primitive

Instead of the Node recursive walk, shell out to GNU `du` — C-level `fts`
traversal:

- **Speed:** 10–100× faster than the per-entry Node `stat`/`readdir` loop.
- **Memory:** the walk runs in a child process — dirent arrays / stat buffers
  never touch the Node heap (directly fixes the memory blowup).
- **Unit:** `du -sb` = apparent bytes (sum of `st_size`) — identical semantics
  to today's `FileSizeReporter` and the **chosen unit (2026-08-15)**: portable
  across servers/filesystems and user-manageable. `du -s --block-size=1` =
  disk usage — **rejected**: the result is server/filesystem-dependent
  (cluster size, compression, COW), not user-manageable, and Solid pods are
  small-file-heavy so cluster rounding would dominate.

### Critical caveat
**Never call `du` per stream chunk** — spawning a process per chunk is a spawn
storm. `du` must be combined with fix **A** (walk only at pre/post check) and
ideally with **B**/**C** (walk only on recount). In design C, `du` is the
recount/seed engine only; steady-state writes are O(1) with zero spawns.

### Practical concerns
| Concern | Handling |
|---|---|
| `ignoreFolders` (`.internal/`) | GNU `du --exclude=PATTERN` (or `--exclude-from`) — must match current behavior. |
| Path safety | `execFile('du', ['-sb', '--exclude', ..., podPath])` — never shell interpolation; CSS already containment-checks mapped paths. |
| Portability | `du` is coreutils/BSD — fine on Linux/WSL test servers, **not native on Windows**. Fall back to the Node walk when `du` is unavailable. |
| Symlinks/hardlinks | `du` doesn't follow symlinks by default (FileSizeReporter's `stat` does). Minor edge case — document. |
| Concurrency | With A+B/C, `du` spawns are rare → no process storm. |

### Recommendation
- **Short/medium term:** `du` as the walk engine behind `getTotalSize`, **plus**
  fix A (no per-chunk walk), **plus** a small TTL cache (B) → ~1 `du` spawn per
  write. Small change, keeps the architecture, kills time + memory problems.
- **Long term:** same `du` as the recount engine inside **C** — incremental
  counter, deltas per write, `du -sb` only to seed/repair. O(1) writes with
  native-speed recovery.

### Platform / flags

**Performance: apparent-size vs disk-blocks — no meaningful difference.**
Both variants traverse the identical tree (same `readdir`/`stat` syscalls);
apparent size sums `st_size`, disk usage sums `st_blocks` (already in the
`stat` result). No extra syscalls either way → pick the unit purely on quota
semantics, not performance.

`du` availability:

| Platform | `du` | Flags |
|---|---|---|
| **Linux** (incl. WSL) | ✅ GNU coreutils | `-sb` (apparent bytes), `--block-size=1` / `-B 1` (disk bytes), `--exclude=PATTERN` |
| **macOS** | ✅ BSD `du` (always present) | **No GNU long options.** Apparent size: `-A`; bytes: `-B 1`; exclude: `-I pattern`; default block unit 512 B. So `du -s -A -B 1` ≈ GNU `du -sb`, `du -s -B 1` ≈ GNU `du -s --block-size=1` |
| **Windows** | ❌ **no native `du`** | None in cmd/PowerShell. Sysinternals `du.exe` (different CLI, not GNU-compatible), or GNU `du` via Git Bash / MSYS2 / Cygwin / WSL. PowerShell `Get-ChildItem -Recurse \| Measure-Object Length -Sum` is the slow JS-style walk |

**Implementation note:** GNU-first, with probe & fallback:
1. Detect GNU vs BSD (`du --version` succeeds on GNU, fails on BSD → use
   `-A`/`-B 1`/`-I`).
2. Fall back to the existing Node recursive walk when no compatible `du` is
   found (e.g. bare Windows) — correct, just slower.

### Unit consistency: apparent bytes everywhere (decided 2026-08-15)

The chosen unit is **apparent bytes** (sum of `st_size` — same as today's
`FileSizeReporter`). This makes the unit fully portable: the same content
measures the same on any server/filesystem, and users can reason about it
("I used 500 MB of 1 GB"). Disk blocks (`st_blocks`) were considered and
rejected because the result is server-dependent (cluster size, compression,
COW) and small-file-heavy Solid pods would be dominated by cluster rounding.

With apparent bytes there is **no platform inconsistency**:

| Path | Unit | How |
|---|---|---|
| `du` (Linux/macOS) | apparent bytes | `du -sb` / BSD `du -s -A -B 1` |
| Node walk (Windows fallback) | apparent bytes | sum `stat.size` |

Both paths sum `st_size` — identical quantity everywhere. (Verified: Node
`fs.stat` also exposes `blocks` on Windows, e.g. a 1000-byte file →
`blocks*512: 4096`, but we deliberately do NOT use it — that would introduce
server-dependent cluster rounding.)

Edge cases:
- Sparse files: apparent bytes counts them at their logical size (matches
  today; a disk-space quota would count less).
- Symlinks: `stat` follows symlinks (matches today's `FileSizeReporter`);
  `du` doesn't by default — already noted as a minor edge case.

---

## 6. Decision points before implementing

### Decisions (2026-08-15)
1. **Unit: apparent bytes** (`du -sb` / sum of `st_size`) — portable across
   servers/filesystems and **user-manageable**; identical semantics to
   today's `FileSizeReporter`, so the existing 70 MB limit in
   `customise-me.json` keeps its meaning. Disk blocks considered and
   rejected (server/filesystem-dependent result; small-file-heavy pods).
2. **Persistence mode: persist-per-write** (atomic sidecar
   `<pod>/.internal/pivot-quota.json`, exact across restarts). **Restart does
   NOT trigger a bulk recount of all pods** — counters are loaded from disk;
   the only full walks are lazy per-pod (first access of a pre-existing pod /
   crash-dirty pod / de-synced pod — i.e. effectively *at login* for that
   pod, never a startup sweep).
3. **Scope: A+B first** (quick win: no per-chunk walk + du-based walk with
   TTL cache), then build C on top later.
4. **Staleness/recovery:** mtime/valid-flag check on read + lazy recount +
   optional background reconciliation (see §4.8).

### Remaining to verify before implementing
- Where before/after sizes are cleanest in the `AtomicFileDataAccessor` /
  store stack (determines how much of C is new plumbing vs reusing existing
  hooks).
- Exact `du` platform handling (GNU `--block-size=1` / BSD `-B 1 -s`, probe
  & fallback to the Node walk; never per-chunk spawns).
- TTL window semantics with concurrent writes (CSS already tolerates race;
  the `QuotaValidator` after-write flush check still catches breaches).

---

## 7. Verification: benchmark + equivalence proof (2026-08-15)

Two scripts in `scripts/` demonstrate the improvement and prove the size
calculation is unchanged.

### 7.1 Benchmark — `scripts/benchmark-quota.js`

Measures exactly what A+B optimizes: the pod walk and the per-write quota
guard. Run `node scripts/benchmark-quota.js [fileCount] [fileBytes]`.

Results on a pod with **5 000 files × 1 KB** (body write = 4 MB in 64 KB
chunks):

| Measure | Old (FileSizeReporter + QuotaStrategy) | New (DuSizeReporter + FastQuotaStrategy) |
|---|---|---|
| Full pod walk (`getSize`) | 669.6 ms | 657.8 ms first call; **0.13 ms cached** |
| Per-write quota guard | **36 279 ms** (≈36 s; full walk **per chunk**) | **3.3 ms** (walk once + cache) |
| Guard speedup | — | **~11 000×** |

Notes:
- On bare Windows both paths use the Node walk (no `du`), so the walk line
  shows ~1×; on Linux/WSL the `du` walk is 10–100× faster than the Node walk.
- The 36 s guard is the exact production bug: a single 4 MB upload into a
  5 000-file pod triggered 64 full pod walks.

### 7.2 Equivalence — `scripts/verify-size-equivalence.js`

Proves the new reporter returns **byte-for-byte identical** apparent-byte
totals to CSS's `FileSizeReporter`. Generates random pod trees (nested dirs,
random-size files, empty dirs, root-level `.internal` temp files) and asserts
equality for **both** the `du` path and the Node-walk fallback.

Run `node scripts/verify-size-equivalence.js [iterations] [maxFiles]`
(with GNU `du` on PATH to exercise the real `du` path — e.g. Git Bash's
`C:\Program Files\Git\usr\bin` on Windows).

Result: **12/12 random trees match exactly** on both paths.

Findings / documented differences:
- **Node-walk fallback is mathematically identical** to `FileSizeReporter`
  (same recursive `stat.size` sum) — always equivalent.
- **`du` path** sums the same `st_size` values (directory sizes included by
  both) — equivalent.
- **Exclusion semantics caveat** (found by the proof): `du --exclude=.internal`
  matches a `.internal` component at *any* depth, while CSS's anchored regex
  `^/\.internal$` only excludes it at the *pod root*. Identical for real pods
  (`.internal` is only ever created at the root — CSS temp files). A nested
  `.internal` would be excluded by `du` but counted by the Node walk — a
  documented, non-issue-in-practice difference.
- **Symlinks** (`du` doesn't follow by default; Node `stat` does) and
  **hardlinks** (`du` counts once; Node per directory entry) differ — neither
  occurs in normal Solid pod storage.

---

## 8. Design C — incremental per-pod counter (implemented 2026-08-15)

**Files:** `src/storage/quota/QuotaCounter.ts`, `src/storage/quota/IncrementalSizeReporter.ts`,
`src/storage/quota/QuotaDeltaDataAccessor.ts`, `config/storage/backend/quota-counter-file.json`,
`src/index.ts`, `config/customise-me.json`, `test/unit/storage/*`, `scripts/benchmark-quota-c.js`,
`scripts/smoke-design-c.js`

Steady-state writes become **O(1)**: a per-pod byte counter is updated by a
delta hook and read by the quota strategy; a full `du`/Node walk happens only
once per pod (bootstrap / recovery).

### 8.1 Components

| Component | Role |
|---|---|
| **`QuotaCounter`** | In-memory `Map<podPath, {total, valid, podMtimeMs}>` + per-pod mutex; sidecar `<podRoot>/.internal/pivot-quota.json` written atomically (temp + rename) on every delta; lazy recount via an uncached `DuSizeReporter`; §4.8 mtime staleness check on read; `register / isPodRoot / getSize / add / remove / sizeOfResource / walk`. |
| **`IncrementalSizeReporter`** | `SizeReporter` replacing `urn:solid-server:default:SizeReporter`: pod root → O(1) counter read; any other resource → single `stat`. |
| **`QuotaDeltaDataAccessor`** | `PassthroughDataAccessor` wrapping the top of the accessor chain; before/after apparent size (data + `.meta` stat; containers walked) on `writeDocument` / `writeContainer` / `writeMetadata` / `deleteResource` → `counter.add(pod, Δ)`. Pod discovery mirrors `PodQuotaStrategy.searchPimStorage` (metadata walk for `pim:Storage`, cached per path); deleting the pod root drops the counter. |

### 8.2 Config wiring (no CSS fork)

`config/storage/backend/quota-counter-file.json` (imported by `customise-me.json`):
- `QuotaCounter` instance (fileIdentifierMapper, rootFilePath, `ignoreFolders: ["^/\\.internal$"]`)
- `Override` `urn:solid-server:default:SizeReporter` → `IncrementalSizeReporter`
- `Override` `urn:solid-server:default:FileDataAccessor` → `QuotaDeltaDataAccessor`
  (wrapping the original FilterMetadata → Validating → Atomic chain, preserving
  the content-length filter)
- `Override` `urn:solid-server:default:QuotaStrategy` → `FastQuotaStrategy` (70 MB)

`QuotaValidator`, `ValidatingDataAccessor`, `AtomicFileDataAccessor` unchanged.

### 8.3 Verification — `scripts/benchmark-quota-c.js`

Old vs A+B vs C under identical conditions, with COLD (first write) and WARM
(steady state) separated. Same host, 5 000 files × 1 KB, 4 MB write in 64 KB
chunks:

| Measure | old | A+B | C |
|---|---|---|---|
| walk `getSize(podRoot)` | 664.8 ms | 745.7 ms cold / 0.19 ms cached | 0.48 ms |
| write guard **cold** | 36 660 ms (64 walks) | 673.7 ms | 630.4 ms (bootstrap) |
| write guard **warm** | — (no cache) | 32.8 ms | **3.38 ms** |

At 10 000 files (WSL1): old = **108 670 ms**, A+B warm = 49.1 ms,
**C warm = 10.6 ms** — C is the only write that stays O(1)/flat.

Notes:
- The early A+B benchmark's "3.3 ms" was warm-cache with the Node-walk fallback
  (no `du`), which is why it differed from later runs — the corrected script
  separates cold/warm and uses the same pod layout for all three.
- C warm's remaining per-write cost is a few `fs.stat`s (pod-root mtime check +
  overwritten-resource stat) plus identifier mapping — no walks. On WSL1
  (drvfs) each stat crosses the WSL→Windows boundary (~1 ms); on native Linux
  (ext4) it is microseconds, so C warm is sub-millisecond and flat.
- The mtime staleness check (one stat per quota read, §4.8) is a deliberate
  robustness tradeoff; it can be made periodic/configurable if stat latency
  matters.

### 8.4 Implementation notes / fixes found by the test run

- `discoverPod` must return the pod root **identifier** (URL), not a filesystem
  path (counter methods map identifiers).
- Tests/config must pass `ignoreFolders: ["^/\\.internal$"]` or the sidecar
  inflates recounts.
- `QuotaCounter.add` records the pod-root mtime **after** persisting
  (`persistWithMtime`): creating `.internal/` bumps the pod-root mtime, so
  recording before would cause a spurious recount on every read.
- The delta hook registers the pod even when a write's delta is 0 (e.g. an
  empty container on filesystems reporting directory size 0), so the reporter
  routes pod-root reads to the counter.
- `scripts/smoke-design-c.js` verifies the compiled dist without jest:
  accumulate, sidecar reload, staleness recount, remove/re-bootstrap, reporter
  O(1)+stat, delta accessor create/overwrite/meta/delete == real walk, pod-root
  delete drops the counter — all pass.

---

## 9. Production incident: IDP lock expiry on `/.internal` (2026-08-16)

**Symptom** (pivot-test, quota-counter config, during real logins):
```
[WrappedExpiringReadWriteLocker] error: Lock expired after 6000ms on https://.../.internal/idp/adapter/AuthorizationCode/
[WrappedExpiringStorage]        error: Error during interval callback: Failed to remove expired entries - Lock expired after 6000ms ...
```

**Why `/.internal` was affected.** The IDP's `KeyValueStorage` (AuthorizationCode
store, `/.internal/idp/adapter/`) is backed by `ResourceStore` →
`ResourceStore_Backend` → `FileDataAccessor` (see CSS
`config/storage/key-value/resource-store.json`). Since `QuotaDeltaDataAccessor`
overrides `FileDataAccessor`, **every** internal write ran through the quota
chain:

1. `QuotaDeltaDataAccessor.track()` — stat + pod-discovery walk + counter sidecar.
2. **`QuotaValidator`** (inside `ValidatingFileDataAccessor`) — calls
   `getAvailableSpace` **before and after** every write + `createQuotaGuard`
   mid-stream. For `/.internal/*`, `getAvailableSpace` did pod discovery
   (`searchPimStorage`) + `reporter.getSize(pod)` — a **full pod walk** whenever
   the pod wasn't counter-registered → pushed the IDP write past the 6 s
   `WrappedExpiringReadWriteLocker` expiry.

`ignoreFolders: ["^/\\.internal$"]` on the reporter only excludes `.internal`
from `du`/walk sizes — it does **not** stop the QuotaValidator from running.

**Fix (two commits on `pod-quota-counter`):**
- `d8c1135` — `QuotaDeltaDataAccessor`: skip delta tracking for `/.internal`
  paths (still performs the write).
- `6692db8` — `FastQuotaStrategy.getAvailableSpace` returns unlimited for
  `/.internal` paths, short-circuiting the QuotaValidator's before/after checks
  and the guard's available-space computation — no pod discovery/walk on
  internal writes.

**Verification:** `benchmark-quota-c.js` C-warm unchanged (~3 ms flat);
`smoke-design-c.js` ALL CHECKS PASSED (calculation intact); lock errors gone on
pivot-test after deploying both commits.

**Lesson:** quota hooks must treat CSS-internal paths (`/.internal/`) as exempt
at **every** layer (delta accessor *and* quota validator/strategy), not just in
the size-reporter's walk excludes.

---
