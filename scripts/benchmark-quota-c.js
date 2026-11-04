/**
 * Rigorous benchmark: original CSS quota chain vs A+B vs design C.
 *
 * Everything is compared under identical conditions, with COLD (first write,
 * no cache / bootstrap) and WARM (steady state) numbers separated:
 *
 *   1. WALK  — a single getSize(podRoot): old Node walk / du walk / cached /
 *              counter (O(1)).
 *   2. WRITE — quota guard over a 4 MB body in 64 KB chunks:
 *        old : per-chunk full walks (no cache — always cold)
 *        A+B : du walk once per write; COLD = first write, WARM = cached
 *        C   : counter; COLD = bootstrap recount, WARM = O(1)
 *
 * Run: node scripts/benchmark-quota-c.js [fileCount] [fileBytes]
 * (Put Git Bash du on PATH to use the real du path: add
 *  "C:\Program Files\Git\usr\bin" to PATH on Windows.)
 */
const { performance } = require('node:perf_hooks');
const fsSync = require('node:fs');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QuotaStrategy, FileSizeReporter } = require('@solid/community-server');
const { DuSizeReporter } = require('../dist/storage/size-reporter/DuSizeReporter.js');
const { FastQuotaStrategy } = require('../dist/storage/quota/FastQuotaStrategy.js');
const { QuotaCounter } = require('../dist/storage/quota/QuotaCounter.js');
const { IncrementalSizeReporter } = require('../dist/storage/quota/IncrementalSizeReporter.js');

const FILE_COUNT = Number(process.argv[2]) || 5000;
const FILE_BYTES = Number(process.argv[3]) || 1024;
const WRITE_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const IGNORE = [ '^/\\.internal$' ];

function makeMapper(root) {
  return {
    async mapUrlToFilePath(identifier) {
      const url = new URL(identifier.path);
      return { identifier, filePath: path.join(root, url.pathname), contentType: undefined, isMetadata: false };
    },
    async mapFilePathToUrl() { throw new Error('n/a'); },
  };
}

class OldStrategy extends QuotaStrategy {
  constructor(reporter, limit, pod) { super(reporter, limit); this.pod = pod; }
  async getTotalSpaceUsed() { return this.reporter.getSize(this.pod); }
}
class FastStrategy extends FastQuotaStrategy {
  constructor(reporter, limit, pod) { super(limit, reporter, {}, {}); this.pod = pod; }
  async getTotalSpaceUsed() { return this.reporter.getSize(this.pod); }
}

function seedPod(podRootPath, count, bytes) {
  const inbox = path.join(podRootPath, 'inbox');
  fsSync.mkdirSync(inbox, { recursive: true });
  const buf = Buffer.alloc(bytes, 7);
  for (let i = 0; i < count; i++) {
    fsSync.writeFileSync(path.join(inbox, `f-${i}.bin`), buf);
  }
}

function writeThroughGuard(guard, totalBytes, chunkBytes) {
  return new Promise((resolve, reject) => {
    guard.on('data', () => {});
    guard.on('end', resolve);
    guard.on('error', reject);
    let remaining = totalBytes;
    while (remaining > 0) {
      const size = Math.min(chunkBytes, remaining);
      guard.write(Buffer.alloc(size, 1));
      remaining -= size;
    }
    guard.end();
  });
}

async function timed(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

function pad(s, w) { return String(s).padStart(w); }

async function main() {
  const limit = { unit: 'bytes', amount: 10 * 1024 * 1024 * 1024 };
  const pod = { path: 'http://example.com/alice/' };
  const resource = { path: 'http://example.com/alice/new-file' };

  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'quota-c-'));
  console.log(`Pod: ${FILE_COUNT} files × ${FILE_BYTES} B  (write body ${WRITE_BYTES / 1024 / 1024} MB in ${CHUNK_BYTES / 1024} KB chunks)`);
  seedPod(path.join(root, 'alice'), FILE_COUNT, FILE_BYTES);
  const mapper = makeMapper(root);

  // ---- 1. WALK / read path ----
  console.log('\n1. WALK — getSize(podRoot):');
  const oldReporter = new FileSizeReporter(mapper, root);
  const duReporter = new DuSizeReporter(mapper, root, IGNORE);
  const counter = new QuotaCounter(mapper, root, IGNORE);

  const tOldWalk = await timed(() => oldReporter.getSize(pod));
  const tDuCold = await timed(() => duReporter.getSize(pod));
  const tDuWarm = await timed(() => duReporter.getSize(pod));
  await counter.register(pod);
  await counter.add(pod, (await new DuSizeReporter(mapper, root, IGNORE).getSize(pod)).amount);
  const incReporter = new IncrementalSizeReporter(counter);
  const tCounter = await timed(() => incReporter.getSize(pod));

  console.log(`   old (Node walk)          : ${pad(tOldWalk.toFixed(1), 8)} ms`);
  console.log(`   A+B du (cold walk)       : ${pad(tDuCold.toFixed(1), 8)} ms`);
  console.log(`   A+B du (cached)          : ${pad(tDuWarm.toFixed(3), 8)} ms`);
  console.log(`   C   counter (O(1))       : ${pad(tCounter.toFixed(3), 8)} ms`);

  // ---- 2. WRITE / guard ----
  console.log('\n2. WRITE — quota guard:');
  const chunks = Math.ceil(WRITE_BYTES / CHUNK_BYTES);

  // old — always cold (no cache), per-chunk walks.
  const oldStrategy = new OldStrategy(oldReporter, limit, pod);
  const tOld = await timed(async () => writeThroughGuard(await oldStrategy.createQuotaGuard(resource), WRITE_BYTES, CHUNK_BYTES));

  // A+B — cold (fresh reporter) then warm (pre-warmed cache).
  const duFastCold = new FastStrategy(new DuSizeReporter(mapper, root, IGNORE), limit, pod);
  const tDuColdWrite = await timed(async () => writeThroughGuard(await duFastCold.createQuotaGuard(resource), WRITE_BYTES, CHUNK_BYTES));
  // Warm: ensure the cache is warm, then measure.
  await duReporter.getSize(pod);
  const duFastWarm = new FastStrategy(duReporter, limit, pod);
  const tDuWarmWrite = await timed(async () => writeThroughGuard(await duFastWarm.createQuotaGuard(resource), WRITE_BYTES, CHUNK_BYTES));

  // C — cold (fresh counter, bootstrap recount) then warm (counter ready).
  const coldCounter = new QuotaCounter(mapper, root, IGNORE);
  const cCold = new FastStrategy(new IncrementalSizeReporter(coldCounter), limit, pod);
  const tCCold = await timed(async () => writeThroughGuard(await cCold.createQuotaGuard(resource), WRITE_BYTES, CHUNK_BYTES));
  const cWarm = new FastStrategy(incReporter, limit, pod);
  const tCWarm = await timed(async () => writeThroughGuard(await cWarm.createQuotaGuard(resource), WRITE_BYTES, CHUNK_BYTES));

  console.log(`   old  (per-chunk walks)   : ${pad(tOld.toFixed(1), 8)} ms  (${chunks} walks)`);
  console.log(`   A+B  cold (1 du walk)    : ${pad(tDuColdWrite.toFixed(1), 8)} ms`);
  console.log(`   A+B  warm (cached)       : ${pad(tDuWarmWrite.toFixed(3), 8)} ms`);
  console.log(`   C    cold (bootstrap)    : ${pad(tCCold.toFixed(1), 8)} ms`);
  console.log(`   C    warm (O(1))         : ${pad(tCWarm.toFixed(3), 8)} ms`);

  fsSync.rmSync(root, { recursive: true, force: true });
  console.log('\nNote: "old" has no cache (always cold). On Linux/WSL, du walks are 10-100x faster than on Windows+Git Bash.');
}

main().catch((e) => { console.error(e); process.exit(1); });
