// Smoke test for design C against the compiled dist — replicates the jest
// scenarios that failed (mtime/sidecar handling + pod discovery).
// Run: node scripts/smoke-design-c.js
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SingleRootIdentifierStrategy } = require('@solid/community-server');
const { QuotaCounter } = require('../dist/storage/quota/QuotaCounter.js');
const { IncrementalSizeReporter } = require('../dist/storage/quota/IncrementalSizeReporter.js');
const { QuotaDeltaDataAccessor } = require('../dist/storage/quota/QuotaDeltaDataAccessor.js');
const { DuSizeReporter } = require('../dist/storage/size-reporter/DuSizeReporter.js');

const IGNORE = [ '^/\\.internal$' ];
const PIM_STORAGE = 'http://www.w3.org/ns/pim/space#Storage';

function createMapper(root) {
  return {
    async mapUrlToFilePath(identifier, isMetadata) {
      const url = new URL(identifier.path);
      const base = path.join(root, url.pathname);
      return { identifier, filePath: isMetadata ? `${base}.meta` : base, contentType: undefined, isMetadata };
    },
    async mapFilePathToUrl() { throw new Error('n/a'); },
  };
}

async function walkExpected(root, mapper, pod) {
  return (await new DuSizeReporter(mapper, root, IGNORE).getSize(pod)).amount;
}

function createAccessor(root) {
  const mapper = createMapper(root);
  const meta = (isStorage) => ({ getAll: () => (isStorage ? [ { value: PIM_STORAGE } ] : []) });
  return {
    async canHandle() {},
    async getData(id) { const { filePath } = await mapper.mapUrlToFilePath(id, false); return fs.createReadStream(filePath); },
    async getMetadata(id) { return meta(id.path.endsWith('/') && id.path !== 'http://example.com/'); },
    getChildren() { return (async function*() {})(); },
    async writeDocument(id, data) {
      const { filePath } = await mapper.mapUrlToFilePath(id, false);
      const chunks = [];
      for await (const c of data) chunks.push(Buffer.from(c));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, Buffer.concat(chunks));
    },
    async writeContainer(id) {
      const { filePath } = await mapper.mapUrlToFilePath(id, false);
      await fs.mkdir(filePath, { recursive: true });
    },
    async writeMetadata(id) {
      const { filePath } = await mapper.mapUrlToFilePath(id, true);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, '{}');
    },
    async deleteResource(id) {
      const data = await mapper.mapUrlToFilePath(id, false);
      const meta = await mapper.mapUrlToFilePath(id, true);
      await fs.rm(data.filePath, { recursive: true, force: true });
      await fs.rm(meta.filePath, { force: true });
    },
  };
}

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}: expected ${expected}, got ${actual}`);
  if (!ok) failures++;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-c-'));
  const mapper = createMapper(root);
  await fs.mkdir(path.join(root, 'alice'));

  // --- QuotaCounter ---
  console.log('QuotaCounter:');
  const counter = new QuotaCounter(mapper, root, IGNORE);
  const POD = { path: 'http://example.com/alice/' };
  await counter.register(POD);
  await counter.add(POD, 100);
  await counter.add(POD, 50);
  check('accumulate 100+50', (await counter.getSize(POD)).amount, 150);

  // persistence across instances
  const first = new QuotaCounter(mapper, root, IGNORE);
  await first.register(POD);
  await first.add(POD, 200);
  const second = new QuotaCounter(mapper, root, IGNORE);
  check('reload from sidecar (no re-walk)', (await second.getSize(POD)).amount, 200);

  // staleness
  await fs.writeFile(path.join(root, 'alice', 'extra.bin'), Buffer.alloc(400));
  const stale = await second.getSize(POD);
  check('staleness recount', stale.amount, await walkExpected(root, mapper, POD));

  // remove → re-bootstrap
  await second.remove(POD);
  check('isPodRoot false after remove', await second.isPodRoot(POD), false);
  check('re-bootstrap after remove', (await second.getSize(POD)).amount, await walkExpected(root, mapper, POD));

  // --- IncrementalSizeReporter ---
  console.log('IncrementalSizeReporter:');
  const counter2 = new QuotaCounter(mapper, root, IGNORE);
  await counter2.register(POD);
  await counter2.add(POD, 123);
  const reporter = new IncrementalSizeReporter(counter2);
  check('pod root → counter total', (await reporter.getSize(POD)).amount, 123);
  await fs.writeFile(path.join(root, 'alice', 'foo'), Buffer.alloc(64));
  check('resource → stat', (await reporter.getSize({ path: 'http://example.com/alice/foo' })).amount, 64);

  // --- QuotaDeltaDataAccessor ---
  console.log('QuotaDeltaDataAccessor (pod discovery + delta tracking):');
  const dRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-delta-'));
  const dMapper = createMapper(dRoot);
  const dCounter = new QuotaCounter(dMapper, dRoot, IGNORE);
  const dAccessor = new QuotaDeltaDataAccessor(
    createAccessor(dRoot),
    new SingleRootIdentifierStrategy('http://example.com/'),
    dCounter,
    dMapper,
  );
  const dPOD = { path: 'http://example.com/alice/' };
  const dRes = { path: 'http://example.com/alice/foo' };
  await dAccessor.writeContainer(dPOD, {});
  check('pod registered after createContainer', await dCounter.isPodRoot(dPOD), true);
  await dAccessor.writeDocument(dRes, (async function*() { yield Buffer.alloc(100); })(), {});
  check('after create doc(100) == walk', (await dCounter.getSize(dPOD)).amount, await walkExpected(dRoot, dMapper, dPOD));
  await dAccessor.writeDocument(dRes, (async function*() { yield Buffer.alloc(150); })(), {});
  check('after overwrite(150) == walk', (await dCounter.getSize(dPOD)).amount, await walkExpected(dRoot, dMapper, dPOD));
  await dAccessor.writeMetadata(dRes, {});
  check('after writeMetadata == walk', (await dCounter.getSize(dPOD)).amount, await walkExpected(dRoot, dMapper, dPOD));
  await dAccessor.deleteResource(dRes);
  check('after delete == walk', (await dCounter.getSize(dPOD)).amount, await walkExpected(dRoot, dMapper, dPOD));
  // pod root delete → counter dropped
  await dAccessor.writeContainer(dPOD, {});
  await dAccessor.deleteResource(dPOD);
  check('pod root delete drops counter', await dCounter.isPodRoot(dPOD), false);

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(dRoot, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
