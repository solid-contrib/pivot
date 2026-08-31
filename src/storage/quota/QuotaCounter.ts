import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  UNIT_BYTES,
  joinFilePath,
  normalizeFilePath,
} from '@solid/community-server';
import type {
  FileIdentifierMapper,
  ResourceIdentifier,
  Size,
} from '@solid/community-server';
import { DuSizeReporter } from '../size-reporter/DuSizeReporter';

// In-memory counter entry for one pod.
interface CounterEntry {
  total: number;
  valid: boolean;
  podMtimeMs: number;
}

/**
 * Incremental per-pod byte counter (design C).
 *
 * Keeps the apparent-byte total of every pod in memory, updated O(1) per
 * write by the {@link QuotaDeltaDataAccessor} delta hook, and persisted to a
 * per-pod sidecar (`<podRoot>/.internal/pivot-quota.json`, atomic rename) so
 * counters survive restarts. A full `du`/Node walk (via DuSizeReporter) is
 * only used to bootstrap a pod (first access, no sidecar) or recover a
 * de-synchronized counter.
 *
 * The counter is a cache; the filesystem is the source of truth. Staleness
 * (out-of-band changes, crash window) is detected cheaply by comparing the
 * pod root directory's mtime against the recorded one, then re-walking once.
 */
export class QuotaCounter {
  private readonly fileIdentifierMapper: FileIdentifierMapper;
  private readonly rootFilePath: string;
  private readonly sidecarRelativePath: string;
  private readonly walker: DuSizeReporter;
  private readonly entries: Map<string, CounterEntry> = new Map();
  private readonly locks: Map<string, Promise<void>> = new Map();

  public constructor(
    fileIdentifierMapper: FileIdentifierMapper,
    rootFilePath: string,
    ignoreFolders: string[] = [],
    sidecarRelativePath = '/.internal/pivot-quota.json',
  ) {
    this.fileIdentifierMapper = fileIdentifierMapper;
    this.rootFilePath = normalizeFilePath(rootFilePath);
    this.sidecarRelativePath = sidecarRelativePath;
    // Dedicated walker with no cache — every call is a fresh recount.
    this.walker = new DuSizeReporter(fileIdentifierMapper, rootFilePath, ignoreFolders, 0);
  }

  /** The QuotaCounter always reports in bytes. */
  public getUnit(): string {
    return UNIT_BYTES;
  }

  /**
   * Returns the pod's current total, performing a recount (walk) only when
   * the pod has no valid counter (first access, no sidecar, or staleness).
   */
  public async getSize(podIdentifier: ResourceIdentifier): Promise<Size> {
    const path = await this.mapDataPath(podIdentifier);
    const entry = await this.ensureEntry(path, podIdentifier);
    return { unit: UNIT_BYTES, amount: entry.total };
  }

  /**
   * Marks a path as a pod root so {@link IncrementalSizeReporter} routes
   * pod-root identifiers to the counter. Called by the delta hook when it
   * first discovers a pod.
   */
  public async register(podIdentifier: ResourceIdentifier): Promise<void> {
    const path = await this.mapDataPath(podIdentifier);
    if (!this.entries.has(path)) {
      this.entries.set(path, { total: 0, valid: false, podMtimeMs: 0 });
    }
  }

  /** Whether the given identifier maps to a known pod root. */
  public async isPodRoot(identifier: ResourceIdentifier): Promise<boolean> {
    return this.entries.has(await this.mapDataPath(identifier));
  }

  /**
   * Applies a size delta to the pod. Updates the in-memory counter and
   * persists the sidecar atomically. Per-pod mutex serializes concurrent
   * writes.
   */
  public async add(podIdentifier: ResourceIdentifier, delta: number): Promise<void> {
    const path = await this.mapDataPath(podIdentifier);
    await this.withLock(path, async (): Promise<void> => {
      const entry = this.entries.get(path) ?? { total: 0, valid: false, podMtimeMs: 0 };
      entry.total += delta;
      entry.valid = true;
      this.entries.set(path, entry);
      await this.persistWithMtime(path, entry);
    });
  }

  /** Drops the counter for a pod and removes its sidecar (pod deletion). */
  public async remove(podIdentifier: ResourceIdentifier): Promise<void> {
    const path = await this.mapDataPath(podIdentifier);
    await this.withLock(path, async (): Promise<void> => {
      this.entries.delete(path);
      await fs.rm(this.sidecarPath(path), { force: true }).catch(() => undefined);
    });
  }

  /**
   * Apparent size of a single resource (not a pod root) — used by the
   * reporter for the overwritten-resource subtraction in
   * `QuotaStrategy.getAvailableSpace`. Single stat for a document; walk for a
   * container.
   */
  public async sizeOfResource(identifier: ResourceIdentifier): Promise<number> {
    const filePath = await this.mapDataPath(identifier);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        return stat.size;
      }
      // Container — walk it (rare: only the overwritten resource is a file).
      return (await this.walker.getSize(identifier)).amount;
    } catch {
      return 0;
    }
  }

  /** Maps an identifier to its data file path (normalized). */
  public async mapDataPath(identifier: ResourceIdentifier): Promise<string> {
    const { filePath } = await this.fileIdentifierMapper.mapUrlToFilePath(identifier, false);
    return normalizeFilePath(filePath);
  }

  /**
   * Full apparent-byte walk of a resource/container (used by the delta hook
   * for container before/after sizing — rare, e.g. create/delete container).
   */
  public async walk(identifier: ResourceIdentifier): Promise<number> {
    return (await this.walker.getSize(identifier)).amount;
  }

  // --- Internals ---

  private async ensureEntry(path: string, podIdentifier: ResourceIdentifier): Promise<CounterEntry> {
    let entry = this.entries.get(path);
    if (entry && entry.valid) {
      const mtime = await this.podRootMtime(path);
      if (entry.podMtimeMs === mtime) {
        return entry;
      }
      // Pod root mtime moved — the counter may be stale, recount below.
    }
    // Try the sidecar first (persisted counter), then a full walk.
    return this.withLock(path, async (): Promise<CounterEntry> => {
      entry = this.entries.get(path);
      if (entry && entry.valid) {
        const mtime = await this.podRootMtime(path);
        if (entry.podMtimeMs === mtime) {
          return entry;
        }
      }
      const loaded = await this.loadSidecar(path);
      if (loaded && loaded.valid) {
        const mtime = await this.podRootMtime(path);
        if (loaded.podMtimeMs === mtime) {
          this.entries.set(path, loaded);
          return loaded;
        }
      }
      // No valid counter — full walk (bootstrap / recovery).
      const total = (await this.walker.getSize(podIdentifier)).amount;
      const fresh: CounterEntry = { total, valid: true, podMtimeMs: 0 };
      this.entries.set(path, fresh);
      await this.persistWithMtime(path, fresh);
      return fresh;
    });
  }

  private async podRootMtime(path: string): Promise<number> {
    try {
      const stat = await fs.stat(path);
      return stat.isDirectory() ? stat.mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  private sidecarPath(podRootPath: string): string {
    return normalizeFilePath(joinFilePath(podRootPath, this.sidecarRelativePath));
  }

  private async loadSidecar(path: string): Promise<CounterEntry | undefined> {
    try {
      const raw = await fs.readFile(this.sidecarPath(path), 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.total === 'number' && typeof parsed?.podMtimeMs === 'number') {
        return { total: parsed.total, valid: true, podMtimeMs: parsed.podMtimeMs };
      }
    } catch {
      // Missing or malformed sidecar → recount.
    }
    return undefined;
  }

  private async persist(path: string, entry: CounterEntry): Promise<void> {
    const sidecar = this.sidecarPath(path);
    const tmp = `${sidecar}.tmp`;
    try {
      await fs.mkdir(join(path, '.internal'), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify({
        version: 1,
        total: entry.total,
        podMtimeMs: entry.podMtimeMs,
        updatedAt: new Date().toISOString(),
      }));
      await fs.rename(tmp, sidecar);
    } catch {
      // Persistence is best-effort: keep the in-memory counter authoritative.
    }
  }

  /**
   * Persist, then record the pod root mtime AFTER the persist. Persisting the
   * sidecar may create the `.internal/` directory (a new pod-root child), which
   * bumps the pod root's mtime — recording the mtime before would leave every
   * subsequent read thinking the counter is stale.
   */
  private async persistWithMtime(path: string, entry: CounterEntry): Promise<void> {
    await this.persist(path, entry);
    entry.podMtimeMs = await this.podRootMtime(path);
    await this.persist(path, entry);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve): void => {
      release = resolve;
    });
    // Waiters chain on `previous`, then wait for this call's `gate` to open.
    const next = previous.then(() => gate);
    this.locks.set(key, next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }
}
