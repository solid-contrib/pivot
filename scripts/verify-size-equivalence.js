/**
 * Equivalence proof: DuSizeReporter vs CSS FileSizeReporter.
 *
 * Generates random pod trees and asserts both reporters return the EXACT same
 * apparent-byte total (same ignoreFolders), for the du path and the Node-walk
 * fallback. Exits non-zero on any mismatch.
 *
 * Run with GNU du on PATH to exercise the real du path, e.g. on Windows:
 *   $env:PATH = "C:\Program Files\Git\usr\bin;$env:PATH"
 *   node scripts/verify-size-equivalence.js [iterations] [maxFiles]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileSizeReporter } = require('@solid/community-server');
const { DuSizeReporter } = require('../dist/storage/size-reporter/DuSizeReporter.js');

const ITERATIONS = Number(process.argv[2]) || 10;
const MAX_FILES = Number(process.argv[3]) || 60;
const IGNORE = [ '^/\\.internal$' ];

class ForcedDu extends DuSizeReporter {
  async detectDu() { return 'gnu'; }
}
class ForcedNode extends DuSizeReporter {
  async detectDu() { return 'none'; }
}

function makeMapper(root) {
  return {
    async mapUrlToFilePath(identifier) {
      const url = new URL(identifier.path);
      return { identifier, filePath: path.join(root, url.pathname), contentType: undefined, isMetadata: false };
    },
    async mapFilePathToUrl() { throw new Error('n/a'); },
  };
}

// Random names for nested content. .internal is handled separately below:
// CSS only ever places .internal at the pod ROOT (temp files), where the
// anchored regex ^/\.internal$ and du's basename --exclude=.internal agree.
const SEGMENTS = [ 'a', 'b', 'c', 'd', 'e', 'inbox', 'public', 'private', 'settings' ];

function randomTree(root, maxFiles) {
  const files = [];
  const count = 1 + Math.floor(Math.random() * maxFiles);
  for (let i = 0; i < count; i++) {
    // 1-4 nested segments, each a subdirectory (mkdirp on write).
    const depth = 1 + Math.floor(Math.random() * 3);
    const segs = [];
    for (let d = 0; d < depth; d++) {
      segs.push(SEGMENTS[Math.floor(Math.random() * SEGMENTS.length)]);
    }
    const dir = path.join(root, ...segs);
    const file = path.join(dir, `f${i}.bin`);
    const size = Math.floor(Math.random() * 50_000);
    files.push({ dir, file, size });
  }
  return files;
}

function writeTree(root, files) {
  for (const { dir, file, size } of files) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(size, 42));
  }
  // Root-level .internal (excluded by both paths identically).
  fs.mkdirSync(path.join(root, '.internal', 'tempFiles'), { recursive: true });
  fs.writeFileSync(path.join(root, '.internal', 'tempFiles', 'tmp.bin'), Buffer.alloc(777, 9));
  // Some empty dirs too.
  fs.mkdirSync(path.join(root, 'empty-dir-1'), { recursive: true });
  fs.mkdirSync(path.join(root, 'a', 'empty-dir-2'), { recursive: true });
}

function assertEqual(label, a, b) {
  const same = a.amount === b.amount;
  console.log(`  ${same ? 'OK ' : 'FAIL'} ${label}: FileSizeReporter=${a.amount}  DuSizeReporter=${b.amount}${same ? '' : '  <-- MISMATCH'}`);
  return same;
}

let allOk = true;

async function main() {
  for (let iter = 1; iter <= ITERATIONS; iter++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-'));
    const files = randomTree(root, MAX_FILES);
    writeTree(root, files);

    const mapper = makeMapper(root);
    const oldReporter = new FileSizeReporter(mapper, root, IGNORE);
    const duReporter = new ForcedDu(mapper, root, IGNORE);
    const nodeReporter = new ForcedNode(mapper, root, IGNORE);
    const podId = { path: 'http://example.com/' };

    const oldSize = await oldReporter.getSize(podId);
    const duSize = await duReporter.getSize(podId);
    const nodeSize = await nodeReporter.getSize(podId);

    console.log(`Iteration ${iter} (${files.length} files):`);
    const okDu = assertEqual('du path    ', oldSize, duSize);
    const okNode = assertEqual('node fallback', oldSize, nodeSize);
    if (!okDu || !okNode) allOk = false;
    console.log('');

    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => {
  if (allOk) {
    console.log(`EQUIVALENT: DuSizeReporter matches FileSizeReporter across ${ITERATIONS} random trees.`);
    process.exit(0);
  } else {
    console.error('MISMATCH FOUND — sizes are NOT equivalent.');
    process.exit(1);
  }
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
