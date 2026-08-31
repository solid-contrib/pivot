import { ACCOUNT_TYPE } from '@solid/community-server';
import type { IndexedStorage } from '@solid/community-server';
import { SafeBaseLoginAccountStorage } from '../../../../../../src/identity/interaction/account/util/SafeBaseLoginAccountStorage';

jest.useFakeTimers();

describe('A SafeBaseLoginAccountStorage', (): void => {
  let source: jest.Mocked<IndexedStorage<any>>;
  let storage: SafeBaseLoginAccountStorage;

  beforeEach((): void => {
    source = {
      defineType: jest.fn().mockResolvedValue(undefined),
      createIndex: jest.fn().mockResolvedValue(undefined),
      has: jest.fn(),
      get: jest.fn(),
      create: jest.fn(async(_type, value): Promise<any> => ({ ...value, id: 'id' })),
      find: jest.fn(),
      findIds: jest.fn(),
      set: jest.fn(),
      setField: jest.fn(),
      delete: jest.fn(),
      entries: jest.fn(),
    };
    storage = new SafeBaseLoginAccountStorage(source, 1);
  });

  afterEach((): void => {
    jest.clearAllTimers();
  });

  it('deletes an abandoned account after the configured timeout.', async(): Promise<void> => {
    source.get.mockResolvedValueOnce({ id: 'id', linkedLoginsCount: 0 });

    await expect(storage.create(ACCOUNT_TYPE, {})).resolves.toEqual({ id: 'id' });
    await jest.advanceTimersByTimeAsync(1000);

    expect(source.delete).toHaveBeenCalledWith(ACCOUNT_TYPE, 'id');
  });

  it('contains storage errors raised by the cleanup timer.', async(): Promise<void> => {
    source.get.mockRejectedValueOnce(new Error('temporary lock failure'));

    await expect(storage.create(ACCOUNT_TYPE, {})).resolves.toEqual({ id: 'id' });
    await expect(jest.advanceTimersByTimeAsync(1000)).resolves.toBeUndefined();

    expect(source.delete).not.toHaveBeenCalled();
  });
});
