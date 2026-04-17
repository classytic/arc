/**
 * Idempotency Module
 *
 * Duplicate-request protection for safe retries. Pass a `RepositoryLike`
 * directly — arc calls `getOne` / `findOneAndUpdate` / `deleteMany` on it
 * with no wrapper classes in between.
 *
 * @example
 * ```ts
 * // Development (in-memory, default)
 * await fastify.register(idempotencyPlugin, { enabled: true });
 *
 * // Production — repository-backed (mongokit / prismakit / custom)
 * import { Repository } from '@classytic/mongokit';
 * await fastify.register(idempotencyPlugin, {
 *   enabled: true,
 *   repository: new Repository(IdempotencyModel),
 * });
 *
 * // Production with Redis (when you don't have a repository backend)
 * import { RedisIdempotencyStore } from '@classytic/arc/idempotency/redis';
 * await fastify.register(idempotencyPlugin, {
 *   enabled: true,
 *   store: new RedisIdempotencyStore({ client: redis }),
 * });
 * ```
 */

export type { IdempotencyPluginOptions } from "./idempotencyPlugin.js";
// Main plugin
export {
  default as idempotencyPlugin,
  idempotencyPlugin as idempotencyPluginFn,
} from "./idempotencyPlugin.js";
// Types + core (lightweight) stores
export type {
  IdempotencyLock,
  IdempotencyResult,
  IdempotencyStore,
  MemoryIdempotencyStoreOptions,
  RedisClient,
  RedisIdempotencyStoreOptions,
} from "./stores/index.js";
export { createIdempotencyResult, MemoryIdempotencyStore } from "./stores/index.js";

// Redis store — use dedicated subpath to avoid pulling ioredis:
//   import { RedisIdempotencyStore } from '@classytic/arc/idempotency/redis';
