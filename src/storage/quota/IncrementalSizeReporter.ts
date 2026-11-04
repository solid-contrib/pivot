import {
  UNIT_BYTES,
} from '@solid/community-server';
import type {
  RepresentationMetadata,
  ResourceIdentifier,
  Size,
  SizeReporter,
} from '@solid/community-server';
import type { QuotaCounter } from './QuotaCounter';

/**
 * {@link SizeReporter} backed by the incremental {@link QuotaCounter}.
 *
 * - `getSize(podRoot)` → **O(1)** counter read (recount only on bootstrap /
 *   staleness).
 * - `getSize(any other resource)` → single stat (used by
 *   `QuotaStrategy.getAvailableSpace` to subtract the overwritten resource).
 *
 * Replaces `urn:solid-server:default:SizeReporter` in design C. The apparent
 * byte unit is unchanged, so the 70 MB limit keeps its meaning.
 */
export class IncrementalSizeReporter implements SizeReporter<unknown> {
  private readonly counter: QuotaCounter;

  public constructor(counter: QuotaCounter) {
    this.counter = counter;
  }

  public getUnit(): string {
    return UNIT_BYTES;
  }

  public async getSize(identifier: ResourceIdentifier): Promise<Size> {
    if (await this.counter.isPodRoot(identifier)) {
      return this.counter.getSize(identifier);
    }
    return { unit: UNIT_BYTES, amount: await this.counter.sizeOfResource(identifier) };
  }

  /** The size of a chunk is simply its length in bytes. */
  public async calculateChunkSize(chunk: unknown): Promise<number> {
    return Buffer.isBuffer(chunk) ? chunk.length : Number((chunk as any)?.length) || 0;
  }

  /** The estimated size of a resource is simply the content-length header. */
  public async estimateSize(metadata: RepresentationMetadata): Promise<number | undefined> {
    return metadata.contentLength;
  }
}
