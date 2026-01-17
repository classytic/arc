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
 * import { RedisIdempotencyStore } from '@classytic/arc/idempotency';
 * await fastify.register(idempotencyPlugin, {
 *   enabled: true,
 *   store: new RedisIdempotencyStore({ client: redis }),
 * });
 *
 * // Production with MongoDB (multi-instance)
 * import { MongoIdempotencyStore } from '@classytic/arc/idempotency';
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

// Stores - In-memory (development)
export {
  MemoryIdempotencyStore,
  createIdempotencyResult,
} from './stores/index.js';

// Stores - Redis (production)
export { RedisIdempotencyStore } from './stores/index.js';
export type { RedisIdempotencyStoreOptions, RedisClient } from './stores/index.js';

// Stores - MongoDB (production)
export { MongoIdempotencyStore } from './stores/index.js';
export type { MongoIdempotencyStoreOptions } from './stores/index.js';

// Types
export type {
  IdempotencyStore,
  IdempotencyResult,
  IdempotencyLock,
  MemoryIdempotencyStoreOptions,
} from './stores/index.js';
