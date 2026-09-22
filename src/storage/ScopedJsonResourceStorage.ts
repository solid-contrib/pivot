import {
  ensureTrailingSlash,
  JsonResourceStorage,
  joinUrl,
} from '@solid/community-server';
import type { ResourceStore } from '@solid/community-server';

/**
 * A {@link JsonResourceStorage} that preserves the root-relative key mapping of its parent class
 * while restricting `entries()` to a smaller descendant container.
 *
 * This exists for cleanup sweeps: the internal expiring storages are chained as
 * `ContainerPathStorage -> MaxKeyLengthStorage -> JsonResourceStorage`, and the `entries()` call of a
 * sweep delegates all the way down to {@link JsonResourceStorage.entries}, which recursively walks
 * **every** document in `/.internal/` before the outer wrappers filter the keys by prefix.
 * With many accounts that walk dominates the server's CPU cost (it re-reads the whole internal tree
 * on every sweep).
 *
 * Replacing the bottom storage with this class keeps the key mapping, the key hashing and the
 * on-disk layout exactly the same, but starts the enumeration at `entryContainer` instead of the
 * storage root, so a sweep only reads its own subtree.
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
