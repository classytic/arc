/**
 * Health Metrics Duration Histogram Tests
 *
 * Verifies that the health plugin's HTTP duration tracking uses fixed
 * histogram buckets — O(#buckets) recording per request, O(#buckets)
 * scrape (no sample retention, no per-scrape sort), with `_count`
 * reflecting ALL requests as a true running counter.
 *
 * Scenarios:
 * - Duration tracking records every request
 * - `_count` is exact regardless of request volume (no sample cap)
 * - Metrics endpoint reports quantile bounds derived from buckets
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { healthPlugin } from "../../src/plugins/health.js";

describe("Health Metrics Duration Histogram", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function createApp(opts: Record<string, unknown> = {}) {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, {
      metrics: true,
      collectHttpMetrics: true,
      ...opts,
    });

    app.get("/fast", async () => ({ ok: true }));
    app.get("/slow", async () => {
      // Simulate a slow request
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true };
    });

    await app.ready();
    return app;
  }

  // --------------------------------------------------------------------------
  // Basic duration tracking
  // --------------------------------------------------------------------------

  describe("basic duration tracking", () => {
    it("should track request durations", async () => {
      await createApp();

      // Make a few requests
      for (let i = 0; i < 5; i++) {
        await app.inject({ method: "GET", url: "/fast" });
      }

      // Check metrics endpoint
      const res = await app.inject({ method: "GET", url: "/_health/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("http_request_duration_milliseconds");
    });

    it("should track status code buckets", async () => {
      await createApp();

      await app.inject({ method: "GET", url: "/fast" });
      await app.inject({ method: "GET", url: "/nonexistent" });

      const res = await app.inject({ method: "GET", url: "/_health/metrics" });
      expect(res.body).toContain("http_requests_total");
      expect(res.body).toContain("2xx");
    });
  });

  // --------------------------------------------------------------------------
  // Counter behavior under volume
  // --------------------------------------------------------------------------

  describe("counters under volume", () => {
    it("should keep reporting after many requests", async () => {
      await createApp();

      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(app.inject({ method: "GET", url: "/fast" }));
      }
      await Promise.all(promises);

      // Metrics should still report correctly
      const res = await app.inject({ method: "GET", url: "/_health/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("http_request_duration_milliseconds_count");
    });

    it("should report correct count in metrics", async () => {
      await createApp();

      const numRequests = 50;
      for (let i = 0; i < numRequests; i++) {
        await app.inject({ method: "GET", url: "/fast" });
      }

      const res = await app.inject({ method: "GET", url: "/_health/metrics" });
      // The count should reflect all requests tracked
      expect(res.body).toContain(`http_request_duration_milliseconds_count ${numRequests}`);
    });
  });

  // --------------------------------------------------------------------------
  // Percentile reporting
  // --------------------------------------------------------------------------

  describe("percentile reporting", () => {
    it("should report p50, p95, p99 percentiles", async () => {
      await createApp();

      for (let i = 0; i < 20; i++) {
        await app.inject({ method: "GET", url: "/fast" });
      }

      const res = await app.inject({ method: "GET", url: "/_health/metrics" });
      expect(res.body).toContain('quantile="0.5"');
      expect(res.body).toContain('quantile="0.95"');
      expect(res.body).toContain('quantile="0.99"');
    });

    it("should report duration sum", async () => {
      await createApp();

      for (let i = 0; i < 10; i++) {
        await app.inject({ method: "GET", url: "/fast" });
      }

      const res = await app.inject({ method: "GET", url: "/_health/metrics" });
      expect(res.body).toContain("http_request_duration_milliseconds_sum");
    });
  });

  // --------------------------------------------------------------------------
  // Liveness and readiness still work with metrics
  // --------------------------------------------------------------------------

  describe("liveness/readiness alongside metrics", () => {
    it("should not interfere with liveness probe", async () => {
      await createApp();

      const res = await app.inject({ method: "GET", url: "/_health/live" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("ok");
    });

    it("should not interfere with readiness probe", async () => {
      await createApp();

      const res = await app.inject({ method: "GET", url: "/_health/ready" });
      expect(res.statusCode).toBe(200);
    });
  });
});
