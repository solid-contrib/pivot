import {
  AccountLoginStorage,
  BaseWebIdStore,
  WEBID_STORAGE_DESCRIPTION,
  WEBID_STORAGE_TYPE,
} from '@solid/community-server';

type WebIdStorage = AccountLoginStorage<{ [WEBID_STORAGE_TYPE]: typeof WEBID_STORAGE_DESCRIPTION }>;

/**
 * A {@link BaseWebIdStore} that also determines whether a WebID is registered
 * to any account on this server (`hasWebId`).
 *
 * The card guard needs to know whether a WebID is registered, which the
 * upstream WebIdStore does not expose (yet). This subclass keeps the full
 * upstream behavior and only adds the exact indexed lookup on the webId index.
 */
export class GuardedWebIdStore extends BaseWebIdStore {
  private readonly webIdStorage: WebIdStorage;

  // Loosely typed so the Components.js generator does not need to resolve the
  // external generic; Components.js does not type-check constructor arguments.
  public constructor(storage: any) {
    super(storage);
    this.webIdStorage = storage as unknown as WebIdStorage;
  }

  /**
   * Determines if the given WebID is registered to an account on this server.
   *
   * @param webId - WebID to check.
   */
  public async hasWebId(webId: string): Promise<boolean> {
    return (await this.webIdStorage.find(WEBID_STORAGE_TYPE, { webId })).length > 0;
  }
}
