import type { CacheSetOptions, CacheStats, CacheStore } from "./interface.js";

export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: {
      EX?: number;
      PX?: number;
      NX?: boolean;
      XX?: boolean;
    },
  ): Promise<string | null | unknown>;
  del(key: string | string[]): Promise<number>;
  /**
   * Optional: enables prefix-based `clear()` and `deleteByPrefix()` via SCAN.
   * Compatible with both ioredis and node-redis.
   * If not provided, `clear()` is a safe no-op.
   */
  scan?(
    cursor: string | number,
    ...args: (string | number)[]
  ): Promise<[string | number, string[]]>;
  /** Optional: pipeline for batched commands (ioredis compatible) */
  pipeline?(): RedisPipeline;
}

export interface RedisPipeline {
  del(key: string): unknown;
  exec(): Promise<unknown>;
}

export interface RedisCacheStoreOptions {
  /** Redis client instance */
  client: RedisCacheClient;
  /** Key prefix for namespacing (default: 'arc:cache:') */
  prefix?: string;
  /** Default TTL in milliseconds (default: 60_000) */
  defaultTtlMs?: number;
  /** Maximum serialized entry size in bytes. Oversized entries are skipped. */
  maxEntryBytes?: number;
}

/**
 * Redis-backed cache store.
 * Suitable for multi-instance and horizontally scaled deployments.
 * Uses pipeline batching when available for bulk operations.
 */
export class RedisCacheStore<TValue = unknown> implements CacheStore<TValue> {
  readonly name = "redis-cache";

  private readonly client: RedisCacheClient;
  private readonly prefix: string;
  private readonly defaultTtlMs: number;
  private readonly maxEntryBytes: number;

  private _hits = 0;
  private _misses = 0;

  constructor(options: RedisCacheStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? "arc:cache:";
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000;
    this.maxEntryBytes = options.maxEntryBytes ?? 0; // 0 = no limit
  }

  async get(key: string): Promise<TValue | undefined> {
    const data = await this.client.get(this.withPrefix(key));
    if (!data) {
      this._misses++;
      return undefined;
    }

    try {
      this._hits++;
      return JSON.parse(data) as TValue;
    } catch {
      this._misses++;
      this._hits--; // undo the hit — it's a corrupt entry
      return undefined;
    }
  }

  async set(key: string, value: TValue, options: CacheSetOptions = {}): Promise<void> {
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;

    const payload = JSON.stringify(value);

    if (this.maxEntryBytes > 0 && Buffer.byteLength(payload, "utf8") > this.maxEntryBytes) {
      return; // skip oversized entry
    }

    await this.client.set(this.withPrefix(key), payload, { PX: Math.ceil(ttlMs) });
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.withPrefix(key));
  }

  async clear(): Promise<void> {
    await this.scanAndDelete(`${this.prefix}*`);
  }

  /** Delete all keys matching `this.prefix + prefix + *`. Returns count deleted. */
  async deleteByPrefix(prefix: string): Promise<number> {
    return this.scanAndDelete(`${this.prefix}${prefix}*`);
  }

  stats(): CacheStats {
    return {
      entries: -1, // not cheaply available in Redis
      memoryBytes: -1,
      hits: this._hits,
      misses: this._misses,
      evictions: -1, // Redis handles eviction internally
    };
  }

  private async scanAndDelete(pattern: string): Promise<number> {
    if (!this.client.scan) return 0;

    const BATCH_SIZE = 200;
    let cursor: string | number = "0";
    let deleted = 0;

    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        BATCH_SIZE,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        if (this.client.pipeline) {
          const pipe = this.client.pipeline();
          for (const key of keys) pipe.del(key);
          await pipe.exec();
        } else {
          await this.client.del(keys);
        }
        deleted += keys.length;
      }
    } while (String(cursor) !== "0");

    return deleted;
  }

  private withPrefix(key: string): string {
    return `${this.prefix}${key}`;
  }
}

export default RedisCacheStore;
