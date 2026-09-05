import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileIdentifierMapper, ResourceIdentifier } from '@solid/community-server';
import { QuotaCounter } from '../../../src/storage/quota/QuotaCounter';
import { DuSizeReporter } from '../../../src/storage/size-reporter/DuSizeReporter';

const IGNORE = [ '^/\\.internal$' ];

function createMapper(root: string): FileIdentifierMapper {
  return {
    async mapUrlToFilePath(identifier: ResourceIdentifier, isMetadata: boolean): Promise<any> {
      const url = new URL(identifier.path);
      const base = join(root, url.pathname);
      return {
        identifier,
        filePath: isMetadata ? `${base}.meta` : base,
        contentType: undefined,
        isMetadata,
      };
    },
    async mapFilePathToUrl(): Promise<any> {
      throw new Error('Not implemented');
    },
  };
}

// The same walk engine the counter uses for recounts.
async function expectedWalk(root: string, mapper: FileIdentifierMapper, pod: ResourceIdentifier): Promise<number> {
  return (await new DuSizeReporter(mapper, root, IGNORE).getSize(pod)).amount;
}

const POD = { path: 'http://example.com/alice/' };
const RESOURCE = { path: 'http://example.com/alice/foo' };

describe('A QuotaCounter', (): void => {
  let root: string;
  let mapper: FileIdentifierMapper;

  beforeEach(async(): Promise<void> => {
    root = await fs.mkdtemp(join(tmpdir(), 'quota-counter-'));
    await fs.mkdir(join(root, 'alice'));
    mapper = createMapper(root);
  });

  afterEach(async(): Promise<void> => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('accumulates deltas and returns the total (O(1)).', async(): Promise<void> => {
    const counter = new QuotaCounter(mapper, root, IGNORE);
    await counter.register(POD);
    await counter.add(POD, 100);
    await counter.add(POD, 50);
    await expect(counter.getSize(POD)).resolves.toEqual({ unit: 'bytes', amount: 150 });
  });

  it('bootstraps by walking when no counter or sidecar exists.', async(): Promise<void> => {
    await fs.writeFile(join(root, 'alice', 'a.txt'), Buffer.alloc(120));
    const counter = new QuotaCounter(mapper, root, IGNORE);
    const size = await counter.getSize(POD);
    expect(size.amount).toBe(await expectedWalk(root, mapper, POD));
    expect(size.amount).toBeGreaterThanOrEqual(120);
  });

  it('persists the sidecar and reloads it on a fresh instance (no re-walk).', async(): Promise<void> => {
    const first = new QuotaCounter(mapper, root, IGNORE);
    await first.register(POD);
    await first.add(POD, 200);
    // Fresh counter — same pod, sidecar matches mtime → loaded, no walk.
    const second = new QuotaCounter(mapper, root, IGNORE);
    await expect(second.getSize(POD)).resolves.toEqual({ unit: 'bytes', amount: 200 });
  });

  it('detects staleness (out-of-band change) and recounts.', async(): Promise<void> => {
    const counter = new QuotaCounter(mapper, root, IGNORE);
    await counter.register(POD);
    await counter.add(POD, 100);
    // Out-of-band change: a direct child appears in the pod root. Some filesystems
    // (e.g. NTFS mounted via WSL) have coarse directory mtime granularity, so the
    // new child may not bump the root mtime immediately; force it to a clearly
    // different value to make the staleness detection deterministic.
    await fs.writeFile(join(root, 'alice', 'extra.bin'), Buffer.alloc(400));
    const oldTime = new Date(2000, 0, 1);
    await fs.utimes(join(root, 'alice'), oldTime, oldTime);
    const size = await counter.getSize(POD);
    expect(size.amount).toBe(await expectedWalk(root, mapper, POD));
    expect(size.amount).toBeGreaterThanOrEqual(400);
  });

  it('returns the size of a single resource via stat.', async(): Promise<void> => {
    await fs.writeFile(join(root, 'alice', 'foo'), Buffer.alloc(77));
    const counter = new QuotaCounter(mapper, root, IGNORE);
    await expect(counter.sizeOfResource(RESOURCE)).resolves.toBe(77);
  });

  it('returns 0 for a missing resource.', async(): Promise<void> => {
    const counter = new QuotaCounter(mapper, root, IGNORE);
    await expect(counter.sizeOfResource(RESOURCE)).resolves.toBe(0);
  });

  it('drops the entry and sidecar on remove, then bootstraps again.', async(): Promise<void> => {
    const counter = new QuotaCounter(mapper, root, IGNORE);
    await counter.register(POD);
    await counter.add(POD, 100);
    await counter.remove(POD);
    expect(await counter.isPodRoot(POD)).toBe(false);
    // The sidecar is gone and the counter is dropped → next read re-walks.
    const size = await counter.getSize(POD);
    expect(size.amount).toBe(await expectedWalk(root, mapper, POD));
  });

  it('serializes concurrent adds with a per-pod lock.', async(): Promise<void> => {
    const counter = new QuotaCounter(mapper, root, IGNORE);
    await counter.register(POD);
    await Promise.all([ counter.add(POD, 10), counter.add(POD, 20), counter.add(POD, 30) ]);
    await expect(counter.getSize(POD)).resolves.toEqual({ unit: 'bytes', amount: 60 });
  });
});
