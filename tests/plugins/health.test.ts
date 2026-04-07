/**
 * Health Plugin Tests
 *
 * Tests liveness probes, readiness probes with dependency checks,
 * metrics endpoint, and failure scenarios.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import healthPlugin from "../../src/plugins/health.js";

describe("Health Plugin — Liveness Probe", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should return 200 with status ok on GET /_health/live", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/live" });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  it("should include version when provided", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, { version: "2.4.0" });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/live" });
    const body = JSON.parse(res.body);
    expect(body.version).toBe("2.4.0");
  });

  it("should use custom prefix", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, { prefix: "/api/health" });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health/live" });
    expect(res.statusCode).toBe(200);

    // Default prefix should not work
    const defaultRes = await app.inject({ method: "GET", url: "/_health/live" });
    expect(defaultRes.statusCode).toBe(404);
  });
});

describe("Health Plugin — Readiness Probe", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should return ready when no checks configured", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/ready" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ready");
  });

  it("should return ready when all checks pass", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, {
      checks: [
        { name: "database", check: () => true },
        { name: "cache", check: async () => true },
      ],
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/ready" });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.status).toBe("ready");
    expect(body.checks).toHaveLength(2);
    expect(body.checks[0].healthy).toBe(true);
    expect(body.checks[1].healthy).toBe(true);
  });

  it("should return 503 when critical check fails", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, {
      checks: [
        { name: "database", check: () => false, critical: true },
        { name: "cache", check: () => true, critical: false },
      ],
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/ready" });
    expect(res.statusCode).toBe(503);

    const body = JSON.parse(res.body);
    expect(body.status).toBe("not_ready");
    expect(body.checks.find((c: any) => c.name === "database").healthy).toBe(false);
    expect(body.checks.find((c: any) => c.name === "cache").healthy).toBe(true);
  });

  it("should return ready when non-critical check fails", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, {
      checks: [
        { name: "database", check: () => true, critical: true },
        { name: "email-service", check: () => false, critical: false },
      ],
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/ready" });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.status).toBe("ready");
    // Non-critical check failed but doesn't affect readiness
    expect(body.checks.find((c: any) => c.name === "email-service").healthy).toBe(false);
  });

  it("should handle check that throws as unhealthy", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, {
      checks: [
        {
          name: "flaky-service",
          check: () => {
            throw new Error("Connection refused");
          },
          critical: true,
        },
      ],
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/ready" });
    expect(res.statusCode).toBe(503);

    const body = JSON.parse(res.body);
    expect(body.checks[0].healthy).toBe(false);
  });

  it("should include duration for each check", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, {
      checks: [
        {
          name: "slow-check",
          check: async () => {
            await new Promise((r) => setTimeout(r, 20));
            return true;
          },
        },
      ],
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/ready" });
    const body = JSON.parse(res.body);

    expect(body.checks[0].duration).toBeGreaterThanOrEqual(0);
    expect(typeof body.checks[0].duration).toBe("number");
  });
});

describe("Health Plugin — Metrics Endpoint", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should not expose metrics endpoint when metrics: false", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, { metrics: false });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/metrics" });
    expect(res.statusCode).toBe(404);
  });

  it("should expose Prometheus metrics when metrics: true", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, { metrics: true });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");

    // Should contain standard process metrics
    expect(res.body).toContain("process_uptime_seconds");
    expect(res.body).toContain("process_memory_heap_bytes");
    expect(res.body).toContain("process_memory_rss_bytes");
    expect(res.body).toContain("process_cpu_user_microseconds");
  });

  it("should use custom metrics collector when provided", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, {
      metrics: true,
      metricsCollector: async () => {
        return "# HELP custom_metric A custom metric\ncustom_metric 42\n";
      },
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_health/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("custom_metric 42");
    // Should NOT contain default metrics (custom collector overrides)
    expect(res.body).not.toContain("process_uptime_seconds");
  });

  it("should collect HTTP request metrics when enabled", async () => {
    app = Fastify({ logger: false });
    await app.register(healthPlugin, { metrics: true, collectHttpMetrics: true });

    app.get("/test", async () => ({ ok: true }));
    await app.ready();

    // Make some requests to generate metrics
    await app.inject({ method: "GET", url: "/test" });
    await app.inject({ method: "GET", url: "/test" });
    await app.inject({ method: "GET", url: "/test" });

    const res = await app.inject({ method: "GET", url: "/_health/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("http_requests_total");
  });
});

describe("Health Plugin — K8s Integration Pattern", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should work with typical K8s probe configuration", async () => {
    let dbHealthy = true;

    app = Fastify({ logger: false });
    await app.register(healthPlugin, {
      prefix: "/_health",
      version: "2.4.0",
      checks: [
        {
          name: "mongodb",
          check: () => dbHealthy,
          critical: true,
          timeout: 3000,
        },
        {
          name: "redis",
          check: async () => true,
          critical: false,
          timeout: 2000,
        },
      ],
    });
    await app.ready();

    // Liveness — always 200 (process is alive)
    const live = await app.inject({ method: "GET", url: "/_health/live" });
    expect(live.statusCode).toBe(200);

    // Readiness — 200 when healthy
    const ready = await app.inject({ method: "GET", url: "/_health/ready" });
    expect(ready.statusCode).toBe(200);

    // Simulate DB failure
    dbHealthy = false;

    // Readiness — 503 when critical check fails
    const notReady = await app.inject({ method: "GET", url: "/_health/ready" });
    expect(notReady.statusCode).toBe(503);

    // Liveness — still 200 (process is alive even if DB is down)
    const stillLive = await app.inject({ method: "GET", url: "/_health/live" });
    expect(stillLive.statusCode).toBe(200);
  });
});
