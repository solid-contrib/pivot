import {
  getLoggerFor,
  InternalServerError,
  setSafeInterval,
} from '@solid/community-server';
import type {
  Expires,
  ExpiringStorage,
  Finalizable,
  KeyValueStorage,
} from '@solid/community-server';

/**
 * A storage that wraps around another storage and expires resources based on the given (optional)
 * expiry date, with the same behaviour as the default `WrappedExpiringStorage`, plus three
 * adjustments that make periodic expiration sweeps safe to run:
 *
 *  1. A random jitter is added to the sweep interval. The internal expiring storages (cookies,
 *     forgot-password, ownership tokens, OIDC adapter) are all created at startup, so without jitter
 *     their sweeps fire in the same instant and cause periodic latency spikes. The jitter spreads
 *     them out; it defaults to 0.15 (up to 15% of the timeout) and `0` disables it.
 *  2. Expired entries are deleted in bounded batches instead of one unbounded `Promise.all`, so a
 *     large number of expired entries cannot flood the event loop and the thread pool at once.
 *  3. The class is {@link Finalizable}: `finalize()` clears the sweep timer so a graceful shutdown
 *     does not leave the interval behind (the timer is also `unref`'d as a safety net).
 */
export class PivotExpiringStorage<TKey, TValue> implements ExpiringStorage<TKey, TValue>, Finalizable {
  protected readonly logger = getLoggerFor(this);
  private readonly source: KeyValueStorage<TKey, Expires<TValue>>;
  private readonly timer: NodeJS.Timeout;
  private readonly batchSize: number;

  /**
   * @param source - KeyValueStorage to actually store the data.
   * @param timeout - How often the expired data needs to be checked in minutes.
   * @param jitter - Maximum fraction of the timeout that is randomly added to the interval so that
   *                 multiple instances do not all sweep at the same time. `0` disables jitter.
   * @param batchSize - Maximum number of expired entries deleted concurrently.
   */
  public constructor(
    source: KeyValueStorage<TKey, Expires<TValue>>,
    timeout = 60,
    jitter = 0.15,
    batchSize = 32,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new TypeError('The expired-entry deletion batch size must be a positive integer.');
    }
    this.source = source;
    this.batchSize = batchSize;
    const period = timeout * 60 * 1000;
    const jitterMs = Math.floor(Math.random() * period * jitter);
    this.timer = setSafeInterval(
      this.logger,
      'Failed to remove expired entries',
      this.removeExpiredEntries.bind(this),
      period + jitterMs,
    );
    this.timer.unref();
  }

  public async get(key: TKey): Promise<TValue | undefined> {
    return this.getUnexpired(key);
  }

  public async has(key: TKey): Promise<boolean> {
    return Boolean(await this.getUnexpired(key));
  }

  public async set(key: TKey, value: TValue, expiration?: number): Promise<this>;
  public async set(key: TKey, value: TValue, expires?: Date): Promise<this>;
  public async set(key: TKey, value: TValue, expireValue?: number | Date): Promise<this> {
    const expires = typeof expireValue === 'number' ? new Date(Date.now() + expireValue) : expireValue;
    if (this.isExpired(expires)) {
      throw new InternalServerError('Value is already expired');
    }
    await this.source.set(key, this.toExpires(value, expires));
    return this;
  }

  public async delete(key: TKey): Promise<boolean> {
    return this.source.delete(key);
  }

  public async* entries(): AsyncIterableIterator<[TKey, TValue]> {
    // Not deleting expired entries here to prevent iterator issues
    for await (const [ key, value ] of this.source.entries()) {
      const { expires, payload } = this.toData(value);
      if (!this.isExpired(expires)) {
        yield [ key, payload ];
      }
    }
  }

  public async finalize(): Promise<void> {
    clearInterval(this.timer);
  }

  /**
   * Deletes all entries that have expired, in batches of `batchSize` concurrent deletes.
   */
  private async removeExpiredEntries(): Promise<void> {
    this.logger.debug('Removing expired entries');
    const expired: TKey[] = [];
    for await (const [ key, value ] of this.source.entries()) {
      const { expires } = this.toData(value);
      if (this.isExpired(expires)) {
        expired.push(key);
      }
    }
    for (let index = 0; index < expired.length; index += this.batchSize) {
      await Promise.all(expired.slice(index, index + this.batchSize)
        .map(async(key): Promise<boolean> => this.source.delete(key)));
    }
    this.logger.debug('Finished removing expired entries');
  }

  /**
   * Tries to get the data for the given key.
   * In case the data exists but has expired,
   * it will be deleted and `undefined` will be returned instead.
   */
  private async getUnexpired(key: TKey): Promise<TValue | undefined> {
    const data = await this.source.get(key);
    if (!data) {
      return;
    }
    const { expires, payload } = this.toData(data);
    if (this.isExpired(expires)) {
      await this.source.delete(key);
      return;
    }
    return payload;
  }

  /**
   * Checks if the given data entry has expired.
   */
  private isExpired(expires?: Date): boolean {
    return typeof expires !== 'undefined' && expires < new Date();
  }

  /**
   * Creates a new object where the `expires` field is a string instead of a Date.
   */
  private toExpires(data: TValue, expires?: Date): Expires<TValue> {
    return { expires: expires?.toISOString(), payload: data };
  }

  /**
   * Creates a new object where the `expires` field is a Date instead of a string.
   */
  private toData(expireData: Expires<TValue>): { expires?: Date; payload: TValue } {
    const result: { expires?: Date; payload: TValue } = { payload: expireData.payload };
    if (expireData.expires) {
      result.expires = new Date(expireData.expires);
    }
    return result;
  }
}
