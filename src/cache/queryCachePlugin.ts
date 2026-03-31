/**
 * QueryCache Fastify Plugin
 *
 * Registers QueryCache on `fastify.queryCache` and wires automatic
 * cache invalidation via CRUD events. Zero config for memory mode.
 *
 * @example
 * ```typescript
 * // Memory mode (default)
 * await fastify.register(queryCachePlugin);
 *
 * // With Redis store
 * await fastify.register(queryCachePlugin, {
 *   store: new RedisCacheStore({ client: redis, prefix: 'arc:qc:' }),
 *   defaults: { staleTime: 30, gcTime: 300 },
 * });
 * ```
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { hasEvents } from "../utils/typeGuards.js";
import type { CacheStore } from "./interface.js";
import { MemoryCacheStore } from "./memory.js";
import { QueryCache } from "./QueryCache.js";

export interface QueryCachePluginOptions {
  /** CacheStore instance. Default: MemoryCacheStore with default options. */
  store?: CacheStore;
  /** Global defaults for staleTime/gcTime (seconds) */
  defaults?: {
    staleTime?: number;
    gcTime?: number;
  };
}

export interface QueryCacheDefaults {
  staleTime: number;
  gcTime: number;
}

/** Cross-resource invalidation rules collected from resource configs */
export interface CrossResourceRule {
  pattern: string;
  tags: string[];
}

declare module "fastify" {
  interface FastifyInstance {
    queryCache: QueryCache;
    queryCacheConfig: QueryCacheDefaults;
    /** Register cross-resource invalidation rules (called by defineResource) */
    registerCacheInvalidationRule?(rule: CrossResourceRule): void;
  }
}

const CRUD_SUFFIXES = new Set(["created", "updated", "deleted"]);

const queryCachePluginImpl: FastifyPluginAsync<QueryCachePluginOptions> = async (
  fastify: FastifyInstance,
  opts: QueryCachePluginOptions = {},
) => {
  const store = opts.store ?? new MemoryCacheStore();
  const queryCache = new QueryCache(store);

  const defaults: QueryCacheDefaults = {
    staleTime: opts.defaults?.staleTime ?? 0,
    gcTime: opts.defaults?.gcTime ?? 60,
  };

  fastify.decorate("queryCache", queryCache);
  fastify.decorate("queryCacheConfig", defaults);

  // Collect cross-resource rules from defineResource calls
  const crossResourceRules: CrossResourceRule[] = [];
  fastify.decorate("registerCacheInvalidationRule", (rule: CrossResourceRule) => {
    crossResourceRules.push(rule);
  });

  // Wire event-driven invalidation after all resources are registered
  fastify.addHook("onReady", async () => {
    if (!hasEvents(fastify)) return;

    // Auto-invalidate on CRUD events (product.created → bump product version)
    await fastify.events.subscribe("*", async (event) => {
      const type = (event as { type: string }).type;
      const dotIdx = type.lastIndexOf(".");
      if (dotIdx === -1) return;

      const suffix = type.slice(dotIdx + 1);
      if (!CRUD_SUFFIXES.has(suffix)) return;

      const resource = type.slice(0, dotIdx);
      await queryCache.bumpResourceVersion(resource);
    });

    // Wire cross-resource tag invalidation
    for (const rule of crossResourceRules) {
      await fastify.events.subscribe(rule.pattern, async () => {
        for (const tag of rule.tags) {
          await queryCache.bumpTagVersion(tag);
        }
      });
    }
  });

  // Cleanup on close
  fastify.addHook("onClose", async () => {
    if ("close" in store && typeof store.close === "function") {
      await store.close();
    }
  });
};

export const queryCachePlugin = fp(queryCachePluginImpl, {
  name: "arc-query-cache",
  fastify: "5.x",
});
