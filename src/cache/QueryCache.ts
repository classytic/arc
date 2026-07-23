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

export interface CacheResult<T> {
  data: T;
  status: CacheStatus;
}

export class QueryCache {
  private readonly store: CacheStore;

  constructor(store: CacheStore) {
    this.store = store;
  }

  async get<T>(key: string): Promise<CacheResult<T>> {
    const envelope = (await this.store.get(key)) as CacheEnvelope<T> | undefined;

    if (!envelope?.createdAt) {
      return { data: undefined as T, status: "miss" };
    }

    const now = Date.now();

    if (now >= envelope.expiresAt) {
      await this.store.delete(key);
      return { data: undefined as T, status: "miss" };
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

    await this.store.set(key, envelope, totalTtlSec);
  }

  async invalidate(key: string): Promise<void> {
    await this.store.delete(key);
  }

  /** Get current version for a resource (defaults to 0 if not set) */
  async getResourceVersion(resource: string): Promise<number> {
    const ver = (await this.store.get(versionKey(resource))) as number | undefined;
    return ver ?? 0;
  }

  /** Bump resource version — orphans all cached queries for this resource */
  async bumpResourceVersion(resource: string): Promise<void> {
    await this.bumpVersion(versionKey(resource));
  }

  /** Get current version for a tag */
  async getTagVersion(tag: string): Promise<number> {
    const ver = (await this.store.get(tagVersionKey(tag))) as number | undefined;
    return ver ?? 0;
  }

  /** Bump tag version — orphans all cached queries tagged with this tag */
  async bumpTagVersion(tag: string): Promise<void> {
    await this.bumpVersion(tagVersionKey(tag));
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
   */
  private async bumpVersion(key: string): Promise<void> {
    if (typeof this.store.increment === "function") {
      // Canonical CacheAdapter signature: (key, by, ttlSeconds).
      await this.store.increment(key, 1, VERSION_TTL_SECONDS);
      return;
    }
    const current = (await this.store.get(key)) as number | undefined;
    const next = Math.max(Date.now(), (current ?? 0) + 1);
    await this.store.set(key, next, VERSION_TTL_SECONDS);
  }
}

/** See `bumpVersion` — effectively non-expiring, refreshed on every bump. */
const VERSION_TTL_SECONDS = 365 * 24 * 60 * 60;
