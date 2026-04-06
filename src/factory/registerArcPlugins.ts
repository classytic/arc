/**
 * Arc plugin registration for createApp.
 *
 * Extracted from createApp steps 7–8:
 * - Arc core (fastify.arc, hooks, registry)
 * - Events (pub/sub transport)
 * - RequestId, Health, Graceful Shutdown
 * - Caching, QueryCache, SSE, Metrics, Versioning
 */

import type { FastifyInstance } from "fastify";
import type { CreateAppOptions } from "./types.js";

type PluginTracker = (name: string, opts?: Record<string, unknown>) => void;

/** Loaded arc plugin modules — returned by registerArcCore, consumed by registerArcPlugins. */
export interface ArcPluginModules {
  requestIdPlugin: import("fastify").FastifyPluginAsync;
  healthPlugin: import("fastify").FastifyPluginAsync;
  gracefulShutdownPlugin: import("fastify").FastifyPluginAsync;
}

/**
 * Register Arc core plugin and event system.
 * Returns loaded plugin modules for registerArcPlugins (avoids duplicate dynamic import).
 */
export async function registerArcCore(
  fastify: FastifyInstance,
  config: CreateAppOptions,
  trackPlugin: PluginTracker,
): Promise<ArcPluginModules> {
  const { arcCorePlugin, requestIdPlugin, healthPlugin, gracefulShutdownPlugin } = await import(
    "../plugins/index.js"
  );

  await fastify.register(arcCorePlugin, {
    emitEvents: config.arcPlugins?.emitEvents !== false,
  });
  trackPlugin("arc-core");

  // Event plugin — provides fastify.events for pub/sub.
  // Without this, arcCorePlugin's CRUD event hooks are no-ops.
  if (config.arcPlugins?.events !== false) {
    const { default: eventPlugin } = await import("../events/eventPlugin.js");
    const eventOpts = typeof config.arcPlugins?.events === "object" ? config.arcPlugins.events : {};
    await fastify.register(eventPlugin, {
      ...eventOpts,
      transport: config.stores?.events, // undefined → defaults to MemoryEventTransport
    });
    trackPlugin("arc-events", eventOpts as Record<string, unknown>);
    fastify.log.debug(`Arc events plugin enabled (transport: ${fastify.events.transportName})`);
  }

  return { requestIdPlugin, healthPlugin, gracefulShutdownPlugin };
}

/**
 * Register opt-in Arc plugins (requestId, health, gracefulShutdown,
 * caching, queryCache, SSE, metrics, versioning).
 *
 * @param modules - Plugin modules loaded by registerArcCore (avoids re-importing)
 */
export async function registerArcPlugins(
  fastify: FastifyInstance,
  config: CreateAppOptions,
  trackPlugin: PluginTracker,
  modules: ArcPluginModules,
): Promise<void> {
  const { requestIdPlugin, healthPlugin, gracefulShutdownPlugin } = modules;

  if (config.arcPlugins?.requestId !== false) {
    await fastify.register(requestIdPlugin);
    trackPlugin("arc-request-id");
  }

  if (config.arcPlugins?.health !== false) {
    await fastify.register(healthPlugin);
    trackPlugin("arc-health");
  }

  if (config.arcPlugins?.gracefulShutdown !== false) {
    await fastify.register(gracefulShutdownPlugin);
    trackPlugin("arc-graceful-shutdown");
  }

  // Caching (opt-in)
  if (config.arcPlugins?.caching) {
    const { default: cachingPlugin } = await import("../plugins/caching.js");
    const opts = config.arcPlugins.caching === true ? {} : config.arcPlugins.caching;
    await fastify.register(cachingPlugin, opts);
    trackPlugin("arc-caching", opts as Record<string, unknown>);
  }

  // QueryCache (opt-in)
  if (config.arcPlugins?.queryCache) {
    const { queryCachePlugin } = await import("../cache/queryCachePlugin.js");
    const opts = config.arcPlugins.queryCache === true ? {} : config.arcPlugins.queryCache;
    const store =
      config.stores?.queryCache ?? new (await import("../cache/memory.js")).MemoryCacheStore();
    await fastify.register(queryCachePlugin, { store, ...opts });
    trackPlugin("arc-query-cache", opts as Record<string, unknown>);
  }

  // SSE (opt-in, requires events)
  if (config.arcPlugins?.sse) {
    if (config.arcPlugins?.events === false) {
      fastify.log.warn("SSE plugin requires events plugin (arcPlugins.events). SSE disabled.");
    } else {
      const { default: ssePlugin } = await import("../plugins/sse.js");
      const opts = config.arcPlugins.sse === true ? {} : config.arcPlugins.sse;
      await fastify.register(ssePlugin, opts);
      trackPlugin("arc-sse", opts as Record<string, unknown>);
    }
  }

  // Metrics (opt-in)
  if (config.arcPlugins?.metrics) {
    const { default: metricsPlugin } = await import("../plugins/metrics.js");
    const opts = config.arcPlugins.metrics === true ? {} : config.arcPlugins.metrics;
    await fastify.register(metricsPlugin, opts);
    trackPlugin("arc-metrics", opts as Record<string, unknown>);
  }

  // Versioning (opt-in)
  if (config.arcPlugins?.versioning) {
    const { default: versioningPlugin } = await import("../plugins/versioning.js");
    await fastify.register(versioningPlugin, config.arcPlugins.versioning);
    trackPlugin(
      "arc-versioning",
      config.arcPlugins.versioning as unknown as Record<string, unknown>,
    );
  }
}
