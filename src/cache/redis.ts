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

// ============================================================================
// Adapters — bridge common clients to the RedisCacheClient interface
// ============================================================================

/**
 * Minimal ioredis shape we depend on. We don't import ioredis itself so the
 * cache subpath stays peer-dep-free.
 */
export interface IoredisLike {
  get(key: string): Promise<string | null>;
  set(...args: unknown[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>;
  pipeline?(): { del(key: string): unknown; exec(): Promise<unknown> };
}

/**
 * Wrap an ioredis instance as a `RedisCacheClient`.
 *
 * Why: arc's `RedisCacheClient` uses node-redis-v4 object-options style
 * (`set(key, val, { PX })`), but ioredis expects positional flags
 * (`set(key, val, 'PX', ms)`). Without this adapter every ioredis user
 * reinvents the bridge.
 *
 * @example
 * ```typescript
 * import Redis from 'ioredis';
 * import { RedisCacheStore, ioredisAsCacheClient } from '@classytic/arc/cache';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const store = new RedisCacheStore({
 *   client: ioredisAsCacheClient(redis),
 *   prefix: 'arc:cache:',
 * });
 * ```
 */
export function ioredisAsCacheClient(client: IoredisLike): RedisCacheClient {
  return {
    async get(key) {
      return client.get(key);
    },
    async set(key, value, options) {
      if (options?.PX) {
        return client.set(key, value, "PX", options.PX, ...(options.NX ? ["NX"] : []));
      }
      if (options?.EX) {
        return client.set(key, value, "EX", options.EX, ...(options.NX ? ["NX"] : []));
      }
      if (options?.NX) return client.set(key, value, "NX");
      return client.set(key, value);
    },
    async del(key) {
      if (Array.isArray(key)) return client.del(...key);
      return client.del(key);
    },
    async scan(cursor, ...args) {
      const [next, keys] = await client.scan(cursor, ...args);
      return [next, keys];
    },
    pipeline: client.pipeline ? () => client.pipeline!() : undefined,
  };
}

/**
 * Minimal `@upstash/redis` REST SDK shape we depend on.
 *
 * `@upstash/redis` is HTTP-based and works on edge runtimes (Cloudflare
 * Workers, Vercel Edge, Deno Deploy) where TCP connections — and thus
 * ioredis — are unavailable.
 */
export interface UpstashRedisLike {
  get(key: string): Promise<string | null | unknown>;
  set(key: string, value: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(
    cursor: number | string,
    opts?: { match?: string; count?: number },
  ): Promise<[number, string[]] | [string, string[]]>;
}

/**
 * Wrap an `@upstash/redis` REST client as a `RedisCacheClient`.
 *
 * Enables running arc's cache layer on edge runtimes without ioredis.
 * Requires `@upstash/redis` as an optional peer dependency.
 *
 * @example
 * ```typescript
 * import { Redis } from '@upstash/redis';
 * import { RedisCacheStore, upstashAsCacheClient } from '@classytic/arc/cache';
 *
 * const redis = Redis.fromEnv();
 * const store = new RedisCacheStore({
 *   client: upstashAsCacheClient(redis),
 *   prefix: 'arc:cache:',
 * });
 * ```
 */
export function upstashAsCacheClient(client: UpstashRedisLike): RedisCacheClient {
  return {
    async get(key) {
      const raw = await client.get(key);
      // Upstash auto-deserializes strings — arc stores JSON strings and
      // parses them itself, so we need to re-serialize here to preserve
      // the contract. Null passes through.
      if (raw == null) return null;
      return typeof raw === "string" ? raw : JSON.stringify(raw);
    },
    async set(key, value, options) {
      // Map arc's uppercase option keys to upstash's lowercase.
      const opts: Record<string, unknown> = {};
      if (options?.PX) opts.px = options.PX;
      if (options?.EX) opts.ex = options.EX;
      if (options?.NX) opts.nx = true;
      if (options?.XX) opts.xx = true;
      const res = await client.set(key, value, opts);
      return res == null ? null : String(res);
    },
    async del(key) {
      if (Array.isArray(key)) return client.del(...key);
      return client.del(key);
    },
    async scan(cursor, ...args) {
      // arc passes variadic strings in the node-redis v3 shape:
      // `scan(cursor, 'MATCH', pattern, 'COUNT', count)`
      // upstash takes an options object. Translate.
      const opts: { match?: string; count?: number } = {};
      for (let i = 0; i < args.length; i += 2) {
        const flag = String(args[i]).toLowerCase();
        const val = args[i + 1];
        if (flag === "match" && typeof val === "string") opts.match = val;
        if (flag === "count") opts.count = Number(val);
      }
      const [next, keys] = await client.scan(cursor, opts);
      return [next, keys];
    },
  };
}
