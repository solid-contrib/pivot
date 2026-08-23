import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileIdentifierMapper, ResourceIdentifier, Size } from '@solid/community-server';
import { DuSizeReporter } from '../../../src/storage/size-reporter/DuSizeReporter';

// Force the du-based path (works even where du is absent — the Node walk
// produces the same apparent-byte sum for a simple tree).
class ForceDuReporter extends DuSizeReporter {
  protected override async detectDu(): Promise<'gnu' | 'bsd' | 'none'> {
    return 'gnu';
  }
}

// Force the Node-walk fallback path.
class ForceNodeReporter extends DuSizeReporter {
  protected override async detectDu(): Promise<'gnu' | 'bsd' | 'none'> {
    return 'none';
  }
}

function createMapper(root: string): FileIdentifierMapper {
  return {
    async mapUrlToFilePath(identifier: ResourceIdentifier): Promise<any> {
      const url = new URL(identifier.path);
      return { identifier, filePath: join(root, url.pathname), contentType: undefined, isMetadata: false };
    },
    async mapFilePathToUrl(): Promise<any> {
      throw new Error('Not implemented');
    },
  };
}

describe('A DuSizeReporter', (): void => {
  let root: string;
  let mapper: FileIdentifierMapper;

  beforeEach(async(): Promise<void> => {
    root = await fs.mkdtemp(join(tmpdir(), 'du-size-reporter-'));
    mapper = createMapper(root);
  });

  afterEach(async(): Promise<void> => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns the apparent size of a file.', async(): Promise<void> => {
    const reporter = new DuSizeReporter(mapper, root);
    await fs.writeFile(join(root, 'a.txt'), Buffer.alloc(100));
    const size = await reporter.getSize({ path: 'http://example.com/a.txt' });
    expect(size).toEqual({ unit: 'bytes', amount: 100 });
  });

  it('reports the same size whether du or the Node fallback is used.', async(): Promise<void> => {
    await fs.mkdir(join(root, 'dir'));
    await fs.writeFile(join(root, 'dir', 'a.txt'), Buffer.alloc(100));
    await fs.writeFile(join(root, 'dir', 'b.txt'), Buffer.alloc(50));
    const viaDu = await new ForceDuReporter(mapper, root).getSize({ path: 'http://example.com/dir/a.txt' });
    const viaNode = await new ForceNodeReporter(mapper, root).getSize({ path: 'http://example.com/dir/a.txt' });
    expect(viaDu.amount).toBe(100);
    expect(viaNode.amount).toBe(100);
  });

  it('serves a cached result within the TTL window without re-walking.', async(): Promise<void> => {
    const reporter = new ForceDuReporter(mapper, root, [], 60_000);
    await fs.writeFile(join(root, 'a.txt'), Buffer.alloc(100));
    const first = await reporter.getSize({ path: 'http://example.com/a.txt' });
    // Change the file without invalidating — the cache must still serve the old size.
    await fs.writeFile(join(root, 'a.txt'), Buffer.alloc(200));
    const cached = await reporter.getSize({ path: 'http://example.com/a.txt' });
    expect(first.amount).toBe(100);
    expect(cached.amount).toBe(100);
  });

  it('recomputes after invalidation.', async(): Promise<void> => {
    const reporter = new DuSizeReporter(mapper, root, [], 60_000);
    await fs.writeFile(join(root, 'a.txt'), Buffer.alloc(100));
    await reporter.getSize({ path: 'http://example.com/a.txt' });
    await fs.writeFile(join(root, 'a.txt'), Buffer.alloc(200));
    await reporter.invalidate({ path: 'http://example.com/a.txt' });
    const after = await reporter.getSize({ path: 'http://example.com/a.txt' });
    expect(after.amount).toBe(200);
  });

  it('invalidates ancestor entries (e.g. the pod root) as well.', async(): Promise<void> => {
    const reporter = new DuSizeReporter(mapper, root, [], 60_000);
    await fs.mkdir(join(root, 'dir'));
    await fs.writeFile(join(root, 'dir', 'a.txt'), Buffer.alloc(100));
    const rootSize = await reporter.getSize({ path: 'http://example.com/' });
    expect(rootSize.amount).toBeGreaterThanOrEqual(100);
    await fs.writeFile(join(root, 'dir', 'a.txt'), Buffer.alloc(300));
    await reporter.invalidate({ path: 'http://example.com/dir/a.txt' });
    const newRootSize = await reporter.getSize({ path: 'http://example.com/' });
    expect(newRootSize.amount).toBe(rootSize.amount + 200);
  });

  it('excludes the ignoreFolders from the total.', async(): Promise<void> => {
    const reporter = new DuSizeReporter(mapper, root, [ '^/\\.internal$' ]);
    await fs.mkdir(join(root, '.internal'));
    await fs.writeFile(join(root, '.internal', 'x.txt'), Buffer.alloc(1000));
    const without = await reporter.getSize({ path: 'http://example.com/' });
    // Adding a file inside .internal must not change the reported size.
    await fs.writeFile(join(root, '.internal', 'y.txt'), Buffer.alloc(1000));
    await reporter.invalidate({ path: 'http://example.com/' });
    const still = await reporter.getSize({ path: 'http://example.com/' });
    expect(still.amount).toBe(without.amount);
    // Adding a normal file must increase it.
    await fs.writeFile(join(root, 'a.txt'), Buffer.alloc(50));
    await reporter.invalidate({ path: 'http://example.com/' });
    const increased = await reporter.getSize({ path: 'http://example.com/' });
    expect(increased.amount).toBe(without.amount + 50);
  });

  it('returns the content-length as the estimated size.', async(): Promise<void> => {
    const reporter = new DuSizeReporter(mapper, root);
    await expect(reporter.estimateSize({ contentLength: 42 } as any)).resolves.toBe(42);
    await expect(reporter.estimateSize({} as any)).resolves.toBeUndefined();
  });

  it('calculates the chunk size as the buffer length.', async(): Promise<void> => {
    const reporter = new DuSizeReporter(mapper, root);
    await expect(reporter.calculateChunkSize(Buffer.alloc(17))).resolves.toBe(17);
  });

  it('returns the byte unit.', async(): Promise<void> => {
    const reporter = new DuSizeReporter(mapper, root);
    expect(reporter.getUnit()).toBe('bytes');
  });

  it('reports a size of 0 for a missing resource.', async(): Promise<void> => {
    const reporter = new DuSizeReporter(mapper, root);
    const size: Size = await reporter.getSize({ path: 'http://example.com/nope' });
    expect(size.amount).toBe(0);
  });
});
