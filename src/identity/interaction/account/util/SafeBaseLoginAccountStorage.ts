import {
  ACCOUNT_TYPE,
  BaseLoginAccountStorage,
  createErrorMessage,
  getLoggerFor,
} from '@solid/community-server';

const LOGIN_COUNT = 'linkedLoginsCount';

/**
 * A {@link BaseLoginAccountStorage} that prevents the periodic cleanup of accounts
 * without login methods from crashing the process when a lock timeout occurs.
 *
 * The storage is typed as `any` (and the class is not generic) because the
 * componentsjs-generator cannot resolve the `IndexedStorage`/`IndexTypeCollection`
 * generic types from the installed Community Solid Server `.d.ts` (TS2415-safe
 * `logger` is renamed to `safeLogger` for the same reason).
 */
export class SafeBaseLoginAccountStorage extends BaseLoginAccountStorage<any> {
  // Renamed (not `logger`) because the base class already declares a private `logger`,
  // which cannot be re-declared in a subclass (TS2415).
  private readonly safeLogger = getLoggerFor(this);

  private readonly timeout: number;

  public constructor(storage: any, expiration = 30 * 60) {
    super(storage, expiration);
    this.timeout = expiration * 1000;
  }

  protected createAccountTimeout(id: string): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const timer = setTimeout(async(): Promise<void> => {
      try {
        const account = await this.storage.get(ACCOUNT_TYPE, id);
        if (account && account[LOGIN_COUNT] === 0) {
          this.safeLogger.debug(`Removing account with no login methods ${id}`);
          await this.storage.delete(ACCOUNT_TYPE, id);
        }
      } catch (error: unknown) {
        // Prevent an unhandled rejection (e.g. a lock timeout) from crashing the process.
        this.safeLogger.error(`Error during account cleanup of ${id}: ${createErrorMessage(error)}`);
      }
    }, this.timeout);
    timer.unref();
  }
}
