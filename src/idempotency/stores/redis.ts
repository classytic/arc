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

import type { IdempotencyStore, IdempotencyResult } from './interface.js';

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<string | null>;
  del(key: string | string[]): Promise<number>;
  exists(key: string | string[]): Promise<number>;
  /** SCAN command — compatible with node-redis and ioredis varargs signatures. */
  scan?(cursor: string | number, ...args: (string | number)[]): Promise<[string | number, string[]]>;
  quit?(): Promise<string>;
  disconnect?(): Promise<void>;
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
  readonly name = 'redis';
  private client: RedisClient;
  private prefix: string;
  private lockPrefix: string;
  private ttlMs: number;

  constructor(options: RedisIdempotencyStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? 'idem:';
    this.lockPrefix = options.lockPrefix ?? 'idem:lock:';
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

  async set(key: string, result: Omit<IdempotencyResult, 'key'>): Promise<void> {
    const data: IdempotencyResult = { key, ...result };
    const ttlSeconds = Math.ceil(
      (new Date(result.expiresAt).getTime() - Date.now()) / 1000
    );

    if (ttlSeconds > 0) {
      await this.client.set(this.resultKey(key), JSON.stringify(data), {
        EX: ttlSeconds,
      });
    }
  }

  async tryLock(key: string, requestId: string, ttlMs: number): Promise<boolean> {
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    const result = await this.client.set(
      this.lockKey(key),
      requestId,
      { EX: ttlSeconds, NX: true }
    );
    return result === 'OK';
  }

  async unlock(key: string, requestId: string): Promise<void> {
    // Only unlock if we hold the lock (check requestId)
    const currentHolder = await this.client.get(this.lockKey(key));
    if (currentHolder === requestId) {
      await this.client.del(this.lockKey(key));
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
    for (const key of keys) {
      const data = await this.client.get(key);
      if (!data) continue;
      try {
        const result = JSON.parse(data) as IdempotencyResult;
        if (new Date(result.expiresAt) < new Date()) continue;
        return {
          ...result,
          createdAt: new Date(result.createdAt),
          expiresAt: new Date(result.expiresAt),
        };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /** Scan Redis keys matching a prefix pattern. Falls back to empty if SCAN unavailable. */
  private async scanByPrefix(prefix: string): Promise<string[]> {
    if (!this.client.scan) return [];
    const keys: string[] = [];
    let cursor: string | number = '0';
    do {
      const [nextCursor, batch] = await this.client.scan(
        cursor, 'MATCH', `${prefix}*`, 'COUNT', 100,
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (String(cursor) !== '0');
    return keys;
  }

  async close(): Promise<void> {
    // Don't close the client - it's passed in and may be shared
    // The caller is responsible for closing it
  }
}

export default RedisIdempotencyStore;
