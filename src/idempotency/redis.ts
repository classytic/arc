/**
 * Redis Idempotency Store — Dedicated Entry Point
 *
 * Import from '@classytic/arc/idempotency/redis' to avoid pulling ioredis
 * into your bundle when using in-memory idempotency store.
 *
 * @example
 * import { RedisIdempotencyStore } from '@classytic/arc/idempotency/redis';
 * import Redis from 'ioredis';
 *
 * const store = new RedisIdempotencyStore({ client: new Redis() });
 */
export { RedisIdempotencyStore } from './stores/redis.js';
export type { RedisIdempotencyStoreOptions, RedisClient } from './stores/redis.js';
