import {
  ensureTrailingSlash,
  JsonResourceStorage,
  joinUrl,
} from '@solid/community-server';
import type { ResourceStore } from '@solid/community-server';

/**
 * A {@link JsonResourceStorage} that preserves root-relative key mapping while
 * restricting `entries()` to a smaller descendant container.
 *
 * This lets existing `ContainerPathStorage -> MaxKeyLengthStorage ->
 * JsonResourceStorage` chains retain their exact on-disk format while avoiding
 * a recursive walk of the entire internal storage tree during cleanup sweeps.
 */
export class ScopedJsonResourceStorage<T> extends JsonResourceStorage<T> {
  private readonly entryContainer: string;

  public constructor(source: ResourceStore, baseUrl: string, container: string, entryContainer: string) {
    super(source, baseUrl, container);
    this.entryContainer = ensureTrailingSlash(joinUrl(baseUrl, entryContainer));
    if (!this.entryContainer.startsWith(this.container)) {
      throw new TypeError('The entry container must be inside the storage container.');
    }
  }

  public async* entries(): AsyncIterableIterator<[string, T]> {
    yield* this.getResourceEntries({ path: this.entryContainer });
  }
}
