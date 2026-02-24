/**
 * Idempotency Module
 *
 * Duplicate request protection for safe retries.
 * Caches responses by idempotency key to ensure operations
 * aren't accidentally repeated.
 *
 * @example
 * // Development (in-memory, default)
 * await fastify.register(idempotencyPlugin, { enabled: true });
 *
 * // Production with Redis (multi-instance)
 * import { RedisIdempotencyStore } from '@classytic/arc/idempotency/redis';
 * await fastify.register(idempotencyPlugin, {
 *   enabled: true,
 *   store: new RedisIdempotencyStore({ client: redis }),
 * });
 *
 * // Production with MongoDB (multi-instance)
 * import { MongoIdempotencyStore } from '@classytic/arc/idempotency/mongodb';
 * await fastify.register(idempotencyPlugin, {
 *   enabled: true,
 *   store: new MongoIdempotencyStore({ connection: mongoose.connection }),
 * });
 *
 * // Client usage: POST /api/orders + Idempotency-Key header
 */

// Main plugin
export {
  default as idempotencyPlugin,
  idempotencyPlugin as idempotencyPluginFn,
} from './idempotencyPlugin.js';
export type { IdempotencyPluginOptions } from './idempotencyPlugin.js';

// Core store (lightweight, no external deps)
export { MemoryIdempotencyStore, createIdempotencyResult } from './stores/index.js';

// Redis store — use dedicated subpath to avoid pulling ioredis:
//   import { RedisIdempotencyStore } from '@classytic/arc/idempotency/redis';
export type { RedisIdempotencyStoreOptions, RedisClient } from './stores/redis.js';

// MongoDB store — use dedicated subpath to avoid pulling mongoose:
//   import { MongoIdempotencyStore } from '@classytic/arc/idempotency/mongodb';
export type { MongoIdempotencyStoreOptions } from './stores/mongodb.js';

// Types
export type {
  IdempotencyStore,
  IdempotencyResult,
  IdempotencyLock,
  MemoryIdempotencyStoreOptions,
} from './stores/index.js';
