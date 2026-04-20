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
    const staleTimeSec = config.staleTime ?? 0;
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
    const key = versionKey(resource);
    const newVersion = Date.now();
    // Store version with a very long TTL (24h) — it's tiny data
    await this.store.set(key, newVersion, 24 * 60 * 60);
  }

  /** Get current version for a tag */
  async getTagVersion(tag: string): Promise<number> {
    const ver = (await this.store.get(tagVersionKey(tag))) as number | undefined;
    return ver ?? 0;
  }

  /** Bump tag version — orphans all cached queries tagged with this tag */
  async bumpTagVersion(tag: string): Promise<void> {
    const key = tagVersionKey(tag);
    const newVersion = Date.now();
    await this.store.set(key, newVersion, 24 * 60 * 60);
  }
}
