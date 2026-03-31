/**
 * Metrics Plugin
 *
 * Lightweight, zero-dependency metrics collector with Prometheus text format.
 * Tracks HTTP requests, CRUD operations, cache, events, and circuit breakers.
 *
 * @example
 * import { metricsPlugin } from '@classytic/arc/plugins';
 *
 * await fastify.register(metricsPlugin);
 * // GET /_metrics → Prometheus text format
 *
 * @example
 * // Custom path + hook into external collector
 * await fastify.register(metricsPlugin, {
 *   path: '/metrics',
 *   onCollect: (metrics) => pushToOTLP(metrics),
 * });
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

// ============================================================================
// Types
// ============================================================================

export interface MetricsOptions {
  /** Endpoint path (default: '/_metrics') */
  path?: string;
  /** Prefix for all metric names (default: 'arc') */
  prefix?: string;
  /** Called after metrics are collected (for OTLP push, etc.) */
  onCollect?: (metrics: MetricEntry[]) => void;
}

export interface MetricEntry {
  name: string;
  type: "counter" | "histogram" | "gauge";
  help: string;
  values: Array<{ labels: Record<string, string>; value: number }>;
}

export interface MetricsCollector {
  /** Get all metrics as structured data */
  collect(): MetricEntry[];
  /** Reset all metrics */
  reset(): void;
  /** Record a CRUD operation */
  recordOperation(resource: string, operation: string, status: number, durationMs: number): void;
  /** Record a cache hit */
  recordCacheHit(resource: string): void;
  /** Record a cache miss */
  recordCacheMiss(resource: string): void;
  /** Record an event publish */
  recordEventPublish(eventType: string): void;
  /** Record an event consume */
  recordEventConsume(eventType: string): void;
  /** Record a circuit breaker state change */
  recordCircuitBreakerState(service: string, state: string): void;
}

declare module "fastify" {
  interface FastifyInstance {
    metrics: MetricsCollector;
  }
}

// ============================================================================
// Counter — simple label-keyed counter
// ============================================================================

class Counter {
  private data = new Map<string, { labels: Record<string, string>; value: number }>();

  inc(labels: Record<string, string>, value = 1): void {
    const key = labelKey(labels);
    const existing = this.data.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.data.set(key, { labels: { ...labels }, value });
    }
  }

  values(): Array<{ labels: Record<string, string>; value: number }> {
    return [...this.data.values()];
  }

  reset(): void {
    this.data.clear();
  }
}

// ============================================================================
// Histogram — lightweight bucket-less histogram (sum + count)
// ============================================================================

class Histogram {
  private data = new Map<string, { labels: Record<string, string>; sum: number; count: number }>();

  observe(labels: Record<string, string>, value: number): void {
    const key = labelKey(labels);
    const existing = this.data.get(key);
    if (existing) {
      existing.sum += value;
      existing.count += 1;
    } else {
      this.data.set(key, { labels: { ...labels }, sum: value, count: 1 });
    }
  }

  values(): Array<{ labels: Record<string, string>; value: number }> {
    return [...this.data.values()].flatMap(({ labels, sum, count }) => [
      { labels: { ...labels, le: "sum" }, value: sum },
      { labels: { ...labels, le: "count" }, value: count },
    ]);
  }

  reset(): void {
    this.data.clear();
  }
}

// ============================================================================
// Gauge — last-value metric
// ============================================================================

class Gauge {
  private data = new Map<string, { labels: Record<string, string>; value: number }>();

  set(labels: Record<string, string>, value: number): void {
    const key = labelKey(labels);
    this.data.set(key, { labels: { ...labels }, value });
  }

  values(): Array<{ labels: Record<string, string>; value: number }> {
    return [...this.data.values()];
  }

  reset(): void {
    this.data.clear();
  }
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

// ============================================================================
// Prometheus text format renderer
// ============================================================================

function toPrometheusText(metrics: MetricEntry[]): string {
  const lines: string[] = [];
  for (const m of metrics) {
    lines.push(`# HELP ${m.name} ${m.help}`);
    lines.push(`# TYPE ${m.name} ${m.type}`);
    for (const v of m.values) {
      const labelStr = Object.entries(v.labels)
        .map(([k, val]) => `${k}="${val}"`)
        .join(",");
      lines.push(`${m.name}{${labelStr}} ${v.value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ============================================================================
// Plugin
// ============================================================================

const metricsPlugin: FastifyPluginAsync<MetricsOptions> = async (
  fastify: FastifyInstance,
  opts: MetricsOptions = {},
) => {
  const path = opts.path ?? "/_metrics";
  const prefix = opts.prefix ?? "arc";

  // Counters
  const httpRequestsTotal = new Counter();
  const crudOpsTotal = new Counter();
  const cacheHitsTotal = new Counter();
  const cacheMissesTotal = new Counter();
  const eventsPublishedTotal = new Counter();
  const eventsConsumedTotal = new Counter();

  // Histograms
  const httpDuration = new Histogram();
  const crudDuration = new Histogram();

  // Gauges
  const circuitBreakerState = new Gauge();

  const collector: MetricsCollector = {
    collect(): MetricEntry[] {
      const metrics: MetricEntry[] = [
        {
          name: `${prefix}_http_requests_total`,
          type: "counter",
          help: "Total HTTP requests",
          values: httpRequestsTotal.values(),
        },
        {
          name: `${prefix}_http_request_duration_seconds`,
          type: "histogram",
          help: "HTTP request duration in seconds",
          values: httpDuration.values(),
        },
        {
          name: `${prefix}_crud_operations_total`,
          type: "counter",
          help: "Total CRUD operations by resource",
          values: crudOpsTotal.values(),
        },
        {
          name: `${prefix}_crud_operation_duration_seconds`,
          type: "histogram",
          help: "CRUD operation duration in seconds",
          values: crudDuration.values(),
        },
        {
          name: `${prefix}_cache_hits_total`,
          type: "counter",
          help: "Total cache hits by resource",
          values: cacheHitsTotal.values(),
        },
        {
          name: `${prefix}_cache_misses_total`,
          type: "counter",
          help: "Total cache misses by resource",
          values: cacheMissesTotal.values(),
        },
        {
          name: `${prefix}_events_published_total`,
          type: "counter",
          help: "Total events published",
          values: eventsPublishedTotal.values(),
        },
        {
          name: `${prefix}_events_consumed_total`,
          type: "counter",
          help: "Total events consumed",
          values: eventsConsumedTotal.values(),
        },
        {
          name: `${prefix}_circuit_breaker_state`,
          type: "gauge",
          help: "Circuit breaker state (0=closed, 1=open, 2=half-open)",
          values: circuitBreakerState.values(),
        },
      ];
      opts.onCollect?.(metrics);
      return metrics;
    },

    reset(): void {
      httpRequestsTotal.reset();
      httpDuration.reset();
      crudOpsTotal.reset();
      crudDuration.reset();
      cacheHitsTotal.reset();
      cacheMissesTotal.reset();
      eventsPublishedTotal.reset();
      eventsConsumedTotal.reset();
      circuitBreakerState.reset();
    },

    recordOperation(resource: string, operation: string, status: number, durationMs: number): void {
      crudOpsTotal.inc({ resource, operation, status: String(status) });
      crudDuration.observe({ resource, operation }, durationMs / 1000);
    },

    recordCacheHit(resource: string): void {
      cacheHitsTotal.inc({ resource });
    },

    recordCacheMiss(resource: string): void {
      cacheMissesTotal.inc({ resource });
    },

    recordEventPublish(eventType: string): void {
      eventsPublishedTotal.inc({ event_type: eventType });
    },

    recordEventConsume(eventType: string): void {
      eventsConsumedTotal.inc({ event_type: eventType });
    },

    recordCircuitBreakerState(service: string, state: string): void {
      const stateValue = state === "open" ? 1 : state === "half-open" ? 2 : 0;
      circuitBreakerState.set({ service }, stateValue);
    },
  };

  fastify.decorate("metrics", collector);

  // Auto-track HTTP requests
  fastify.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip metrics endpoint
    if (request.url === path) return;

    const duration = reply.elapsedTime / 1000; // ms → seconds
    const labels = {
      method: request.method,
      route: request.routeOptions?.url ?? request.url,
      status: String(reply.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpDuration.observe(labels, duration);
  });

  // Expose metrics endpoint
  fastify.get(path, async (_request, reply) => {
    const metrics = collector.collect();
    const text = toPrometheusText(metrics);
    return reply.type("text/plain; charset=utf-8").send(text);
  });
};

export default fp(metricsPlugin, {
  name: "arc-metrics",
  fastify: "5.x",
});

export { metricsPlugin };
