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
  // Arc closes ONLY the store it built — a host-supplied store may be shared
  // with other apps in the process. Same rule as the events transport.
  const ownsStore = opts.store === undefined;
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

    /**
     * Auto-invalidate on CRUD events — `product.created` bumps `product`, and
     * `catalog:category.created` bumps BOTH `catalog:category` and `category`.
     *
     * ## Why the namespace has to be stripped
     *
     * This derived the resource as "everything before the last dot", which is right for
     * an arc-native event (`product.created`) and wrong for every NAMESPACED one. Each
     * `@classytic/*` kernel publishes `<domain>:<entity>.<verb>` —
     * `catalog:category.created`, `revenue:payment.verified`,
     * `access:entitlement.granted` — so the resource came out as `catalog:category` and
     * the version bumped at `arc:ver:catalog:category`.
     *
     * Readers use the arc RESOURCE NAME: `buildQueryKey(resource, …)` folds in
     * `getResourceVersion("category")`, i.e. `arc:ver:category`. Bump and read
     * therefore used different keys and **auto-invalidation never fired for any
     * kernel-backed resource** — no error, no warning, just caches serving stale data
     * for a full `staleTime`. It was invisible precisely because the feature looks
     * wired: the plugin is registered, events flow, a version does get bumped.
     *
     * ## Both names are bumped, on purpose
     *
     * Two namespaces could each own an `<entity>` of the same name (`catalog:category`
     * and a hypothetical `cms:category`), so stripping is ambiguous. The asymmetry
     * decides it: **over-invalidation costs a cache miss, under-invalidation serves
     * wrong data.** Bumping both the qualified and the bare name means an unrelated
     * namespace can at worst force an extra reload, and never a stale read. That is the
     * same reasoning applied everywhere else here — a permissive default is only
     * acceptable when the failure it causes is loud and cheap.
     *
     * By the same argument the split is UNCONDITIONAL: any `:` in the qualified
     * name yields a bare candidate, including when the prefix itself contains a
     * dot (`some.thing:entity` bumps `entity` too). Narrowing that would remove
     * invalidations, which is the one direction that can serve wrong data.
     */
    await fastify.events.subscribe("*", async (event) => {
      const type = (event as { type: string }).type;
      const dotIdx = type.lastIndexOf(".");
      if (dotIdx === -1) return;

      const suffix = type.slice(dotIdx + 1);
      if (!CRUD_SUFFIXES.has(suffix)) return;

      const qualified = type.slice(0, dotIdx);
      await queryCache.bumpResourceVersion(qualified);

      const colonIdx = qualified.lastIndexOf(":");
      if (colonIdx === -1) return;
      const bare = qualified.slice(colonIdx + 1);
      // Guard against `ns:` with nothing after it, and against re-bumping an identical name.
      if (bare.length === 0 || bare === qualified) return;
      await queryCache.bumpResourceVersion(bare);
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
    if (!ownsStore) return; // host-supplied — the host closes it
    if ("close" in store && typeof store.close === "function") {
      await store.close();
    }
  });
};

export const queryCachePlugin = fp(queryCachePluginImpl, {
  name: "arc-query-cache",
  fastify: "5.x",
});
