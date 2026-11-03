/**
 * One `fastify.sseStats()` gauge for EVERY SSE surface on an instance.
 *
 * `ssePlugin`, `realtimePlugin`, a replay hub and a host's own `openSseStream`
 * routes each register a provider; the decorator sums them. Before this lived
 * here it was private to `ssePlugin`, so a custom stream route was invisible to
 * the one gauge an operator reads.
 *
 * BOOT-TIME ONLY: the first registration decorates the instance, and Fastify
 * refuses `decorate` after `ready()` (`FST_ERR_DEC_AFTER_START`). Register on
 * the root instance or inside an `fp()`-wrapped plugin (a plain encapsulated
 * plugin would scope the decorator to itself), never lazily per request.
 */

import type { FastifyInstance } from "fastify";
import type { SseStream } from "./sseStream.js";

/** Live connection gauge, summed across every registered SSE surface on the instance. */
export interface SSEStats {
  /** Open SSE connections. */
  connections: number;
  /** Distinct `connectionKey`s indexed (0 without `audience`). */
  keys: number;
}

declare module "fastify" {
  interface FastifyInstance {
    sseStats: () => SSEStats;
  }
}

/** Per-instance stats providers behind one `sseStats` decorator. */
const statsProviders = new WeakMap<() => SSEStats, Set<() => SSEStats>>();

/**
 * Add a provider to `fastify.sseStats()`, decorating the instance on first use.
 * Call at boot (see the module note: decorating after `ready` throws).
 */
export function registerSseStats(fastify: FastifyInstance, provider: () => SSEStats): void {
  if (fastify.hasDecorator("sseStats")) {
    statsProviders.get(fastify.sseStats)?.add(provider);
    return;
  }
  const providers = new Set([provider]);
  const sseStats = (): SSEStats => {
    const total: SSEStats = { connections: 0, keys: 0 };
    for (const p of providers) {
      const s = p();
      total.connections += s.connections;
      total.keys += s.keys;
    }
    return total;
  };
  statsProviders.set(sseStats, providers);
  fastify.decorate("sseStats", sseStats);
}

/** Counts the open streams of a host's own `openSseStream` routes. */
export interface SseConnectionGauge {
  /** Count `stream` until it closes. Call right after `openSseStream`; repeat calls are no-ops. */
  track(stream: SseStream): void;
  /** Streams currently tracked. */
  size(): number;
}

/**
 * A connection gauge for custom `openSseStream` routes, registered into
 * `fastify.sseStats()`. Create it at boot (same rule as {@link registerSseStats}),
 * then `gauge.track(stream)` in the route handler.
 *
 * ```ts
 * const gauge = createSseConnectionGauge(app);
 * app.get('/alerts/stream', async (req, reply) => {
 *   const stream = openSseStream(req, reply);
 *   gauge.track(stream);
 * });
 * ```
 */
export function createSseConnectionGauge(fastify: FastifyInstance): SseConnectionGauge {
  const open = new Set<SseStream>();
  registerSseStats(fastify, () => ({ connections: open.size, keys: 0 }));
  return {
    track(stream) {
      if (open.has(stream)) return;
      open.add(stream);
      stream.onCleanup(() => open.delete(stream));
    },
    size: () => open.size,
  };
}
