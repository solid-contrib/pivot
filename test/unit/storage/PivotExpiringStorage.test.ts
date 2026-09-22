import type { Expires, KeyValueStorage } from '@solid/community-server';
import { InternalServerError } from '@solid/community-server';
import { PivotExpiringStorage } from '../../../src/storage/PivotExpiringStorage';
import { flushPromises } from '../../util/Util';

type Internal = Expires<string>;

function createExpires(payload: string, expires?: Date): Internal {
  return { payload, expires: expires?.toISOString() };
}

describe('A PivotExpiringStorage', (): void => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  let source: jest.Mocked<KeyValueStorage<string, Internal>>;
  let storage: PivotExpiringStorage<string, string>;
  let mockInterval: jest.SpyInstance;
  let mockClear: jest.SpyInstance;
  let mockRandom: jest.SpyInstance;
  let mockTimer: { unref: jest.Mock };

  beforeEach((): void => {
    // Never schedule a real sweep; capture the interval instead.
    mockTimer = { unref: jest.fn() };
    mockInterval = jest.spyOn(globalThis, 'setInterval')
      .mockImplementation(jest.fn().mockReturnValue(mockTimer) as any);
    mockClear = jest.spyOn(globalThis, 'clearInterval').mockImplementation(jest.fn() as any);
    // Fixed jitter source so the scheduled delay is deterministic.
    mockRandom = jest.spyOn(globalThis.Math, 'random').mockReturnValue(0.5);

    source = {
      get: jest.fn(),
      has: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      entries: jest.fn(),
    };
    storage = new PivotExpiringStorage(source, 1, 0);
  });

  afterEach((): void => {
    mockInterval.mockRestore();
    mockClear.mockRestore();
    mockRandom.mockRestore();
  });

  it('does not return data if there is no result.', async(): Promise<void> => {
    await expect(storage.get('key')).resolves.toBeUndefined();
    expect(source.get).toHaveBeenCalledTimes(1);
    expect(source.get).toHaveBeenLastCalledWith('key');
  });

  it('returns data if it has not expired.', async(): Promise<void> => {
    source.get.mockResolvedValueOnce(createExpires('data!', tomorrow));
    await expect(storage.get('key')).resolves.toBe('data!');
  });

  it('deletes expired data when trying to get it.', async(): Promise<void> => {
    source.get.mockResolvedValueOnce(createExpires('data!', yesterday));
    await expect(storage.get('key')).resolves.toBeUndefined();
    expect(source.delete).toHaveBeenCalledTimes(1);
    expect(source.delete).toHaveBeenLastCalledWith('key');
  });

  it('returns false on `has` checks if there is no data.', async(): Promise<void> => {
    await expect(storage.has('key')).resolves.toBe(false);
    expect(source.get).toHaveBeenCalledTimes(1);
    expect(source.get).toHaveBeenLastCalledWith('key');
  });

  it('true on `has` checks if there is non-expired data.', async(): Promise<void> => {
    source.get.mockResolvedValueOnce(createExpires('data!', tomorrow));
    await expect(storage.has('key')).resolves.toBe(true);
  });

  it('deletes expired data when checking if it exists.', async(): Promise<void> => {
    source.get.mockResolvedValueOnce(createExpires('data!', yesterday));
    await expect(storage.has('key')).resolves.toBe(false);
    expect(source.delete).toHaveBeenCalledTimes(1);
    expect(source.delete).toHaveBeenLastCalledWith('key');
  });

  it('converts the expiry date to a string when storing data.', async(): Promise<void> => {
    await storage.set('key', 'data!', tomorrow);
    expect(source.set).toHaveBeenCalledTimes(1);
    expect(source.set).toHaveBeenLastCalledWith('key', createExpires('data!', tomorrow));
  });

  it('can store data with an expiration duration.', async(): Promise<void> => {
    await storage.set('key', 'data!', tomorrow.getTime() - Date.now());
    expect(source.set).toHaveBeenCalledTimes(1);
    expect(source.set).toHaveBeenLastCalledWith('key', createExpires('data!', tomorrow));
  });

  it('can store data without expiry date.', async(): Promise<void> => {
    await storage.set('key', 'data!');
    expect(source.set).toHaveBeenCalledTimes(1);
    expect(source.set).toHaveBeenLastCalledWith('key', createExpires('data!'));
  });

  it('errors when trying to store expired data.', async(): Promise<void> => {
    await expect(storage.set('key', 'data!', yesterday)).rejects.toThrow(InternalServerError);
  });

  it('directly calls delete on the source when deleting.', async(): Promise<void> => {
    await expect(storage.delete('key')).resolves.toBeUndefined();
    expect(source.delete).toHaveBeenCalledTimes(1);
    expect(source.delete).toHaveBeenLastCalledWith('key');
  });

  it('only iterates over non-expired entries.', async(): Promise<void> => {
    const data = [
      [ 'key1', createExpires('data1', tomorrow) ],
      [ 'key2', createExpires('data2', yesterday) ],
      [ 'key3', createExpires('data3') ],
    ];
    source.entries.mockImplementationOnce(function* (): any {
      yield* data;
    });
    const it = storage.entries();
    await expect(it.next()).resolves.toEqual(
      expect.objectContaining({ value: [ 'key1', 'data1' ]}),
    );
    await expect(it.next()).resolves.toEqual(
      expect.objectContaining({ value: [ 'key3', 'data3' ]}),
    );
  });

  describe('scheduling the cleanup sweep', (): void => {
    it('schedules the sweep on the configured timeout when jitter is disabled.', (): void => {
      storage = new PivotExpiringStorage(source, 1, 0);
      expect(mockInterval).toHaveBeenCalledTimes(2);
      expect(mockInterval.mock.calls[1]).toHaveLength(2);
      expect(mockInterval.mock.calls[1][1]).toBe(60 * 1000);
    });

    it('adds a jitter fraction to the scheduled sweep interval.', (): void => {
      // Math.random is 0.5 and jitter is 0.2, so floor(0.5 * 60000 * 0.2) = 6000 is added.
      storage = new PivotExpiringStorage(source, 1, 0.2);
      expect(mockInterval).toHaveBeenCalledTimes(2);
      expect(mockInterval.mock.calls[1][1]).toBe(60 * 1000 + 6000);
    });

    it('unrefs the timer so it does not keep the event loop alive.', (): void => {
      expect(mockTimer.unref).toHaveBeenCalledTimes(1);
    });

    it('removes expired entries when the scheduled sweep fires.', async(): Promise<void> => {
      const data = [
        [ 'key1', createExpires('data1', tomorrow) ],
        [ 'key2', createExpires('data2', yesterday) ],
        [ 'key3', createExpires('data3') ],
      ];
      source.entries.mockImplementationOnce(function* (): any {
        yield* data;
      });

      // Await the function the sweep interval was created with.
      await (mockInterval.mock.calls[0][0] as () => Promise<void>)();

      expect(source.delete).toHaveBeenCalledTimes(1);
      expect(source.delete).toHaveBeenLastCalledWith('key2');
    });

    it('deletes expired entries in bounded batches.', async(): Promise<void> => {
      storage = new PivotExpiringStorage(source, 1, 0, 2);
      let resolveFirst!: (value: boolean) => void;
      let resolveSecond!: (value: boolean) => void;
      const first = new Promise<boolean>((resolve): void => {
        resolveFirst = resolve;
      });
      const second = new Promise<boolean>((resolve): void => {
        resolveSecond = resolve;
      });
      source.entries.mockImplementationOnce(function* (): any {
        yield [ 'key1', createExpires('data1', yesterday) ];
        yield [ 'key2', createExpires('data2', yesterday) ];
        yield [ 'key3', createExpires('data3', yesterday) ];
      });
      source.delete.mockImplementationOnce(async(): Promise<boolean> => first)
        .mockImplementationOnce(async(): Promise<boolean> => second)
        .mockResolvedValue(true);

      const cleanup = (mockInterval.mock.calls[1][0] as () => Promise<void>)();
      await flushPromises();
      expect(source.delete).toHaveBeenCalledTimes(2);

      resolveFirst(true);
      resolveSecond(true);
      await cleanup;
      expect(source.delete).toHaveBeenCalledTimes(3);
    });

    it.each([ 0, -1, 1.5, Number.NaN ])('rejects invalid batch size %p.', (batchSize): void => {
      expect((): PivotExpiringStorage<string, string> =>
        new PivotExpiringStorage(source, 1, 0, batchSize)).toThrow(TypeError);
    });

    it('clears the timer on finalize.', async(): Promise<void> => {
      await expect(storage.finalize()).resolves.toBeUndefined();
      expect(mockClear).toHaveBeenCalledTimes(1);
      expect(mockClear).toHaveBeenLastCalledWith(mockTimer);
    });
  });
});
