import {
  ACCOUNT_TYPE,
  BaseLoginAccountStorage,
  createErrorMessage,
  getLoggerFor,
} from '@solid/community-server';

const LOGIN_COUNT = 'linkedLoginsCount';

/**
 * A {@link BaseLoginAccountStorage} that prevents periodic cleanup failures
 * from becoming unhandled promise rejections that terminate the server.
 *
 * The storage is typed as `any` because componentsjs-generator cannot resolve
 * the generic IndexedStorage types from the installed CSS declarations.
 */
export class SafeBaseLoginAccountStorage extends BaseLoginAccountStorage<any> {
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
        this.safeLogger.error(`Error during account cleanup of ${id}: ${createErrorMessage(error)}`);
      }
    }, this.timeout);
    timer.unref();
  }
}
