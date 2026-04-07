/**
 * Metrics Plugin Tests
 *
 * Verifies Prometheus-compatible metrics collection for HTTP requests,
 * CRUD operations, cache hits/misses, and event publish/consume.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Inline mock — avoid importing from src until we build
// ============================================================================

interface MetricEntry {
  name: string;
  type: "counter" | "histogram" | "gauge";
  help: string;
  values: Array<{ labels: Record<string, string>; value: number }>;
}

describe("Metrics Plugin", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Registration
  // ==========================================================================

  it("should register and expose /_metrics endpoint", async () => {
    const { metricsPlugin } = await import("../../src/plugins/metrics.js");
    app = Fastify({ logger: false });
    await app.register(metricsPlugin);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("should allow custom metrics path", async () => {
    const { metricsPlugin } = await import("../../src/plugins/metrics.js");
    app = Fastify({ logger: false });
    await app.register(metricsPlugin, { path: "/custom-metrics" });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/custom-metrics" });
    expect(res.statusCode).toBe(200);
  });

  it("should decorate fastify with metrics collector", async () => {
    const { metricsPlugin } = await import("../../src/plugins/metrics.js");
    app = Fastify({ logger: false });
    await app.register(metricsPlugin);
    await app.ready();

    expect(app.metrics).toBeDefined();
    expect(typeof app.metrics.collect).toBe("function");
    expect(typeof app.metrics.reset).toBe("function");
  });

  // ==========================================================================
  // HTTP Request Metrics
  // ==========================================================================

  describe("HTTP request metrics", () => {
    it("should track request count and duration", async () => {
      const { metricsPlugin } = await import("../../src/plugins/metrics.js");
      app = Fastify({ logger: false });
      await app.register(metricsPlugin);
      app.get("/test", async () => ({ ok: true }));
      await app.ready();

      await app.inject({ method: "GET", url: "/test" });
      await app.inject({ method: "GET", url: "/test" });

      const metrics = app.metrics.collect();
      const requestTotal = metrics.find((m: MetricEntry) => m.name === "arc_http_requests_total");
      expect(requestTotal).toBeDefined();
      expect(requestTotal?.type).toBe("counter");

      // Should have entries with method=GET, route=/test, status=200
      const entry = requestTotal?.values.find(
        (v: { labels: Record<string, string> }) =>
          v.labels.method === "GET" && v.labels.status === "200",
      );
      expect(entry).toBeDefined();
      expect(entry?.value).toBe(2);
    });

    it("should track request duration histogram", async () => {
      const { metricsPlugin } = await import("../../src/plugins/metrics.js");
      app = Fastify({ logger: false });
      await app.register(metricsPlugin);
      app.get("/slow", async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true };
      });
      await app.ready();

      await app.inject({ method: "GET", url: "/slow" });

      const metrics = app.metrics.collect();
      const duration = metrics.find(
        (m: MetricEntry) => m.name === "arc_http_request_duration_seconds",
      );
      expect(duration).toBeDefined();
      expect(duration?.type).toBe("histogram");
    });

    it("should not track metrics endpoint itself", async () => {
      const { metricsPlugin } = await import("../../src/plugins/metrics.js");
      app = Fastify({ logger: false });
      await app.register(metricsPlugin);
      await app.ready();

      await app.inject({ method: "GET", url: "/_metrics" });

      const metrics = app.metrics.collect();
      const requestTotal = metrics.find((m: MetricEntry) => m.name === "arc_http_requests_total");
      // Should be empty or not contain /_metrics route
      if (requestTotal) {
        const metricsRoute = requestTotal.values.find(
          (v: { labels: Record<string, string> }) => v.labels.route === "/_metrics",
        );
        expect(metricsRoute).toBeUndefined();
      }
    });
  });

  // ==========================================================================
  // CRUD Operation Metrics
  // ==========================================================================

  describe("CRUD operation metrics", () => {
    it("should expose increment/observe methods for resource operations", async () => {
      const { metricsPlugin } = await import("../../src/plugins/metrics.js");
      app = Fastify({ logger: false });
      await app.register(metricsPlugin);
      await app.ready();

      // Simulate CRUD metric recording
      app.metrics.recordOperation("product", "create", 201, 15);
      app.metrics.recordOperation("product", "list", 200, 5);
      app.metrics.recordOperation("product", "list", 200, 3);

      const metrics = app.metrics.collect();
      const opTotal = metrics.find((m: MetricEntry) => m.name === "arc_crud_operations_total");
      expect(opTotal).toBeDefined();

      const createEntry = opTotal?.values.find(
        (v: { labels: Record<string, string> }) =>
          v.labels.resource === "product" && v.labels.operation === "create",
      );
      expect(createEntry).toBeDefined();
      expect(createEntry?.value).toBe(1);

      const listEntry = opTotal?.values.find(
        (v: { labels: Record<string, string> }) =>
          v.labels.resource === "product" && v.labels.operation === "list",
      );
      expect(listEntry?.value).toBe(2);
    });
  });

  // ==========================================================================
  // Cache Metrics
  // ==========================================================================

  describe("Cache metrics", () => {
    it("should track cache hits and misses", async () => {
      const { metricsPlugin } = await import("../../src/plugins/metrics.js");
      app = Fastify({ logger: false });
      await app.register(metricsPlugin);
      await app.ready();

      app.metrics.recordCacheHit("product");
      app.metrics.recordCacheHit("product");
      app.metrics.recordCacheMiss("product");

      const metrics = app.metrics.collect();
      const cacheHits = metrics.find((m: MetricEntry) => m.name === "arc_cache_hits_total");
      const cacheMisses = metrics.find((m: MetricEntry) => m.name === "arc_cache_misses_total");

      expect(cacheHits).toBeDefined();
      expect(cacheMisses).toBeDefined();

      const hitEntry = cacheHits?.values.find(
        (v: { labels: Record<string, string> }) => v.labels.resource === "product",
      );
      expect(hitEntry?.value).toBe(2);

      const missEntry = cacheMisses?.values.find(
        (v: { labels: Record<string, string> }) => v.labels.resource === "product",
      );
      expect(missEntry?.value).toBe(1);
    });
  });

  // ==========================================================================
  // Event Metrics
  // ==========================================================================

  describe("Event metrics", () => {
    it("should track event publish and consume counts", async () => {
      const { metricsPlugin } = await import("../../src/plugins/metrics.js");
      app = Fastify({ logger: false });
      await app.register(metricsPlugin);
      await app.ready();

      app.metrics.recordEventPublish("product.created");
      app.metrics.recordEventPublish("product.created");
      app.metrics.recordEventConsume("product.created");

      const metrics = app.metrics.collect();
      const published = metrics.find((m: MetricEntry) => m.name === "arc_events_published_total");
      const consumed = metrics.find((m: MetricEntry) => m.name === "arc_events_consumed_total");

      expect(published).toBeDefined();
      expect(consumed).toBeDefined();

      const pubEntry = published?.values.find(
        (v: { labels: Record<string, string> }) => v.labels.event_type === "product.created",
      );
      expect(pubEntry?.value).toBe(2);
    });
  });

  // ==========================================================================
  // Circuit Breaker Metrics
  // ==========================================================================

  describe("Circuit breaker metrics", () => {
    it("should track circuit breaker state changes", async () => {
      const { metricsPlugin } = await import("../../src/plugins/metrics.js");
      app = Fastify({ logger: false });
      await app.register(metricsPlugin);
      await app.ready();

      app.metrics.recordCircuitBreakerState("catalog-service", "open");
      app.metrics.recordCircuitBreakerState("catalog-service", "closed");

      const metrics = app.metrics.collect();
      const cbState = metrics.find((m: MetricEntry) => m.name === "arc_circuit_breaker_state");
      expect(cbState).toBeDefined();
    });
  });

  // ==========================================================================
  // Prometheus Format
  // ==========================================================================

  describe("Prometheus text format", () => {
    it("should render metrics in Prometheus exposition format", async () => {
      const { metricsPlugin } = await import("../../src/plugins/metrics.js");
      app = Fastify({ logger: false });
      await app.register(metricsPlugin);
      app.get("/test", async () => ({ ok: true }));
      await app.ready();

      await app.inject({ method: "GET", url: "/test" });

      const res = await app.inject({ method: "GET", url: "/_metrics" });
      const body = res.body;

      // Should contain HELP and TYPE directives
      expect(body).toContain("# HELP arc_http_requests_total");
      expect(body).toContain("# TYPE arc_http_requests_total counter");
      // Should contain label format
      expect(body).toMatch(/arc_http_requests_total\{.*method="GET".*\}/);
    });
  });

  // ==========================================================================
  // Reset
  // ==========================================================================

  describe("Reset", () => {
    it("should clear all metrics on reset", async () => {
      const { metricsPlugin } = await import("../../src/plugins/metrics.js");
      app = Fastify({ logger: false });
      await app.register(metricsPlugin);
      app.get("/test", async () => ({ ok: true }));
      await app.ready();

      await app.inject({ method: "GET", url: "/test" });
      app.metrics.reset();

      const metrics = app.metrics.collect();
      const total = metrics.reduce((sum: number, m: MetricEntry) => sum + m.values.length, 0);
      expect(total).toBe(0);
    });
  });
});
