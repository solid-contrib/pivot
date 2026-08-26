import { PassThrough } from 'node:stream';
import type {
  DataAccessor,
  IdentifierStrategy,
  ResourceIdentifier,
  Size,
  SizeReporter,
} from '@solid/community-server';
import { FastQuotaStrategy } from '../../../src/storage/quota/FastQuotaStrategy';

// A strategy with a fixed pod total so createQuotaGuard can be exercised
// without a real pod/accessor setup.
class FixedTotalStrategy extends FastQuotaStrategy {
  private readonly used: number;
  public constructor(used: number, limit: Size, reporter: SizeReporter<unknown>) {
    super(limit, reporter, {} as IdentifierStrategy, {} as DataAccessor);
    this.used = used;
  }

  protected async getTotalSpaceUsed(): Promise<Size> {
    return { unit: 'bytes', amount: this.used };
  }
}

function mockReporter(oldResourceSize: number): jest.Mocked<SizeReporter<unknown>> & { invalidate: jest.Mock } {
  const reporter: any = {
    getUnit: jest.fn((): string => 'bytes'),
    getSize: jest.fn(async(): Promise<Size> => ({ unit: 'bytes', amount: oldResourceSize })),
    calculateChunkSize: jest.fn(async(chunk: Buffer): Promise<number> => chunk.length),
    estimateSize: jest.fn(async(): Promise<number | undefined> => undefined),
    invalidate: jest.fn(async(): Promise<void> => undefined),
  };
  return reporter;
}

// Writes all chunks into the guard and waits for it to end (or error).
function writeChunks(guard: PassThrough, chunks: Buffer[]): Promise<void> {
  return new Promise((resolve, reject): void => {
    guard.on('data', (): void => {
      // consume
    });
    guard.on('end', resolve);
    guard.on('error', reject);
    for (const chunk of chunks) {
      guard.write(chunk);
    }
    guard.end();
  });
}

describe('A FastQuotaStrategy', (): void => {
  const identifier: ResourceIdentifier = { path: 'http://example.com/foo' };
  // available space = limit - pod total + overwritten resource size
  //                  = 100 - 90 + 10 = 20 bytes
  const limit: Size = { unit: 'bytes', amount: 100 };

  it('calls getAvailableSpace (the pod walk) only once per write, not per chunk.', async(): Promise<void> => {
    const reporter = mockReporter(10);
    const strategy = new FixedTotalStrategy(90, limit, reporter);
    const guard = await strategy.createQuotaGuard(identifier);
    // Two 5-byte chunks → 10 bytes total, under the 20-byte budget.
    await writeChunks(guard, [ Buffer.alloc(5), Buffer.alloc(5) ]);
    // getSize is called once by getAvailableSpace (for the overwritten
    // resource) and must NOT be called again per chunk.
    expect(reporter.getSize).toHaveBeenCalledTimes(1);
  });

  it('passes chunks through while the write stays under the available space.', async(): Promise<void> => {
    const reporter = mockReporter(10);
    const strategy = new FixedTotalStrategy(90, limit, reporter);
    const guard = await strategy.createQuotaGuard(identifier);
    const received: Buffer[] = [];
    guard.on('data', (chunk: Buffer): void => {
      received.push(chunk);
    });
    await writeChunks(guard, [ Buffer.alloc(5), Buffer.alloc(10) ]);
    expect(received.reduce((sum, chunk): number => sum + chunk.length, 0)).toBe(15);
  });

  it('errors when the write exceeds the available space.', async(): Promise<void> => {
    const reporter = mockReporter(10);
    const strategy = new FixedTotalStrategy(90, limit, reporter);
    const guard = await strategy.createQuotaGuard(identifier);
    // 25 bytes > 20 available.
    await expect(writeChunks(guard, [ Buffer.alloc(25) ])).rejects.toThrow(/Quota exceeded/);
  });

  it('invalidates the reporter cache when the write completes.', async(): Promise<void> => {
    const reporter = mockReporter(10);
    const strategy = new FixedTotalStrategy(90, limit, reporter);
    const guard = await strategy.createQuotaGuard(identifier);
    await writeChunks(guard, [ Buffer.alloc(5) ]);
    expect(reporter.invalidate).toHaveBeenCalledTimes(1);
    expect(reporter.invalidate).toHaveBeenLastCalledWith(identifier);
  });

  it('does not fail the write when cache invalidation fails.', async(): Promise<void> => {
    const reporter = mockReporter(10);
    reporter.invalidate.mockRejectedValue(new Error('mapping failed'));
    const strategy = new FixedTotalStrategy(90, limit, reporter);
    const guard = await strategy.createQuotaGuard(identifier);
    await expect(writeChunks(guard, [ Buffer.alloc(5) ])).resolves.toBeUndefined();
  });

  it('never errors when the quota does not apply (infinite space).', async(): Promise<void> => {
    const reporter = mockReporter(0);
    const strategy = new FixedTotalStrategy(Number.MAX_SAFE_INTEGER, limit, reporter);
    const guard = await strategy.createQuotaGuard(identifier);
    await expect(writeChunks(guard, [ Buffer.alloc(10_000) ])).resolves.toBeUndefined();
  });
});
