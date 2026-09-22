# Clear Lock — Internal Expiration Sweeps and Lock Contention (2026-09-22)

Pivot runs on the Community Solid Server (CSS 7.2.0, file backend). CSS keeps a
handful of **internal** key-value stores under `/.internal/`: login cookies,
forgot-password requests, WebID ownership tokens and the OIDC adapter state.
Each store holds values with an optional expiry date, and each is wrapped in an
*expiring storage* that periodically deletes whatever has expired — the sweep.
This branch gives Pivot its own sweep storage and scopes every sweep to the
container it belongs to.

**Problem:** the stock wrapper chain delegates `entries()` to a JSON storage
rooted at `/.internal/`, so a sweep recursively reads **every** internal
document — accounts, indices, locks, the other stores — and filters the keys
only afterwards. With a large account base those walks dominate the server's CPU
between requests; on top of that the four sweeps start in the same instant and
delete everything in one unbounded batch.

---

## 1. What this branch implements

### 1.1 `ScopedJsonResourceStorage` (`src/storage/ScopedJsonResourceStorage.ts`)

A `JsonResourceStorage` whose enumeration starts in a descendant container. Everything
else — key mapping, key hashing, identifiers, file layout — is inherited unchanged:

```ts
export class ScopedJsonResourceStorage<T> extends JsonResourceStorage<T> {
  public constructor(source: ResourceStore, baseUrl: string, container: string, entryContainer: string) {
    super(source, baseUrl, container);
    this.entryContainer = ensureTrailingSlash(joinUrl(baseUrl, entryContainer));
    if (!this.entryContainer.startsWith(this.container)) {
      throw new TypeError('The entry container must be inside the storage container.');
    }
  }

  public async* entries(): AsyncIterableIterator<[string, T]> {
    yield* this.getResourceEntries({ path: this.entryContainer });
  }
}
```

`get('idp/tokens/…')` still resolves through the root-relative key, so the class
slots into the existing wrapper stack (`ContainerPathStorage` →
`MaxKeyLengthStorage` → here) without touching stored data.

### 1.2 `PivotExpiringStorage` (`src/storage/PivotExpiringStorage.ts`)

The same expiry semantics as `WrappedExpiringStorage` (values keep their expiry
date; expired values are deleted on read and by the sweep), plus three things a
periodic sweep needs:

1. **Jitter** — the interval gets a random fraction of the timeout added
   (`jitter`, default `0.15`, `0` disables it), so the four instances created at
   startup no longer sweep in the same instant.
2. **Bounded deletes** — expired entries are deleted in batches of `batchSize`
   (default `32`) instead of one `Promise.all` over the whole set:

   ```ts
   for (let index = 0; index < expired.length; index += this.batchSize) {
     await Promise.all(expired.slice(index, index + this.batchSize)
       .map(async(key): Promise<boolean> => this.source.delete(key)));
   }
   ```
3. **`finalize()`** — clears the sweep timer on shutdown (the timer is still
   `unref`'d as a safety net).

### 1.3 Config wiring (`config/pivot-scoped-sweeps.json`)

Each store is overridden to the same chain with a scoped bottom (cookie example):

```json
{
  "@type": "Override",
  "overrideInstance": { "@id": "urn:solid-server:default:CookieStorage" },
  "overrideParameters": {
    "@type": "PivotExpiringStorage",
    "timeout": 1,
    "source": {
      "@type": "ContainerPathStorage",
      "relativePath": "/accounts/cookies/",
      "source": {
        "@type": "MaxKeyLengthStorage",
        "source": {
          "@type": "ScopedJsonResourceStorage",
          "source": { "@id": "urn:solid-server:default:ResourceStore_Backend" },
          "baseUrl": { "@id": "urn:solid-server:default:variable:baseUrl" },
          "container": "/.internal/",
          "entryContainer": "/.internal/accounts/cookies/"
        }
      }
    }
  }
}
```

The OIDC adapter factory is **redeclared** in the same file
(`ClientCredentialsAdapterFactory` → `ClientIdAdapterFactory` →
`ExpiringAdapterFactory`), because the stock 7.2.0 configuration declares its
storage inline with no `@id` to override; the storage is named
`urn:solid-server:default:PivotExpiringAdapterStorage` so the sweep and its
finalizer can target it.

Finally, the four stores are registered in the finalizer chain so their timers are
stopped on shutdown:

```json
{
  "@id": "urn:solid-server:default:Finalizer",
  "@type": "ParallelHandler",
  "handlers": [
    { "@type": "FinalizableHandler", "finalizable": { "@id": "urn:solid-server:default:CookieStorage" } },
    …
  ]
}
```

The file is imported by `prod.json`, `suffix.json`, `dev-http-suffix.json` and
`dev-http-subdomain.json`. `test.json` is deliberately excluded: that preset has
no accounts, so the stores it would override do not exist there.

### 1.4 What is unchanged, and what is not

Unchanged: keys, key hashing (`MaxKeyLengthStorage` stays in the chain), the
on-disk layout, the expiry semantics, the sweep interval (`timeout: 1` minute keeps
the production policy).

Changed: enumeration reads only the store's container, the four sweeps are
jittered/batched/finalized, and the stores read and write through
`ResourceStore_Backend` instead of the locking store — like the lock storage
itself does. Sweep deletes no longer take a lock per entry, and internal storage
traffic no longer contends with the request pipeline. `/.internal/` stays hidden
from clients (`PathBasedReader`), so this does not widen what a client can reach.

---

## 2. Verification

### 2.1 Unit tests

* `test/unit/storage/ScopedJsonResourceStorage.test.ts` — enumeration starts at the
  scoped container while keys stay root-relative; direct lookups unchanged; long keys
  are still hashed and deleted through the existing stack; an entry container outside
  the storage root is rejected.
* `test/unit/storage/PivotExpiringStorage.test.ts` — the expiry behaviour of the stock
  storage (get/has/set/delete/entries), plus jitter (disabled and enabled), `unref`,
  the sweep deleting only expired entries, bounded batches, the batch-size validation
  and `finalize()`.

### 2.2 Configuration tests

* `test/integration/ScopedSweeps.test.ts` instantiates all four storages from
  `config/prod.json` and asserts the chain
  (`PivotExpiringStorage` → `ContainerPathStorage` → `MaxKeyLengthStorage` →
  `ScopedJsonResourceStorage`) and each `entryContainer`.
* A one-off smoke (not part of the suite) instantiated
  `urn:solid-server:default:App` from `prod.json` + `customise-me.json` with
  Components.js: the app resolves, the cookie store is scoped as above and
  `urn:solid-server:default:Finalizer` reports five handlers
  (`ServerInitializer` plus the four expiring stores).
* The same storage instantiation was run against `dev-http-suffix.json` and
  `dev-http-subdomain.json` to validate the added import.

### 2.3 Live behaviour

The scoped walk was measured in production on 2026-08-30 (pivot-test, ~1000
accounts): CPU dropped from over 95 % with no client traffic to below 1 %, and
latency stayed flat. That deployment used the interim config-only variant of the
scoping; this branch performs the same scoped walk while keeping the key
semantics. The jitter/batching/finalization part is covered by the unit tests
above.

---

## 3. Decisions and limitations

* **Interval**: `timeout: 1` (minute) is kept from the deployed policy. A sweep is
  now cheap, so a short interval only makes expired entries disappear sooner.
* **Defaults**: `jitter` 0.15 and `batchSize` 32 are constructor defaults; both can be
  set per store in the configuration.
* **Maintenance**: `PivotExpiringStorage` mirrors the body of CSS's
  `WrappedExpiringStorage`. It is a copy-in of a small, stable class (the three
  deltas are documented in its header) — if a future CSS version changes the stock
  class, the deltas have to be re-applied.
* **Upstream**: a container-scoped `entries()` in CSS itself (or an `@id` for the
  adapter storage) would make both components unnecessary. Until such a change
  ships, Pivot keeps its own; nothing else in the deployment depends on it.
* **Out of scope**: the lock configuration (file vs Redis, retry bounds, lock
  expiration) is orthogonal — these storage overrides only change where a sweep
  enumerates and how it deletes.
