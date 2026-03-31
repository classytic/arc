/**
 * Redis Session Store for Arc
 *
 * Implements the SessionStore interface using Redis for distributed session storage.
 * Use this in multi-instance/clustered deployments where MemorySessionStore won't work.
 *
 * This is a SEPARATE subpath import — only loaded when explicitly used:
 *   import { RedisSessionStore } from '@classytic/arc/auth/redis';
 *
 * @example
 * ```typescript
 * import { createSessionManager } from '@classytic/arc/auth';
 * import { RedisSessionStore } from '@classytic/arc/auth/redis';
 * import Redis from 'ioredis';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 *
 * const sessions = createSessionManager({
 *   store: new RedisSessionStore({ redis }),
 *   secret: process.env.SESSION_SECRET!,
 * });
 *
 * await fastify.register(sessions.plugin);
 * ```
 */

import type { SessionData, SessionStore } from "./sessionManager.js";

// ============================================================================
// Types
// ============================================================================

/** Minimal Redis client interface — compatible with ioredis */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface RedisSessionStoreOptions {
  /** Redis client instance (ioredis or compatible) */
  redis: RedisLike;
  /** Key prefix for session keys (default: 'arc:session:') */
  prefix?: string;
  /** Key prefix for user-to-sessions index (default: 'arc:user-sessions:') */
  userPrefix?: string;
}

// ============================================================================
// RedisSessionStore
// ============================================================================

/**
 * Redis-backed session store for distributed deployments.
 *
 * Uses two key patterns:
 * - `{prefix}{sessionId}` — stores serialized SessionData with TTL
 * - `{userPrefix}{userId}` — Redis Set of sessionIds for bulk operations
 *
 * Session expiration is handled by Redis TTL — no cleanup interval needed.
 */
export class RedisSessionStore implements SessionStore {
  private redis: RedisLike;
  private prefix: string;
  private userPrefix: string;

  constructor(options: RedisSessionStoreOptions) {
    this.redis = options.redis;
    this.prefix = options.prefix ?? "arc:session:";
    this.userPrefix = options.userPrefix ?? "arc:user-sessions:";
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const raw = await this.redis.get(this.prefix + sessionId);
    if (!raw) return null;

    let session: SessionData;
    try {
      session = JSON.parse(raw) as SessionData;
    } catch {
      // Corrupted data — clean up
      await this.delete(sessionId);
      return null;
    }

    // Belt-and-suspenders expiration check (Redis TTL should handle this)
    if (Date.now() > session.expiresAt) {
      await this.delete(sessionId);
      return null;
    }

    return session;
  }

  async set(sessionId: string, data: SessionData): Promise<void> {
    const ttlMs = data.expiresAt - Date.now();
    if (ttlMs <= 0) return; // Already expired, don't store

    const ttlSeconds = Math.ceil(ttlMs / 1000);
    const serialized = JSON.stringify(data);

    // Store session with TTL
    await this.redis.set(this.prefix + sessionId, serialized, "EX", ttlSeconds);

    // Add to user index set (with generous TTL)
    const userKey = this.userPrefix + data.userId;
    await this.redis.sadd(userKey, sessionId);
    // Set TTL on user index slightly longer than session TTL
    await this.redis.expire(userKey, ttlSeconds + 3600);
  }

  async delete(sessionId: string): Promise<void> {
    // Get session first to clean up user index
    const raw = await this.redis.get(this.prefix + sessionId);
    if (raw) {
      try {
        const session = JSON.parse(raw) as SessionData;
        await this.redis.srem(this.userPrefix + session.userId, sessionId);
      } catch {
        // Best effort — session data may be corrupted
      }
    }

    await this.redis.del(this.prefix + sessionId);
  }

  async deleteAll(userId: string): Promise<void> {
    const userKey = this.userPrefix + userId;
    const sessionIds = await this.redis.smembers(userKey);

    if (sessionIds.length > 0) {
      // Delete all session keys
      const keys = sessionIds.map((id) => this.prefix + id);
      await this.redis.del(...keys);
    }

    // Delete the user index
    await this.redis.del(userKey);
  }

  async deleteAllExcept(userId: string, currentSessionId: string): Promise<void> {
    const userKey = this.userPrefix + userId;
    const sessionIds = await this.redis.smembers(userKey);

    const toDelete = sessionIds.filter((id) => id !== currentSessionId);
    if (toDelete.length > 0) {
      const keys = toDelete.map((id) => this.prefix + id);
      await this.redis.del(...keys);
      await this.redis.srem(userKey, ...toDelete);
    }
  }
}
