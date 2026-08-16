import { PassThrough } from 'node:stream';
import {
  PodQuotaStrategy,
  guardStream,
} from '@solid/community-server';
// PayloadHttpError is not exported from the package root; deep import is
// needed to surface a 413 (Payload Too Large) on quota breaches.
import { PayloadHttpError } from '@solid/community-server/dist/util/errors/PayloadHttpError';
import type { Guarded } from '@solid/community-server';
import type { DataAccessor } from '@solid/community-server';
import type { IdentifierStrategy } from '@solid/community-server';
import type { ResourceIdentifier } from '@solid/community-server';
import type { Size } from '@solid/community-server';
import type { SizeReporter } from '@solid/community-server';
import type { DuSizeReporter } from '../size-reporter/DuSizeReporter';
import { isInternalPath } from './InternalPath';

/**
 * Pod quota strategy that avoids the per-chunk full pod walk.
 *
 * CSS's default `QuotaStrategy.createQuotaGuard` calls `getAvailableSpace`
 * (which performs a full pod walk) for EVERY stream chunk — `chunks × O(N)`.
 * This override computes the available space ONCE before streaming, then only
 * tracks the current write's own byte delta per chunk. When the write
 * completes, the reporter's size cache is invalidated so the QuotaValidator's
 * post-write check (and the next write's pre-check) re-walk fresh.
 */
export class FastQuotaStrategy extends PodQuotaStrategy {
  public constructor(
    limit: Size,
    reporter: SizeReporter<unknown>,
    identifierStrategy: IdentifierStrategy,
    accessor: DataAccessor,
  ) {
    super(limit, reporter, identifierStrategy, accessor);
  }

  /**
   * Exempt CSS internal paths from quota checks. The QuotaValidator calls
   * `getAvailableSpace` before AND after every write (and `createQuotaGuard`
   * mid-stream); for `/.internal/*` writes (e.g. the IDP AuthorizationCode
   * store) the inherited pod-discovery + size walk could take longer than the
   * `WrappedExpiringReadWriteLocker` 6s expiry. Returning unlimited here
   * short-circuits the validator without any pod walk.
   */
  public override async getAvailableSpace(identifier: ResourceIdentifier): Promise<Size> {
    if (isInternalPath(identifier)) {
      return { amount: Number.MAX_SAFE_INTEGER, unit: 'bytes' };
    }
    return super.getAvailableSpace(identifier);
  }

  public async createQuotaGuard(identifier: ResourceIdentifier): Promise<Guarded<PassThrough>> {
    // Compute the available space ONCE. getAvailableSpace already subtracts
    // the overwritten resource's own size, and nothing else about the pod
    // changes mid-write (atomic writes go to /.internal/, excluded by the
    // reporter), so this single value is safe for the whole stream.
    const availableSpace = await this.getAvailableSpace(identifier);
    const reporter = this.reporter as DuSizeReporter & SizeReporter<unknown>;
    let total = 0;

    return guardStream(new PassThrough({
      async transform(chunk: any, _encoding: string, done: () => void): Promise<void> {
        total += await reporter.calculateChunkSize(chunk);
        if (availableSpace.amount < total) {
          this.destroy(new PayloadHttpError(
            `Quota exceeded by ${total - availableSpace.amount} ${availableSpace.unit} during write`,
          ));
        }
        this.push(chunk);
        done();
      },
      async flush(done: (error?: Error) => void): Promise<void> {
        // Drop the cached sizes (resource + its ancestors incl. the pod root)
        // so the QuotaValidator's after-write check re-walks and sees the new
        // state. Best-effort: a failure to invalidate must not fail the write.
        if (typeof reporter.invalidate === 'function') {
          try {
            await reporter.invalidate(identifier);
          } catch {
            // Ignore cache invalidation errors.
          }
        }
        done();
      },
    }));
  }
}
