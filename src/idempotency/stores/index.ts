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
// Redis store TYPES only. The CLASS is reached through the dedicated
// `@classytic/arc/idempotency/redis` subpath, whose entry (`idempotency/redis.ts`)
// re-exports it straight from `./redis.js` — so the `RedisIdempotencyStore`
// value that used to sit here had no importer and is gone as of 2.37.1. The
// main `idempotency/index.ts` barrel deliberately omits it (see the note there),
// and a second path to it here quietly contradicted that.
export type { RedisClient, RedisIdempotencyStoreOptions } from "./redis.js";
