import type { CacheStats, CacheStore } from "./interface.js";

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
  /** Optional: atomic increment-by (Redis INCRBY). Enables `CacheStore.increment`. */
  incrBy?(key: string, by: number): Promise<number>;
  /**
   * Optional: set a TTL only when the key has none (Redis 7 `EXPIRE ... NX`,
   * or a Lua `TTL`/`EXPIRE` script on older servers). Required alongside
   * `incrBy` for the atomic `increment` path — the CacheAdapter contract is
   * TTL-ON-CREATE, and no return value of INCRBY can prove creation (an
   * existing counter at 0 incremented by `by` also returns `by`).
   */
  expireIfAbsent?(key: string, seconds: number): Promise<unknown>;
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
  /** Default TTL in seconds (default: 60) */
  defaultTtlSeconds?: number;
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
  private readonly defaultTtlSeconds: number;
  private readonly maxEntryBytes: number;

  private _hits = 0;
  private _misses = 0;

  constructor(options: RedisCacheStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? "arc:cache:";
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 60;
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

  async set(key: string, value: TValue, ttlSeconds?: number): Promise<void> {
    const effectiveTtlSeconds = ttlSeconds ?? this.defaultTtlSeconds;
    if (!Number.isFinite(effectiveTtlSeconds) || effectiveTtlSeconds <= 0) return;

    const payload = JSON.stringify(value);

    if (this.maxEntryBytes > 0 && Buffer.byteLength(payload, "utf8") > this.maxEntryBytes) {
      return; // skip oversized entry
    }

    // Prefer EX (seconds) natively — matches Redis `SET key val EX n`.
    await this.client.set(this.withPrefix(key), payload, {
      EX: Math.ceil(effectiveTtlSeconds),
    });
  }

  async delete(key: string): Promise<void> {
    // Note: `this.client.del(...)` stays — ioredis/node-redis/upstash
    // clients all expose the Redis primitive as `.del()`. Arc's cache
    // adapter surface exposes `.delete()` for ecosystem consistency.
    await this.client.del(this.withPrefix(key));
  }

  /**
   * Atomic increment (canonical `CacheAdapter` signature: key, by, ttl).
   *
   * The atomic path requires `incrBy` AND — when a TTL is requested —
   * `expireIfAbsent`: TTL-on-create cannot be inferred from INCRBY's
   * return value (an existing counter at 0 also returns `by`), so the
   * NX-expiry must be its own atomic server-side operation. A client that
   * can't honor the COMPLETE contract falls back to read-modify-write
   * (monotonic, but a concurrent replica's bump can be lost, and the TTL
   * refreshes per write since plain SET can't preserve expiry).
   */
  async increment(key: string, by = 1, ttlSeconds?: number): Promise<number> {
    const prefixed = this.withPrefix(key);
    const wantsTtl = ttlSeconds !== undefined && ttlSeconds > 0;
    if (this.client.incrBy && (!wantsTtl || this.client.expireIfAbsent)) {
      const next = await this.client.incrBy(prefixed, by);
      if (wantsTtl) {
        await this.client.expireIfAbsent?.(prefixed, Math.ceil(ttlSeconds));
      }
      return next;
    }
    const current = await this.get(key);
    const next = (typeof current === "number" ? current : 0) + by;
    await this.set(key, next as unknown as TValue, ttlSeconds ?? this.defaultTtlSeconds);
    return next;
  }

  /**
   * Invalidate keys. Pass a glob pattern to delete a subset (`user:*:v2`);
   * omit to clear every key under this store's prefix.
   */
  async clear(pattern?: string): Promise<void> {
    const scanPattern = pattern
      ? `${this.prefix}${pattern.includes("*") ? pattern : `${pattern}*`}`
      : `${this.prefix}*`;
    await this.scanAndDelete(scanPattern);
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
  incrby?(key: string, by: number): Promise<number>;
  eval?(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
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
    pipeline: client.pipeline ? () => (client.pipeline as () => RedisPipeline)() : undefined,
    incrBy: client.incrby
      ? (key, by) => (client.incrby as (k: string, n: number) => Promise<number>)(key, by)
      : undefined,
    // Atomic NX-expiry via a Lua script — TTL < 0 covers both "missing"
    // (-2) and "exists without expiry" (-1, a fresh INCRBY-created key).
    // Works on every Redis version ioredis supports, unlike `EXPIRE ... NX`
    // which needs Redis 7.
    expireIfAbsent: client.eval
      ? (key, seconds) =>
          (client.eval as (s: string, n: number, ...a: (string | number)[]) => Promise<unknown>)(
            EXPIRE_IF_ABSENT_LUA,
            1,
            key,
            seconds,
          )
      : undefined,
  };
}

const EXPIRE_IF_ABSENT_LUA =
  "if redis.call('TTL', KEYS[1]) < 0 then return redis.call('EXPIRE', KEYS[1], ARGV[1]) else return 0 end";

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
  incrby?(key: string, by: number): Promise<number>;
  eval?(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
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
    incrBy: client.incrby
      ? (key, by) => (client.incrby as (k: string, n: number) => Promise<number>)(key, by)
      : undefined,
    // Same atomic NX-expiry Lua as the ioredis adapter — upstash's REST
    // eval takes (script, keys[], args[]).
    expireIfAbsent: client.eval
      ? (key, seconds) =>
          (client.eval as (s: string, k: string[], a: (string | number)[]) => Promise<unknown>)(
            EXPIRE_IF_ABSENT_LUA,
            [key],
            [seconds],
          )
      : undefined,
  };
}
