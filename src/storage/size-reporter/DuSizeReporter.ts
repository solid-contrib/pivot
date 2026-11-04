import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { promisify } from 'node:util';
import {
  UNIT_BYTES,
  joinFilePath,
  normalizeFilePath,
  trimTrailingSlashes,
} from '@solid/community-server';
import type {
  FileIdentifierMapper,
  RepresentationMetadata,
  ResourceIdentifier,
  Size,
  SizeReporter,
} from '@solid/community-server';

const execFileAsync = promisify(execFile);

// Cache entry: computed size + expiry timestamp
interface CacheEntry {
  size: number;
  expiresAt: number;
}

/**
 * A {@link SizeReporter} that measures a resource (and its children) in
 * apparent bytes, using GNU/BSD `du` as a fast C-level walk with a per-path
 * TTL cache, falling back to a plain Node walk when no compatible `du`
 * exists (e.g. bare Windows).
 *
 * The unit is apparent bytes (sum of `st_size`) — identical to CSS's
 * `FileSizeReporter`, portable across servers/filesystems and
 * user-manageable. `stat.blocks` (disk usage) is deliberately NOT used:
 * the result would depend on the server's filesystem cluster size.
 */
export class DuSizeReporter implements SizeReporter<unknown> {
  private readonly fileIdentifierMapper: FileIdentifierMapper;
  private readonly rootFilePath: string;
  private readonly ignoreFolders: RegExp[];
  private readonly ttlMs: number;
  private readonly cache: Map<string, CacheEntry> = new Map();
  private duFlavor: 'gnu' | 'bsd' | 'none' | null = null;

  public constructor(
    fileIdentifierMapper: FileIdentifierMapper,
    rootFilePath: string,
    ignoreFolders: string[] = [],
    ttl: number = 5000,
  ) {
    this.fileIdentifierMapper = fileIdentifierMapper;
    this.rootFilePath = normalizeFilePath(rootFilePath);
    this.ignoreFolders = ignoreFolders.map((folder): RegExp => new RegExp(folder, 'u'));
    this.ttlMs = ttl;
  }

  /** The DuSizeReporter always returns data in the form of bytes. */
  public getUnit(): string {
    return UNIT_BYTES;
  }

  /**
   * Returns the size of the given resource (and its children) in apparent
   * bytes, using the per-path TTL cache when possible.
   */
  public async getSize(identifier: ResourceIdentifier): Promise<Size> {
    const { filePath } = await this.fileIdentifierMapper.mapUrlToFilePath(identifier, false);
    const normalized = normalizeFilePath(filePath);
    const cached = this.cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) {
      return { unit: UNIT_BYTES, amount: cached.size };
    }
    const amount = await this.computeTotalSize(normalized);
    this.cache.set(normalized, { size: amount, expiresAt: Date.now() + this.ttlMs });
    return { unit: UNIT_BYTES, amount };
  }

  /**
   * Drop the cached size for the given resource and all of its ancestors
   * (e.g. the pod root). Called when a write to the resource completes, so
   * the next size query re-walks and reflects the new content.
   */
  public async invalidate(identifier: ResourceIdentifier): Promise<void> {
    try {
      const { filePath } = await this.fileIdentifierMapper.mapUrlToFilePath(identifier, false);
      const normalized = normalizeFilePath(filePath);
      for (const key of this.cache.keys()) {
        if (key === normalized || normalized.startsWith(key)) {
          this.cache.delete(key);
        }
      }
    } catch {
      // Best-effort: if the resource cannot be mapped, leave the cache as-is.
    }
  }

  /** The size of a chunk is simply its length in bytes. */
  public async calculateChunkSize(chunk: unknown): Promise<number> {
    return Buffer.isBuffer(chunk) ? chunk.length : Number((chunk as any)?.length) || 0;
  }

  /** The estimated size of a resource is simply the content-length header. */
  public async estimateSize(metadata: RepresentationMetadata): Promise<number | undefined> {
    return metadata.contentLength;
  }

  // --- Walk implementations ---

  private async computeTotalSize(fileLocation: string): Promise<number> {
    const flavor = await this.detectDu();
    if (flavor !== 'none') {
      try {
        return await this.computeTotalSizeWithDu(fileLocation, flavor);
      } catch {
        // du failed (e.g. no du after all, permission error) — fall back to the Node walk.
      }
    }
    return this.computeTotalSizeWithNode(fileLocation);
  }

  private async computeTotalSizeWithDu(fileLocation: string, flavor: 'gnu' | 'bsd'): Promise<number> {
    const args: string[] = flavor === 'gnu' ? [ '-sb' ] : [ '-s', '-A', '-B', '1' ];
    for (const pattern of this.duExcludePatterns()) {
      args.push(flavor === 'gnu' ? '--exclude' : '-I', pattern);
    }
    args.push(fileLocation);
    const { stdout } = await execFileAsync('du', args, { maxBuffer: 64 * 1024 * 1024 });
    const amount = Number(stdout.trim().split(/\s+/)[0]);
    if (!Number.isFinite(amount)) {
      throw new Error(`Could not parse du output: ${stdout.trim()}`);
    }
    return amount;
  }

  /**
   * Plain Node recursive walk — the same semantics as CSS's
   * `FileSizeReporter.getTotalSize`. Used when no compatible `du` exists.
   */
  private async computeTotalSizeWithNode(fileLocation: string): Promise<number> {
    let stat;
    try {
      stat = await fsPromises.stat(fileLocation);
    } catch {
      return 0;
    }
    // If the file's location points to a file, simply return the file's size.
    if (stat.isFile()) {
      return stat.size;
    }
    // Recursively add all sizes of children to the total.
    const childFiles = await fsPromises.readdir(fileLocation);
    const rootFilePathLength = trimTrailingSlashes(this.rootFilePath).length;
    let totalSize = stat.size;
    for (const current of childFiles) {
      const childFileLocation = normalizeFilePath(joinFilePath(fileLocation, current));
      // Exclude internal files, matching FileSizeReporter's behavior.
      if (!this.ignoreFolders.some((folder): boolean => folder.test(childFileLocation.slice(rootFilePathLength)))) {
        totalSize += await this.computeTotalSizeWithNode(childFileLocation);
      }
    }
    return totalSize;
  }

  protected async detectDu(): Promise<'gnu' | 'bsd' | 'none'> {
    if (this.duFlavor) {
      return this.duFlavor;
    }
    try {
      await execFileAsync('du', [ '--version' ], { timeout: 1000 });
      this.duFlavor = 'gnu';
    } catch (error: any) {
      // ENOENT: no `du` at all (e.g. bare Windows). Anything else means the
      // GNU long option was rejected → assume BSD; if BSD flags fail at use
      // time, the caller falls back to the Node walk.
      this.duFlavor = error?.code === 'ENOENT' ? 'none' : 'bsd';
    }
    return this.duFlavor;
  }

  /**
   * Convert the configured ignore-folder regexes into `du` exclude patterns.
   * GNU/BSD `du` matches exclude patterns against path components/basenames
   * (not against the full leading-slash path), so a regex like `^/\.internal$`
   * becomes the exclude `.internal`.
   *
   * Only simple anchored folder patterns are convertible
   * (`^/name$`); complex regexes that cannot be expressed as a du exclude are
   * skipped here — the Node-walk fallback still applies them verbatim.
   */
  private duExcludePatterns(): string[] {
    const patterns: string[] = [];
    for (const regex of this.ignoreFolders) {
      // RegExp.source always escapes '/' as '\/' (e.g. `^/\.internal$` →
      // `^\/\.internal$`). Strip the leading '^' + '/' (possibly '\/'), drop
      // the trailing '$', then unescape the remaining escapes.
      let src = regex.source.replace(/^\^?\\?\//, '');
      src = src.replace(/\$?$/, '');
      src = src.replace(/\\./g, '.');
      // Keep only patterns with no remaining regex metacharacters.
      if (/^[A-Za-z0-9._-]+$/.test(src)) {
        patterns.push(src);
      }
    }
    return patterns;
  }
}
