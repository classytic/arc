/**
 * Idempotency Stores
 *
 * Pluggable backends for idempotency keys. The plugin also accepts a
 * `repository` option directly — no wrapper class required. These store
 * exports are for backends that aren't repositories (Redis key-value,
 * in-memory for tests).
 */

export type {
  IdempotencyLock,
  IdempotencyResult,
  IdempotencyStore,
} from "./interface.js";

export { createIdempotencyResult } from "./interface.js";
export type { MemoryIdempotencyStoreOptions } from "./memory.js";
// In-memory store (default, development)
export { MemoryIdempotencyStore } from "./memory.js";
export type { RedisClient, RedisIdempotencyStoreOptions } from "./redis.js";
// Redis store (production, multi-instance)
export { RedisIdempotencyStore } from "./redis.js";
