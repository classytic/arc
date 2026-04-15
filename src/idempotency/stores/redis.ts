/**
 * Redis Idempotency Store
 *
 * Durable idempotency store using Redis.
 * Suitable for multi-instance deployments.
 *
 * @example
 * import { createClient } from 'redis';
 * import { RedisIdempotencyStore } from '@classytic/arc/idempotency';
 *
 * const redis = createClient({ url: process.env.REDIS_URL });
 * await redis.connect();
 *
 * await fastify.register(idempotencyPlugin, {
 *   store: new RedisIdempotencyStore({ client: redis }),
 * });
 */

import type { IdempotencyResult, IdempotencyStore } from "./interface.js";

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<string | null>;
  del(key: string | string[]): Promise<number>;
  exists(key: string | string[]): Promise<number>;
  /** SCAN command — compatible with node-redis and ioredis varargs signatures. */
  scan?(
    cursor: string | number,
    ...args: (string | number)[]
  ): Promise<[string | number, string[]]>;
  quit?(): Promise<string>;
  disconnect?(): Promise<void>;
}

/** Extended Redis client that supports eval — ioredis always has this. */
interface RedisWithEval extends RedisClient {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisIdempotencyStoreOptions {
  /** Redis client instance */
  client: RedisClient;
  /** Key prefix (default: 'idem:') */
  prefix?: string;
  /** Lock key prefix (default: 'idem:lock:') */
  lockPrefix?: string;
  /** Default TTL in ms (default: 86400000 = 24 hours) */
  ttlMs?: number;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  readonly name = "redis";
  private client: RedisClient;
  private prefix: string;
  private lockPrefix: string;
  private ttlMs: number;

  constructor(options: RedisIdempotencyStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? "idem:";
    this.lockPrefix = options.lockPrefix ?? "idem:lock:";
    this.ttlMs = options.ttlMs ?? 86400000;
  }

  private resultKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private lockKey(key: string): string {
    return `${this.lockPrefix}${key}`;
  }

  async get(key: string): Promise<IdempotencyResult | undefined> {
    const data = await this.client.get(this.resultKey(key));
    if (!data) return undefined;

    try {
      const result = JSON.parse(data) as IdempotencyResult;
      // Check if expired (Redis TTL should handle this, but double-check)
      if (new Date(result.expiresAt) < new Date()) {
        await this.delete(key);
        return undefined;
      }
      return {
        ...result,
        createdAt: new Date(result.createdAt),
        expiresAt: new Date(result.expiresAt),
      };
    } catch {
      return undefined;
    }
  }

  async set(key: string, result: Omit<IdempotencyResult, "key">): Promise<void> {
    const data: IdempotencyResult = { key, ...result };
    const ttlSeconds = Math.ceil((new Date(result.expiresAt).getTime() - Date.now()) / 1000);

    if (ttlSeconds > 0) {
      await this.client.set(this.resultKey(key), JSON.stringify(data), {
        EX: ttlSeconds,
      });
    }
  }

  async tryLock(key: string, requestId: string, ttlMs: number): Promise<boolean> {
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    const result = await this.client.set(this.lockKey(key), requestId, {
      EX: ttlSeconds,
      NX: true,
    });
    return result === "OK";
  }

  async unlock(key: string, requestId: string): Promise<void> {
    // Atomic check-and-delete via Lua script — avoids the TOCTOU race
    // where another worker acquires the lock between our GET and DEL.
    // The script only deletes if the current value matches our requestId.
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const lockKey = this.lockKey(key);
    if (typeof (this.client as RedisWithEval).eval === "function") {
      await (this.client as RedisWithEval).eval(luaScript, 1, lockKey, requestId);
    } else {
      // Fallback for clients without eval — best-effort (TOCTOU possible)
      const currentHolder = await this.client.get(lockKey);
      if (currentHolder === requestId) {
        await this.client.del(lockKey);
      }
    }
  }

  async isLocked(key: string): Promise<boolean> {
    const exists = await this.client.exists(this.lockKey(key));
    return exists > 0;
  }

  async delete(key: string): Promise<void> {
    await this.client.del([this.resultKey(key), this.lockKey(key)]);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const resultKeys = await this.scanByPrefix(this.resultKey(prefix));
    const lockKeys = await this.scanByPrefix(this.lockKey(prefix));
    const allKeys = [...resultKeys, ...lockKeys];
    if (allKeys.length === 0) return 0;
    return this.client.del(allKeys);
  }

  async findByPrefix(prefix: string): Promise<IdempotencyResult | undefined> {
    const keys = await this.scanByPrefix(this.resultKey(prefix));
    if (keys.length === 0) return undefined;

    // Fetch in concurrent batches with early termination. Sequential GETs
    // would block on N round-trips of Redis RTT — over TLS on a managed
    // provider like Upstash that's easily 10ms+ per call. We fetch 10 at a
    // time, scan the batch for an unexpired match, and return as soon as
    // we find one without loading the rest.
    const BATCH_SIZE = 10;
    const now = new Date();

    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      const values = await Promise.all(batch.map((k) => this.client.get(k)));

      for (const data of values) {
        if (!data) continue;
        try {
          const result = JSON.parse(data) as IdempotencyResult;
          if (new Date(result.expiresAt) < now) continue;
          return {
            ...result,
            createdAt: new Date(result.createdAt),
            expiresAt: new Date(result.expiresAt),
          };
        } catch {}
      }
    }
    return undefined;
  }

  /** Scan Redis keys matching a prefix pattern. Falls back to empty if SCAN unavailable. */
  private async scanByPrefix(prefix: string): Promise<string[]> {
    if (!this.client.scan) return [];
    const keys: string[] = [];
    let cursor: string | number = "0";
    do {
      const [nextCursor, batch] = await this.client.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (String(cursor) !== "0");
    return keys;
  }

  async close(): Promise<void> {
    // Don't close the client - it's passed in and may be shared
    // The caller is responsible for closing it
  }
}

// ============================================================================
// Adapters — bridge common Redis clients to the idempotency RedisClient shape
// ============================================================================

/** Minimal ioredis shape we depend on — keeps this file peer-dep-free. */
export interface IoredisLike {
  get(key: string): Promise<string | null>;
  set(...args: unknown[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>;
  eval?(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit?(): Promise<string>;
  disconnect?(): void;
}

/**
 * Wrap an ioredis instance as the arc idempotency `RedisClient`.
 *
 * Arc's idempotency store expects node-redis-v4 style option objects
 * (`{ EX, NX }`). ioredis uses positional flags. This adapter lets users
 * plug an ioredis instance in without writing the bridge themselves.
 *
 * @example
 * ```typescript
 * import Redis from 'ioredis';
 * import { RedisIdempotencyStore, ioredisAsIdempotencyClient }
 *   from '@classytic/arc/idempotency/redis';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const store = new RedisIdempotencyStore({
 *   client: ioredisAsIdempotencyClient(redis),
 * });
 * ```
 */
export function ioredisAsIdempotencyClient(client: IoredisLike): RedisClient & {
  eval?: (script: string, numkeys: number, ...args: (string | number)[]) => Promise<unknown>;
} {
  return {
    async get(key) {
      return client.get(key);
    },
    async set(key, value, options) {
      const args: unknown[] = [key, value];
      if (options?.EX != null) args.push("EX", options.EX);
      if (options?.NX) args.push("NX");
      return (client.set as (...a: unknown[]) => Promise<string | null>)(...args);
    },
    async del(key) {
      if (Array.isArray(key)) return client.del(...key);
      return client.del(key);
    },
    async exists(key) {
      if (Array.isArray(key)) return client.exists(...key);
      return client.exists(key);
    },
    async scan(cursor, ...args) {
      const [next, keys] = await client.scan(cursor, ...args);
      return [next, keys];
    },
    eval: client.eval
      ? (script, numKeys, ...args) => client.eval!(script, numKeys, ...args)
      : undefined,
    async quit() {
      if (client.quit) return client.quit();
      return "OK";
    },
    async disconnect() {
      if (client.disconnect) client.disconnect();
    },
  };
}

/** Minimal `@upstash/redis` shape we depend on (REST client, edge-safe). */
export interface UpstashRedisLike {
  get(key: string): Promise<string | null | unknown>;
  set(key: string, value: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  scan(
    cursor: number | string,
    opts?: { match?: string; count?: number },
  ): Promise<[number, string[]] | [string, string[]]>;
  eval?(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}

/**
 * Wrap an `@upstash/redis` REST client as an idempotency `RedisClient`.
 *
 * Enables running arc's idempotency store on Cloudflare Workers, Vercel Edge
 * and Deno Deploy — runtimes that don't support raw TCP (ioredis).
 *
 * @example
 * ```typescript
 * import { Redis } from '@upstash/redis';
 * import { RedisIdempotencyStore, upstashAsIdempotencyClient }
 *   from '@classytic/arc/idempotency/redis';
 *
 * const redis = Redis.fromEnv();
 * const store = new RedisIdempotencyStore({
 *   client: upstashAsIdempotencyClient(redis),
 * });
 * ```
 */
export function upstashAsIdempotencyClient(client: UpstashRedisLike): RedisClient & {
  eval?: (script: string, numkeys: number, ...args: (string | number)[]) => Promise<unknown>;
} {
  return {
    async get(key) {
      const raw = await client.get(key);
      if (raw == null) return null;
      // Arc stores JSON strings; upstash auto-deserializes. Re-serialize to
      // preserve the contract so RedisIdempotencyStore can JSON.parse it.
      return typeof raw === "string" ? raw : JSON.stringify(raw);
    },
    async set(key, value, options) {
      const opts: Record<string, unknown> = {};
      if (options?.EX != null) opts.ex = options.EX;
      if (options?.NX) opts.nx = true;
      const res = await client.set(key, value, opts);
      return res == null ? null : String(res);
    },
    async del(key) {
      if (Array.isArray(key)) return client.del(...key);
      return client.del(key);
    },
    async exists(key) {
      if (Array.isArray(key)) return client.exists(...key);
      return client.exists(key);
    },
    async scan(cursor, ...args) {
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
    eval: client.eval
      ? async (script, _numKeys, ...args) => {
          // Upstash eval takes (script, keys[], args[]) — arc's contract passes
          // numkeys + flat args. Splitting here preserves the arc shape.
          const keyCount = _numKeys;
          const keys = args.slice(0, keyCount).map(String);
          const rest = args.slice(keyCount);
          return client.eval!(script, keys, rest);
        }
      : undefined,
    async quit() {
      return "OK";
    },
    async disconnect() {
      /* no-op — HTTP client has no persistent connection */
    },
  };
}
