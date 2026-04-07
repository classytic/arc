/**
 * Metrics Plugin — createApp Integration Suite
 *
 * Verifies end-to-end: createApp → metricsPlugin → /_metrics endpoint,
 * auto HTTP tracking, programmatic recording, custom config, and opt-out.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

describe("createApp — metrics plugin", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Registration
  // ==========================================================================

  describe("registration", () => {
    it("registers metrics when arcPlugins.metrics is true", async () => {
      app = await createApp({ preset: "testing", auth: false, arcPlugins: { metrics: true } });

      expect(app.metrics).toBeDefined();
      expect(typeof app.metrics.collect).toBe("function");
      expect(typeof app.metrics.reset).toBe("function");
      expect(typeof app.metrics.recordOperation).toBe("function");
    });

    it("does NOT register metrics when absent", async () => {
      app = await createApp({ preset: "testing", auth: false });

      expect(app.hasDecorator("metrics")).toBe(false);
    });

    it("does NOT register metrics when explicitly false", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { metrics: false as unknown as boolean },
      });

      expect(app.hasDecorator("metrics")).toBe(false);
    });
  });

  // ==========================================================================
  // /_metrics endpoint
  // ==========================================================================

  describe("/_metrics endpoint", () => {
    it("responds 200 with Prometheus text format", async () => {
      app = await createApp({ preset: "testing", auth: false, arcPlugins: { metrics: true } });

      const res = await app.inject({ method: "GET", url: "/_metrics" });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toContain("# HELP arc_http_requests_total");
      expect(res.body).toContain("# TYPE arc_http_requests_total counter");
    });

    it("uses custom path when configured", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { metrics: { path: "/observability/metrics" } },
      });

      const res = await app.inject({ method: "GET", url: "/observability/metrics" });
      expect(res.statusCode).toBe(200);

      const notFound = await app.inject({ method: "GET", url: "/_metrics" });
      expect(notFound.statusCode).toBe(404);
    });

    it("uses custom prefix for metric names", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { metrics: { prefix: "myapp" } },
      });

      const res = await app.inject({ method: "GET", url: "/_metrics" });
      expect(res.body).toContain("myapp_http_requests_total");
      expect(res.body).not.toContain("arc_http_requests_total");
    });
  });

  // ==========================================================================
  // Auto HTTP tracking
  // ==========================================================================

  describe("auto HTTP request tracking", () => {
    it("tracks request count after hitting a route", async () => {
      app = await createApp({ preset: "testing", auth: false, arcPlugins: { metrics: true } });
      app.get("/ping", async () => ({ pong: true }));

      await app.inject({ method: "GET", url: "/ping" });
      await app.inject({ method: "GET", url: "/ping" });

      const metrics = app.metrics.collect();
      const total = metrics.find((m) => m.name === "arc_http_requests_total");
      expect(total).toBeDefined();

      const pingEntry = total?.values.find(
        (v) => v.labels.method === "GET" && v.labels.status === "200",
      );
      expect(pingEntry).toBeDefined();
      expect(pingEntry?.value).toBe(2);
    });

    it("tracks request duration as histogram", async () => {
      app = await createApp({ preset: "testing", auth: false, arcPlugins: { metrics: true } });
      app.get("/slow", async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true };
      });

      await app.inject({ method: "GET", url: "/slow" });

      const metrics = app.metrics.collect();
      const duration = metrics.find((m) => m.name === "arc_http_request_duration_seconds");
      expect(duration).toBeDefined();
      expect(duration?.values.length).toBeGreaterThan(0);
    });

    it("does NOT track /_metrics endpoint itself", async () => {
      app = await createApp({ preset: "testing", auth: false, arcPlugins: { metrics: true } });

      await app.inject({ method: "GET", url: "/_metrics" });
      await app.inject({ method: "GET", url: "/_metrics" });

      const metrics = app.metrics.collect();
      const total = metrics.find((m) => m.name === "arc_http_requests_total");
      if (total) {
        const metricsRoute = total.values.find((v) => v.labels.route === "/_metrics");
        expect(metricsRoute).toBeUndefined();
      }
    });

    it("tracks different status codes separately", async () => {
      app = await createApp({ preset: "testing", auth: false, arcPlugins: { metrics: true } });
      app.get("/ok", async () => ({ ok: true }));
      app.get("/fail", async (_req, reply) => reply.code(500).send({ error: "boom" }));

      await app.inject({ method: "GET", url: "/ok" });
      await app.inject({ method: "GET", url: "/fail" });

      const metrics = app.metrics.collect();
      const total = metrics.find((m) => m.name === "arc_http_requests_total");

      const ok = total?.values.find((v) => v.labels.status === "200");
      const fail = total?.values.find((v) => v.labels.status === "500");
      expect(ok).toBeDefined();
      expect(fail).toBeDefined();
    });
  });

  // ==========================================================================
  // Programmatic recording
  // ==========================================================================

  describe("programmatic recording", () => {
    it("records CRUD operations", async () => {
      app = await createApp({ preset: "testing", auth: false, arcPlugins: { metrics: true } });

      app.metrics.recordOperation("product", "create", 201, 15);
      app.metrics.recordOperation("product", "list", 200, 5);

      const metrics = app.metrics.collect();
      const ops = metrics.find((m) => m.name === "arc_crud_operations_total");
      expect(ops).toBeDefined();

      const createEntry = ops?.values.find(
        (v) => v.labels.resource === "product" && v.labels.operation === "create",
      );
      expect(createEntry?.value).toBe(1);
    });

    it("records cache hits and misses", async () => {
      app = await createApp({ preset: "testing", auth: false, arcPlugins: { metrics: true } });

      app.metrics.recordCacheHit("product");
      app.metrics.recordCacheHit("product");
      app.metrics.recordCacheMiss("product");

      const metrics = app.metrics.collect();
      const hits = metrics.find((m) => m.name === "arc_cache_hits_total");
      const misses = metrics.find((m) => m.name === "arc_cache_misses_total");

      expect(hits?.values[0].value).toBe(2);
      expect(misses?.values[0].value).toBe(1);
    });

    it("records event publish/consume", async () => {
      app = await createApp({ preset: "testing", auth: false, arcPlugins: { metrics: true } });

      app.metrics.recordEventPublish("order.created");
      app.metrics.recordEventConsume("order.created");

      const metrics = app.metrics.collect();
      const pub = metrics.find((m) => m.name === "arc_events_published_total");
      expect(pub?.values[0].value).toBe(1);
    });

    it("reset clears all metrics", async () => {
      app = await createApp({ preset: "testing", auth: false, arcPlugins: { metrics: true } });
      app.get("/test", async () => ({ ok: true }));

      await app.inject({ method: "GET", url: "/test" });
      app.metrics.recordOperation("x", "create", 201, 1);

      app.metrics.reset();

      const metrics = app.metrics.collect();
      const totalValues = metrics.reduce((sum, m) => sum + m.values.length, 0);
      expect(totalValues).toBe(0);
    });
  });
});
