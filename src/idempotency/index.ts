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

export type { IdempotencyPluginOptions } from "./idempotencyPlugin.js";
// Main plugin
export {
  default as idempotencyPlugin,
  idempotencyPlugin as idempotencyPluginFn,
} from "./idempotencyPlugin.js";
// Types
export type {
  IdempotencyLock,
  IdempotencyResult,
  IdempotencyStore,
  MemoryIdempotencyStoreOptions,
} from "./stores/index.js";
// Core store (lightweight, no external deps)
export { createIdempotencyResult, MemoryIdempotencyStore } from "./stores/index.js";

// MongoDB store — use dedicated subpath to avoid pulling mongoose:
//   import { MongoIdempotencyStore } from '@classytic/arc/idempotency/mongodb';
export type { MongoIdempotencyStoreOptions } from "./stores/mongodb.js";
// Redis store — use dedicated subpath to avoid pulling ioredis:
//   import { RedisIdempotencyStore } from '@classytic/arc/idempotency/redis';
export type { RedisClient, RedisIdempotencyStoreOptions } from "./stores/redis.js";
