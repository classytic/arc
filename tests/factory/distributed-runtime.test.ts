/**
 * Distributed Runtime Validation Tests
 *
 * Verifies that runtime: 'distributed' only enforces stores that the
 * factory actually wires — events always, cache/queryCache only when enabled.
 */

import { describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

// Mock durable transport/store (non-memory name)
const mockRedisTransport = {
  name: "redis",
  publish: async () => {},
  subscribe: async () => () => {},
};
const mockRedisStore = {
  name: "redis",
  get: async () => null,
  set: async () => {},
  delete: async () => {},
};

describe("distributed runtime validation", () => {
  it("should throw when events transport is missing", async () => {
    await expect(
      createApp({
        runtime: "distributed",
        auth: false,
        logger: false,
        helmet: false,
        cors: false,
        rateLimit: false,
        underPressure: false,
      }),
    ).rejects.toThrow(/stores\.events/);
  });

  it("should throw when events transport is memory-backed", async () => {
    await expect(
      createApp({
        runtime: "distributed",
        stores: {
          events: {
            name: "memory",
            publish: async () => {},
            subscribe: async () => () => {},
          } as any,
        },
        auth: false,
        logger: false,
        helmet: false,
        cors: false,
        rateLimit: false,
        underPressure: false,
      }),
    ).rejects.toThrow(/stores\.events/);
  });

  it("names the exact config key + a fix hint for every missing store", async () => {
    // The error must be prescriptive: name the `stores.<key>` to set AND
    // point at the canonical fix, not just list what's absent. Caching is
    // enabled so both events + cache are reported in one throw.
    let message = "";
    try {
      await createApp({
        runtime: "distributed",
        auth: false,
        logger: false,
        helmet: false,
        cors: false,
        rateLimit: false,
        underPressure: false,
        arcPlugins: { caching: true },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("stores.events");
    expect(message).toContain("stores.cache");
    // Per-key hint + the actionable "Fix:" line.
    expect(message).toContain("pub/sub transport");
    expect(message).toContain("Redis-backed cache adapter");
    expect(message).toMatch(/Fix:.*stores/s);
    expect(message).toContain("runtime: 'memory'");
  });

  it("should NOT require cache store when caching plugin is disabled", async () => {
    // This should succeed — no cache plugin, so no cache store required
    const app = await createApp({
      runtime: "distributed",
      stores: { events: mockRedisTransport as any },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      arcPlugins: { caching: false },
    });

    expect(app).toBeDefined();
    await app.close();
  });

  it("should require cache store when caching plugin is enabled", async () => {
    await expect(
      createApp({
        runtime: "distributed",
        stores: { events: mockRedisTransport as any },
        auth: false,
        logger: false,
        helmet: false,
        cors: false,
        rateLimit: false,
        underPressure: false,
        arcPlugins: { caching: true },
      }),
    ).rejects.toThrow(/stores\.cache/);
  });

  it("should NOT block startup without idempotency store (warns via fastify.log)", async () => {
    // Idempotency is per-resource, not factory-wide — should not block startup.
    // Warning is logged via fastify.log.warn (not console.warn).
    // With logger: false, the warning is suppressed but doesn't crash.
    const app = await createApp({
      runtime: "distributed",
      stores: { events: mockRedisTransport as any },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
    });

    expect(app).toBeDefined();
    await app.close();
  });

  it("should NOT require queryCache store when queryCache is disabled", async () => {
    const app = await createApp({
      runtime: "distributed",
      stores: { events: mockRedisTransport as any },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
    });

    expect(app).toBeDefined();
    await app.close();
  });

  /**
   * REFUSES, it does not warn. This was a warning until 2.41, which did not
   * survive comparison with the rest of the guard: a replica-local usage
   * counter fails the boot while "the billing cron runs on all six pods" only
   * logged. Duplicate side effects are the more expensive failure — two
   * invoices, two dunning emails, two charges.
   */
  it("REFUSES to boot when schedules are configured without a lock", async () => {
    await expect(
      createApp({
        runtime: "distributed",
        stores: { events: mockRedisTransport as any },
        auth: false,
        logger: false,
        helmet: false,
        cors: false,
        rateLimit: false,
        underPressure: false,
        arcPlugins: { schedules: {} },
      }),
    ).rejects.toThrow(/arcPlugins\.schedules\.lock/);
  });

  it("names the singleReplica escape in the failure, not just the lock", async () => {
    // The recommended topology is a `role: 'scheduler'` deployment pinned to
    // one replica, which needs no lock. A guard that only said "pass a lock"
    // would push those hosts toward machinery they do not need.
    const err = await createApp({
      runtime: "distributed",
      stores: { events: mockRedisTransport as any },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      arcPlugins: { schedules: {} },
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/singleReplica/);
  });

  it("boots when the host DECLARES a single arming replica", async () => {
    const app = await createApp({
      runtime: "distributed",
      stores: { events: mockRedisTransport as any },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      arcPlugins: { schedules: { singleReplica: true } },
    });
    expect(app).toBeTruthy();
    await app.close();
  });

  it("schedules disabled entirely is not a violation", async () => {
    const app = await createApp({
      runtime: "distributed",
      stores: { events: mockRedisTransport as any },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      arcPlugins: { schedules: { enabled: false } },
    });
    expect(app).toBeTruthy();
    await app.close();
  });

  it("does NOT warn when schedules carry a lock adapter", async () => {
    const lines: string[] = [];
    const app = await createApp({
      runtime: "distributed",
      stores: { events: mockRedisTransport as any },
      auth: false,
      logger: {
        level: "warn",
        stream: { write: (msg: string) => void lines.push(msg) },
      } as any,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      arcPlugins: {
        schedules: {
          lock: { tryAcquire: () => true, release: () => true },
        },
      },
    });
    expect(lines.some((l) => l.includes("schedules configured without"))).toBe(false);
    await app.close();
  });

  it("should pass with all required stores for a full distributed setup", async () => {
    const app = await createApp({
      runtime: "distributed",
      stores: {
        events: mockRedisTransport as any,
        cache: mockRedisStore as any,
      },
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      arcPlugins: { caching: true },
    });

    expect(app).toBeDefined();
    await app.close();
  });
});

describe("under-pressure preset tolerance", () => {
  it("production preset should use maxEventLoopDelay >= 3000ms", async () => {
    // Import preset directly to verify the value
    const { productionPreset } = await import("../../src/factory/presets.js");
    const upConfig = productionPreset.underPressure as Record<string, unknown>;

    expect(upConfig).toBeDefined();
    expect(upConfig.maxEventLoopDelay).toBeGreaterThanOrEqual(3000);
  });

  it("should allow disabling under-pressure entirely", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
    });

    expect(app).toBeDefined();
    await app.close();
  });

  it("edge preset should have under-pressure disabled", async () => {
    const { edgePreset } = await import("../../src/factory/presets.js");
    expect(edgePreset.underPressure).toBe(false);
  });
});
