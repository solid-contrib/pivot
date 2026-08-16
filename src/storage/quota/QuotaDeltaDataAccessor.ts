import { promises as fs } from 'node:fs';
import type { Readable } from 'node:stream';
import {
  NotFoundHttpError,
  PassthroughDataAccessor,
} from '@solid/community-server';
import type {
  DataAccessor,
  FileIdentifierMapper,
  IdentifierStrategy,
  RepresentationMetadata,
  ResourceIdentifier,
} from '@solid/community-server';
import type { Guarded } from '@solid/community-server';
import type { QuotaCounter } from './QuotaCounter';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PIM_STORAGE = 'http://www.w3.org/ns/pim/space#Storage';
const TYPE_TERM = { termType: 'NamedNode', value: RDF_TYPE };

/**
 * Delta hook for design C. Wraps the top of the file accessor chain and, for
 * every mutation, computes the resource's apparent-byte delta (before/after)
 * and feeds it to the {@link QuotaCounter}.
 *
 * Plugs into the existing chain untouched: this wrapper's `accessor` is the
 * original `FileDataAccessor` (FilterMetadata → Validating → Atomic), so the
 * quota validation and content-length filtering are preserved.
 *
 * Cases handled:
 * - create/overwrite document: Δ = new − old (data + metadata file)
 * - delete resource: Δ = −(data + metadata size)
 * - create/delete container: Δ from a walk (captures directory sizes)
 */
export class QuotaDeltaDataAccessor extends PassthroughDataAccessor {
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly counter: QuotaCounter;
  private readonly fileIdentifierMapper: FileIdentifierMapper;
  private readonly podCache: Map<string, ResourceIdentifier | null> = new Map();

  public constructor(
    accessor: DataAccessor,
    identifierStrategy: IdentifierStrategy,
    counter: QuotaCounter,
    fileIdentifierMapper: FileIdentifierMapper,
  ) {
    super(accessor);
    this.identifierStrategy = identifierStrategy;
    this.counter = counter;
    this.fileIdentifierMapper = fileIdentifierMapper;
  }

  /** CSS internal storage (locks, IDP adapter, ...) lives under `/.internal/`. */
  private isInternalPath(identifier: ResourceIdentifier): boolean {
    return identifier.path === '/.internal' || identifier.path.startsWith('/.internal/');
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    await this.track(identifier, (): Promise<void> => this.accessor.writeDocument(identifier, data, metadata));
  }

  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    await this.track(identifier, (): Promise<void> => this.accessor.writeContainer(identifier, metadata));
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    await this.track(identifier, (): Promise<void> => this.accessor.writeMetadata(identifier, metadata));
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    if (this.isInternalPath(identifier)) {
      await this.accessor.deleteResource(identifier);
      return;
    }
    const before = await this.sizeOf(identifier);
    await this.accessor.deleteResource(identifier);
    const after = await this.sizeOf(identifier);
    const delta = after - before;
    const pod = await this.findPod(identifier);
    if (pod === null) {
      return;
    }
    // Deleting the pod root itself → drop the counter entirely.
    if (pod.path === identifier.path) {
      await this.counter.remove(identifier);
      return;
    }
    if (delta !== 0) {
      await this.counter.register(pod);
      await this.counter.add(pod, delta);
    }
  }

  // --- Delta tracking ---

  private async track(identifier: ResourceIdentifier, op: () => Promise<void>): Promise<void> {
    // Skip the delta bookkeeping on CSS internal paths: the stat + pod-discovery
    // walk + counter sidecar work can otherwise push internal writes (e.g. IDP
    // authorization codes) past the WrappedExpiringReadWriteLocker's lock expiry.
    if (this.isInternalPath(identifier)) {
      await op();
      return;
    }
    const before = await this.sizeOf(identifier);
    await op();
    const after = await this.sizeOf(identifier);
    const pod = await this.findPod(identifier);
    if (pod === null) {
      return;
    }
    // Always register the pod so the reporter routes its reads to the counter
    // (even when this particular write has a zero delta, e.g. an empty
    // container on a filesystem that reports directory size 0).
    await this.counter.register(pod);
    const delta = after - before;
    if (delta !== 0) {
      await this.counter.add(pod, delta);
    }
  }

  /** Apparent size of the resource: data file + metadata file (+ walk for containers). */
  private async sizeOf(identifier: ResourceIdentifier): Promise<number> {
    const data = await this.stat(identifier, false);
    const meta = await this.stat(identifier, true);
    return data + meta;
  }

  private async stat(identifier: ResourceIdentifier, isMetadata: boolean): Promise<number> {
    try {
      const { filePath } = await this.fileIdentifierMapper.mapUrlToFilePath(identifier, isMetadata);
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        return this.counter.walk(identifier);
      }
      return stat.size;
    } catch {
      return 0;
    }
  }

  // --- Pod discovery (mirrors PodQuotaStrategy.searchPimStorage) ---

  private async findPod(identifier: ResourceIdentifier): Promise<ResourceIdentifier | null> {
    const path = await this.counter.mapDataPath(identifier);
    const cached = this.podCache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const pod = await this.discoverPod(identifier);
    this.podCache.set(path, pod);
    return pod;
  }

  private async discoverPod(identifier: ResourceIdentifier): Promise<ResourceIdentifier | null> {
    if (this.identifierStrategy.isRootContainer(identifier)) {
      return null;
    }
    let metadata;
    try {
      metadata = await this.accessor.getMetadata(identifier);
    } catch (error: unknown) {
      if (NotFoundHttpError.isInstance(error)) {
        return this.discoverPod(this.identifierStrategy.getParentContainer(identifier));
      }
      throw error;
    }
    const hasPimStorage = metadata.getAll(TYPE_TERM as any)
      .some((term): boolean => term.value === PIM_STORAGE);
    if (hasPimStorage) {
      return identifier;
    }
    return this.discoverPod(this.identifierStrategy.getParentContainer(identifier));
  }
}
