/**
 * QueryCache — TanStack Query-inspired server cache
 *
 * Wraps any CacheStore with:
 * - Freshness metadata (staleTime / gcTime envelope)
 * - Stale-while-revalidate status detection
 * - Version-based O(1) invalidation (no key scanning)
 * - Tag-based cross-resource invalidation
 */

import type { CacheStore } from "./interface.js";
import { tagVersionKey, versionKey } from "./keys.js";

/** Metadata wrapper stored in CacheStore */
export interface CacheEnvelope<T = unknown> {
  data: T;
  createdAt: number;
  staleAfter: number;
  expiresAt: number;
  tags: string[];
}

export interface QueryCacheConfig {
  /** Seconds data is "fresh" (no revalidation). Default: 0 */
  staleTime?: number;
  /** Seconds stale data stays cached (SWR window). Default: 60 */
  gcTime?: number;
  /** Tags for group invalidation */
  tags?: string[];
  /**
   * Randomized freshness jitter (0–1, default 0 = off). Each write varies
   * its effective `staleTime` by ±(jitter × staleTime), so entries cached
   * together don't all go stale in the same instant — spreading
   * revalidation load instead of synchronizing a refresh burst.
   * Single-flight coalescing (BaseCrudController) handles same-key
   * stampedes; jitter de-synchronizes ACROSS keys. 0.1 is a sane value.
   */
  jitter?: number;
}

export type CacheStatus = "fresh" | "stale" | "miss";

/** A miss carries no data — narrow on `status` before reading `data`. */
export type CacheResult<T> =
  | { status: "miss"; data: undefined }
  | { status: "fresh" | "stale"; data: T };

const MISS: CacheResult<never> = Object.freeze({ status: "miss", data: undefined });

/** `QueryCache` options. */
export interface QueryCacheOptions {
  /**
   * Called once per store outage (the first failed operation after a success) with the
   * error and the operation. While the store fails, reads miss (the source answers), writes
   * are skipped, and invalidations are remembered and replayed when it answers again.
   */
  onStoreError?: (err: unknown, operation: string) => void;
}

export class QueryCache {
  private readonly store: CacheStore;
  private readonly onStoreError: QueryCacheOptions["onStoreError"];
  /** Entry deletes the store refused: read as a miss here until replayed. */
  private readonly pendingDeletes = new Set<string>();
  /** Version keys whose bump the store refused: bumped once each when it answers again. */
  private readonly pendingBumps = new Set<string>();
  private failing = false;
  private flushing: Promise<void> | undefined;

  constructor(store: CacheStore, options: QueryCacheOptions = {}) {
    this.store = store;
    this.onStoreError = options.onStoreError;
  }

  async get<T>(key: string): Promise<CacheResult<T>> {
    if (!(await this.recovered()) || this.pendingDeletes.has(key)) return MISS;
    let envelope: CacheEnvelope<T> | undefined;
    try {
      envelope = (await this.store.get(key)) as CacheEnvelope<T> | undefined;
      this.ok();
    } catch (err) {
      this.failed(err, "get");
      return MISS;
    }

    if (!envelope?.createdAt) return MISS;

    const now = Date.now();

    if (now >= envelope.expiresAt) {
      await this.invalidate(key);
      return MISS;
    }

    if (now < envelope.staleAfter) {
      return { data: envelope.data, status: "fresh" };
    }

    return { data: envelope.data, status: "stale" };
  }

  async set<T>(key: string, data: T, config: QueryCacheConfig): Promise<void> {
    const baseStaleTimeSec = config.staleTime ?? 0;
    const jitter = config.jitter ?? 0;
    const staleTimeSec =
      jitter > 0
        ? Math.max(0, baseStaleTimeSec * (1 + (Math.random() * 2 - 1) * jitter))
        : baseStaleTimeSec;
    const gcTimeSec = config.gcTime ?? 60;
    const totalTtlSec = staleTimeSec + gcTimeSec;
    const now = Date.now();

    const envelope: CacheEnvelope<T> = {
      data,
      createdAt: now,
      staleAfter: now + staleTimeSec * 1000,
      expiresAt: now + totalTtlSec * 1000,
      tags: config.tags ?? [],
    };

    try {
      await this.store.set(key, envelope, totalTtlSec);
      this.pendingDeletes.delete(key);
      this.ok();
    } catch (err) {
      // Not cached: the next read misses and the source answers.
      this.failed(err, "set");
    }
  }

  async invalidate(key: string): Promise<void> {
    try {
      await this.store.delete(key);
      this.pendingDeletes.delete(key);
      this.ok();
    } catch (err) {
      this.pendingDeletes.add(key);
      this.failed(err, "invalidate");
    }
  }

  /** Get current version for a resource (defaults to 0 if not set) */
  async getResourceVersion(resource: string): Promise<number> {
    return this.readVersion(versionKey(resource));
  }

  /** Bump resource version — orphans all cached queries for this resource */
  async bumpResourceVersion(resource: string): Promise<void> {
    await this.bumpVersion(versionKey(resource));
  }

  /** Get current version for a tag */
  async getTagVersion(tag: string): Promise<number> {
    return this.readVersion(tagVersionKey(tag));
  }

  /** Bump tag version — orphans all cached queries tagged with this tag */
  async bumpTagVersion(tag: string): Promise<void> {
    await this.bumpVersion(tagVersionKey(tag));
  }

  /** The store is failing, or holds invalidations it refused: reads go to the source. */
  get degraded(): boolean {
    return this.failing || this.pendingDeletes.size > 0 || this.pendingBumps.size > 0;
  }

  /**
   * A version the store cannot give is 0: entries are not read while it fails either, and
   * a version bump it refused is replayed before any version is read again (`recovered`),
   * so an entry cached before the outage is never served past an invalidation.
   */
  private async readVersion(key: string): Promise<number> {
    if (!(await this.recovered())) return 0;
    try {
      const ver = (await this.store.get(key)) as number | undefined;
      this.ok();
      return ver ?? 0;
    } catch (err) {
      this.failed(err, "version");
      return 0;
    }
  }

  /**
   * Version-bump semantics:
   *
   *  - `store.increment` present (Redis `INCR`) — atomic and strictly
   *    monotonic across replicas; concurrent bumps can never collide or
   *    go backwards.
   *  - fallback — read-modify-write with `max(now, current + 1)`: two
   *    bumps in the same millisecond and clock regressions still advance
   *    the version. Concurrent bumps from DIFFERENT replicas can lose one
   *    write, which is why distributed hosts should use an incrementing
   *    store (`runtime: 'distributed'` already requires a shared one).
   *
   * Version keys must outlive every derived cache entry — that invariant
   * is what makes version invalidation sound (a version key expiring back
   * to 0 would make entries written under the pre-reset version
   * addressable again). The 1-year TTL applies with the repo-core
   * TTL-ON-CREATE semantics, so a version key expires one year after its
   * FIRST bump — safe, because a revived collision would need an entry to
   * outlive that reset and entry TTLs are minutes-scale (staleTime +
   * gcTime). The read-modify-write fallback uses plain `set`, which
   * refreshes the TTL per bump — strictly longer-lived, equally safe.
   *
   * A bump the store refuses is remembered and replayed once it answers.
   */
  private async bumpVersion(key: string): Promise<void> {
    try {
      await this.rawBump(key);
      this.pendingBumps.delete(key);
      this.ok();
    } catch (err) {
      this.pendingBumps.add(key);
      this.failed(err, "bump");
    }
  }

  private async rawBump(key: string): Promise<void> {
    if (typeof this.store.increment === "function") {
      // Canonical CacheAdapter signature: (key, by, ttlSeconds).
      await this.store.increment(key, 1, VERSION_TTL_SECONDS);
      return;
    }
    const current = (await this.store.get(key)) as number | undefined;
    const next = Math.max(Date.now(), (current ?? 0) + 1);
    await this.store.set(key, next, VERSION_TTL_SECONDS);
  }

  /**
   * Replay refused invalidations before a read; `false` while the store still refuses a
   * version bump (the caller then answers from the source). One replay at a time.
   */
  private async recovered(): Promise<boolean> {
    if (this.pendingBumps.size === 0 && this.pendingDeletes.size === 0) return true;
    this.flushing ??= this.flush().finally(() => {
      this.flushing = undefined;
    });
    await this.flushing;
    return this.pendingBumps.size === 0;
  }

  private async flush(): Promise<void> {
    try {
      for (const key of [...this.pendingBumps]) {
        await this.rawBump(key);
        this.pendingBumps.delete(key);
      }
      for (const key of [...this.pendingDeletes]) {
        await this.store.delete(key);
        this.pendingDeletes.delete(key);
      }
      this.ok();
    } catch (err) {
      this.failed(err, "replay");
    }
  }

  private ok(): void {
    this.failing = false;
  }

  private failed(err: unknown, operation: string): void {
    if (!this.failing) {
      try {
        this.onStoreError?.(err, operation);
      } catch {
        // A reporting callback never breaks a read.
      }
    }
    this.failing = true;
  }
}

/** See `bumpVersion` — effectively non-expiring, refreshed on every bump. */
const VERSION_TTL_SECONDS = 365 * 24 * 60 * 60;
