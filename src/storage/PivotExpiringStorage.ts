import {
  createErrorMessage,
  getLoggerFor,
  InternalServerError,
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
 *  1. A random jitter is added to every sweep delay. The internal expiring storages (cookies,
 *     forgot-password, ownership tokens, OIDC adapter) are all created at startup, so without
 *     jitter their sweeps would run in the same instant; the jitter spreads them out. It defaults
 *     to 0.15 (up to 15% of the timeout) and `0` disables it.
 *  2. Expired entries are deleted in bounded batches instead of one unbounded `Promise.all`, so a
 *     large number of expired entries cannot flood the event loop and the thread pool at once.
 *  3. The next sweep is scheduled only after the previous one has finished, so a cleanup that takes
 *     longer than the timeout cannot overlap with the next run. The timer is `unref`'d, a failing
 *     sweep is logged instead of rejecting, and `finalize()` clears the pending run.
 */
export class PivotExpiringStorage<TKey, TValue> implements ExpiringStorage<TKey, TValue>, Finalizable {
  protected readonly logger = getLoggerFor(this);
  private readonly source: KeyValueStorage<TKey, Expires<TValue>>;
  private readonly timeout: number;
  private readonly jitter: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private finalized = false;

  /**
   * @param source - KeyValueStorage to actually store the data.
   * @param timeout - How often the expired data needs to be checked in minutes.
   * @param jitter - Maximum fraction of the timeout that is randomly added before a sweep so that
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
    this.timeout = timeout;
    this.jitter = jitter;
    this.batchSize = batchSize;
    this.scheduleSweep();
  }

  public async get(key: TKey): Promise<TValue | undefined> {
    return this.getUnexpired(key);
  }

  public async has(key: TKey): Promise<boolean> {
    // Compare against `undefined` instead of coercing, so falsy payloads (`''`, `0`, `false`)
    // are reported as present, like `get` does.
    return (await this.getUnexpired(key)) !== undefined;
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
    this.finalized = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Schedules the next sweep. Every delay gets a random jitter so that storages created at the same
   * time do not sweep in the same instant.
   */
  private scheduleSweep(): void {
    const period = this.timeout * 60 * 1000;
    const jitterMs = Math.floor(Math.random() * period * this.jitter);
    const timer = setTimeout((): void => {
      void this.sweep();
    }, period + jitterMs);
    // A background sweep should never keep the Node.js process alive on its own.
    timer.unref();
    this.timer = timer;
  }

  /**
   * Runs one sweep and schedules the next one afterwards, so overlapping sweeps are impossible.
   * Errors are logged instead of thrown: the timer callback must never reject.
   */
  private async sweep(): Promise<void> {
    try {
      await this.removeExpiredEntries();
    } catch (error: unknown) {
      this.logger.error(`Failed to remove expired entries: ${createErrorMessage(error)}`);
    } finally {
      if (!this.finalized) {
        this.scheduleSweep();
      }
    }
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
