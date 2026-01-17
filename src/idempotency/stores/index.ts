/**
 * Idempotency Stores
 *
 * Pluggable storage backends for idempotency key management.
 *
 * Available stores:
 * - MemoryIdempotencyStore: In-memory (development, single-instance)
 * - RedisIdempotencyStore: Redis (production, multi-instance)
 * - MongoIdempotencyStore: MongoDB (production, multi-instance)
 */

export type {
  IdempotencyResult,
  IdempotencyLock,
  IdempotencyStore,
} from './interface.js';

export { createIdempotencyResult } from './interface.js';

// In-memory store (default, development)
export { MemoryIdempotencyStore } from './memory.js';
export type { MemoryIdempotencyStoreOptions } from './memory.js';

// Redis store (production, multi-instance)
export { RedisIdempotencyStore } from './redis.js';
export type { RedisIdempotencyStoreOptions, RedisClient } from './redis.js';

// MongoDB store (production, multi-instance)
export { MongoIdempotencyStore } from './mongodb.js';
export type { MongoIdempotencyStoreOptions } from './mongodb.js';
