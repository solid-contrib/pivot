/**
 * Benchmark: CSS pod-quota chain — old (FileSizeReporter + QuotaStrategy)
 * vs pivot (DuSizeReporter + FastQuotaStrategy).
 *
 * Measures exactly what was optimized:
 *   1. Full pod walk cost (old recursive Node walk vs du walk)
 *   2. The per-write quota guard (old: full walk PER CHUNK; new: walk once)
 *   3. The TTL cache effect on repeated size queries
 *
 * Run: node scripts/benchmark-quota.js [fileCount] [fileBytes]
 *   e.g. node scripts/benchmark-quota.js 10000 1024
 *
 * NOTE: on bare Windows there is no `du`, so the walk times will be similar
 * between the two (the guard + cache wins still show). On Linux/WSL the du
 * walk is 10-100x faster.
 */
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const {
  FileSizeReporter,
  QuotaStrategy,
} = require('@solid/community-server');
const { DuSizeReporter } = require('../dist/storage/size-reporter/DuSizeReporter.js');
const { FastQuotaStrategy } = require('../dist/storage/quota/FastQuotaStrategy.js');

const FILE_COUNT = Number(process.argv[2]) || 5000;
const FILE_BYTES = Number(process.argv[3]) || 1024;
const WRITE_BYTES = 4 * 1024 * 1024; // simulated write body
const CHUNK_BYTES = 64 * 1024;

function makeMapper(root) {
  return {
    async mapUrlToFilePath(identifier) {
      const url = new URL(identifier.path);
      return { identifier, filePath: path.join(root, url.pathname), contentType: undefined, isMetadata: false };
    },
    async mapFilePathToUrl() { throw new Error('n/a'); },
  };
}

// Old strategy: base QuotaStrategy whose pod size = reporter.getSize(podRoot)
class OldBenchStrategy extends QuotaStrategy {
  constructor(reporter, limit, podRoot) {
    super(reporter, limit);
    this.podRoot = podRoot;
  }
  async getTotalSpaceUsed() {
    return this.reporter.getSize(this.podRoot);
  }
}

// New strategy: FastQuotaStrategy with the same pod-size hook
class NewBenchStrategy extends FastQuotaStrategy {
  constructor(reporter, limit, podRoot) {
    super(limit, reporter, {}, {});
    this.podRoot = podRoot;
  }
  async getTotalSpaceUsed() {
    return this.reporter.getSize(this.podRoot);
  }
}

function seedPod(root, count, bytes) {
  const inbox = path.join(root, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const buf = Buffer.alloc(bytes, 7);
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(inbox, `file-${i}.bin`), buf);
  }
}

function writeThroughGuard(guard, totalBytes, chunkBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let remaining = totalBytes;
    guard.on('data', () => {});
    guard.on('end', () => resolve(chunks));
    guard.on('error', reject);
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

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-bench-'));
  const podRoot = { path: 'http://example.com/' };
  const limit = { unit: 'bytes', amount: 10 * 1024 * 1024 * 1024 };

  console.log(`Seeding ${FILE_COUNT} files × ${FILE_BYTES} B in ${root} …`);
  const seedStart = performance.now();
  seedPod(root, FILE_COUNT, FILE_BYTES);
  console.log(`  seeded in ${(performance.now() - seedStart).toFixed(0)} ms\n`);

  const mapper = makeMapper(root);
  const reporterOld = new FileSizeReporter(mapper, root);
  const reporterNew = new DuSizeReporter(mapper, root, [ '^/\\.internal$' ]);

  // --- 1. Full pod walk (single getSize) ---
  const walkOld = await timed(() => reporterOld.getSize(podRoot));
  const walkNew = await timed(() => reporterNew.getSize(podRoot));
  const walkCached = await timed(() => reporterNew.getSize(podRoot));

  console.log('1. FULL POD WALK (getSize of pod root)');
  console.log(`   old (Node recursive walk): ${walkOld.toFixed(1)} ms`);
  console.log(`   new (du, first call):       ${walkNew.toFixed(1)} ms`);
  console.log(`   new (du, cached, TTL hit):  ${walkCached.toFixed(3)} ms`);
  if (walkNew > 0) {
    console.log(`   walk speedup (first call):  ${(walkOld / walkNew).toFixed(1)}×`);
  }

  // --- 2. Per-write guard (write body through the quota guard) ---
  const strategyOld = new OldBenchStrategy(reporterOld, limit, podRoot);
  const strategyNew = new NewBenchStrategy(reporterNew, limit, podRoot);

  const guardOld = await strategyOld.createQuotaGuard({ path: 'http://example.com/inbox/file-new.bin' });
  const guardNew = await strategyNew.createQuotaGuard({ path: 'http://example.com/inbox/file-new.bin' });

  const guardOldMs = await timed(() => writeThroughGuard(guardOld, WRITE_BYTES, CHUNK_BYTES));
  const guardNewMs = await timed(() => writeThroughGuard(guardNew, WRITE_BYTES, CHUNK_BYTES));

  console.log(`\n2. PER-WRITE QUOTA GUARD (${(WRITE_BYTES / 1024 / 1024).toFixed(0)} MB body, ${CHUNK_BYTES / 1024} KB chunks)`);
  console.log(`   old (walk per chunk, ${Math.ceil(WRITE_BYTES / CHUNK_BYTES)} chunks): ${guardOldMs.toFixed(1)} ms`);
  console.log(`   new (walk once + cache):           ${guardNewMs.toFixed(1)} ms`);
  if (guardNewMs > 0) {
    console.log(`   guard speedup:                     ${(guardOldMs / guardNewMs).toFixed(1)}×`);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
