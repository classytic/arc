export type {
  CacheLogger,
  CacheSetOptions,
  CacheStats,
  CacheStore,
} from "./interface.js";
export {
  buildQueryKey,
  hashParams,
  tagVersionKey,
  versionKey,
} from "./keys.js";
export {
  MemoryCacheStore,
  type MemoryCacheStoreOptions,
} from "./memory.js";

export {
  type CacheEnvelope,
  type CacheResult,
  type CacheStatus,
  QueryCache,
  type QueryCacheConfig,
} from "./QueryCache.js";

export {
  type CrossResourceRule,
  type QueryCacheDefaults,
  type QueryCachePluginOptions,
  queryCachePlugin,
} from "./queryCachePlugin.js";
export {
  type IoredisLike,
  ioredisAsCacheClient,
  type RedisCacheClient,
  RedisCacheStore,
  type RedisCacheStoreOptions,
  type RedisPipeline,
  type UpstashRedisLike,
  upstashAsCacheClient,
} from "./redis.js";
