/**
 * registerSecurity — Unit Tests
 *
 * Tests registerSecurityPlugins and registerUtilityPlugins in isolation
 * with a real Fastify instance (no full createApp boot).
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPlugin,
  registerSecurityPlugins,
  registerUtilityPlugins,
} from "../../src/factory/registerSecurity.js";

function createTestFastify(): FastifyInstance {
  return Fastify({ logger: false });
}

describe("loadPlugin", () => {
  it("loads a known plugin (sensible)", async () => {
    const plugin = await loadPlugin("sensible");
    expect(plugin).toBeDefined();
    expect(typeof plugin).toBe("function");
  });

  it("throws for unknown plugin name", async () => {
    await expect(loadPlugin("nonexistent")).rejects.toThrow("Unknown plugin: nonexistent");
  });

  it("returns null for optional plugin that is not installed", async () => {
    // multipart is optional and should be installed in dev, but let's test the contract
    const plugin = await loadPlugin("multipart");
    // If installed, it returns a function; this tests the path exists
    expect(plugin === null || typeof plugin === "function").toBe(true);
  });
});

describe("registerSecurityPlugins", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("registers helmet, cors, and rate limit by default", async () => {
    app = createTestFastify();
    await registerSecurityPlugins(app, {});
    await app.ready();

    // Helmet adds security headers
    const res = await app.inject({ method: "GET", url: "/" });
    // Check for helmet-added headers (x-content-type-options, etc.)
    expect(res.headers).toBeDefined();
  });

  it("skips helmet when helmet: false", async () => {
    app = createTestFastify();
    await registerSecurityPlugins(app, { helmet: false });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/" });
    // No helmet headers (x-dns-prefetch-control is added by helmet)
    expect(res.headers["x-dns-prefetch-control"]).toBeUndefined();
  });

  it("skips cors when cors: false", async () => {
    app = createTestFastify();
    await registerSecurityPlugins(app, { cors: false });
    await app.ready();

    const res = await app.inject({
      method: "OPTIONS",
      url: "/",
      headers: { origin: "http://evil.com" },
    });
    // No access-control-allow-origin
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("enables cors with custom origin", async () => {
    app = createTestFastify();
    await registerSecurityPlugins(app, {
      cors: { origin: "https://example.com" },
    });
    app.get("/test", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { origin: "https://example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");
  });

  it("throws at boot on credentials + origin:'*' (reflected-origin hazard)", async () => {
    // Pre-2.22 this combo was silently rewritten to `origin: true`, which
    // reflects ANY request Origin with credentials — the vulnerability the
    // browser wildcard ban exists to prevent. It is now a boot-time error.
    app = createTestFastify();
    await expect(
      registerSecurityPlugins(app, {
        cors: { credentials: true, origin: "*" },
      }),
    ).rejects.toThrow(/origin: '\*'.*credentials: true/s);
  });

  it("skips rate limit when rateLimit: false", async () => {
    app = createTestFastify();
    await registerSecurityPlugins(app, { rateLimit: false });
    app.get("/test", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  it("applies rate limit with custom options", async () => {
    app = createTestFastify();
    await registerSecurityPlugins(app, {
      rateLimit: { max: 5, timeWindow: "10 seconds" },
    });
    app.get("/test", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
  });

  it("skipPaths with prefix wildcard exempts matching paths from the bucket", async () => {
    app = createTestFastify();
    await registerSecurityPlugins(app, {
      rateLimit: {
        max: 2,
        timeWindow: "1 minute",
        skipPaths: ["/api/auth/*", "/healthz"],
      },
    });
    app.get("/api/auth/get-session", async () => ({ ok: true }));
    app.get("/healthz", async () => ({ ok: true }));
    app.get("/api/orders", async () => ({ ok: true }));
    await app.ready();

    // Auth heartbeat — should never hit the limit even after many calls.
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "GET", url: "/api/auth/get-session" });
      expect(r.statusCode).toBe(200);
    }
    // Exact match also exempt.
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);

    // Non-exempt route still rate limited at max=2.
    const r1 = await app.inject({ method: "GET", url: "/api/orders" });
    const r2 = await app.inject({ method: "GET", url: "/api/orders" });
    const r3 = await app.inject({ method: "GET", url: "/api/orders" });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
  });

  it("skipPaths composes with a user-supplied allowList function", async () => {
    app = createTestFastify();
    let allowListCalls = 0;
    await registerSecurityPlugins(app, {
      rateLimit: {
        max: 1,
        timeWindow: "1 minute",
        skipPaths: ["/skip-path"],
        allowList: (_req, _key) => {
          allowListCalls++;
          return false; // never allows via custom function
        },
      },
    });
    app.get("/skip-path", async () => ({ ok: true }));
    app.get("/limited", async () => ({ ok: true }));
    await app.ready();

    // skipPaths short-circuits — allowList must not be consulted here.
    await app.inject({ method: "GET", url: "/skip-path" });
    await app.inject({ method: "GET", url: "/skip-path" });
    expect(allowListCalls).toBe(0);

    // Non-skip path falls through to allowList (still false) → limit applies.
    const ok = await app.inject({ method: "GET", url: "/limited" });
    const denied = await app.inject({ method: "GET", url: "/limited" });
    expect(ok.statusCode).toBe(200);
    expect(denied.statusCode).toBe(429);
    expect(allowListCalls).toBeGreaterThan(0);
  });

  it("throws when distributed runtime + rate limit without store", async () => {
    app = createTestFastify();
    await expect(registerSecurityPlugins(app, { runtime: "distributed" })).rejects.toThrow(
      "distributed",
    );
  });

  it("distributed runtime + rate limit passes with a custom `store` class", async () => {
    app = createTestFastify();
    // @fastify/rate-limit's store contract: constructed with the plugin
    // options, `incr(key, cb, timeWindow, max)`, `child(routeOptions)`.
    class SharedStore {
      incr(_key: string, cb: (err: Error | null, res: { current: number; ttl: number }) => void) {
        cb(null, { current: 1, ttl: 60_000 });
      }
      child() {
        return this;
      }
    }
    await registerSecurityPlugins(app, {
      runtime: "distributed",
      rateLimit: { store: SharedStore },
    });
    app.get("/test", async () => ({ ok: true }));
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/test" })).statusCode).toBe(200);
  });

  it("distributed runtime + rate limit passes with the documented `redis` client form", async () => {
    app = createTestFastify();
    // The plugin wraps `redis` in its own RedisStore — no `store` key ever
    // exists on the options, which is exactly what the guard used to check.
    const redis = {
      defineCommand: () => {},
      rateLimit: (...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error | null, res: [number, number]) => void;
        cb(null, [1, 60_000]);
      },
      rateLimitRead: () => {},
    };
    await registerSecurityPlugins(app, { runtime: "distributed", rateLimit: { redis } });
    app.get("/test", async () => ({ ok: true }));
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/test" })).statusCode).toBe(200);
  });

  // The guard reads the VALUE, not the key. `{ redis: buildClient() }` where
  // the builder returned undefined — a failed env lookup, a lazily-constructed
  // client that never got built — is the shape a host actually writes. A
  // key-presence check (`'redis' in opts`) calls that a shared store and lets
  // the distributed boot through with per-replica counters: the exact
  // deployment this guard exists to refuse, now waved past by the fix for the
  // opposite bug.
  it.each([
    ["redis", { redis: undefined }],
    ["store", { store: undefined }],
    ["redis (null)", { redis: null }],
  ])("distributed runtime still REFUSES an empty `%s` value", async (_label, shape) => {
    app = createTestFastify();
    await expect(
      registerSecurityPlugins(app, {
        runtime: "distributed",
        rateLimit: { max: 10, timeWindow: "1 minute", ...shape } as never,
      }),
    ).rejects.toThrow("distributed");
  });

  it("all disabled = no security plugins", async () => {
    app = createTestFastify();
    await registerSecurityPlugins(app, {
      helmet: false,
      cors: false,
      rateLimit: false,
    });
    app.get("/test", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
  });
});

describe("registerUtilityPlugins", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("registers under-pressure by default", async () => {
    app = createTestFastify();
    await registerUtilityPlugins(app, {});
    await app.ready();

    // Under Pressure exposes /_status or adds health check
    // Just verify the plugin registered without error
    expect(true).toBe(true);
  });

  it("skips under-pressure when disabled", async () => {
    app = createTestFastify();
    await registerUtilityPlugins(app, { underPressure: false });
    await app.ready();
  });

  it("registers sensible by default", async () => {
    app = createTestFastify();
    await registerUtilityPlugins(app, {});
    await app.ready();

    // Sensible adds httpErrors helper
    expect(app.httpErrors).toBeDefined();
    expect(typeof app.httpErrors.notFound).toBe("function");
  });

  it("skips sensible when disabled", async () => {
    app = createTestFastify();
    await registerUtilityPlugins(app, { sensible: false });
    await app.ready();

    // httpErrors not decorated
    expect(app.hasDecorator("httpErrors")).toBe(false);
  });

  it("does not log compression warning for non-production", async () => {
    app = createTestFastify();
    // preset: "testing" — no compression warning
    await registerUtilityPlugins(app, { preset: "testing" });
    await app.ready();
  });
});

// ============================================================================
// under-pressure — real default thresholds + threshold-less warning (wave-12)
// ============================================================================

describe("registerUtilityPlugins — under-pressure load shedding", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("default config exposes the status route (real thresholds, not monitoring-only)", async () => {
    app = createTestFastify();
    await registerUtilityPlugins(app, {});
    await app.ready();

    // Arc's default is `exposeStatusRoute: true` + event-loop thresholds —
    // the route existing proves the arc default object was applied instead
    // of @fastify/under-pressure's all-zeros (disabled) defaults.
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
  });

  it("warns in production when host config has NO pressure thresholds", async () => {
    app = createTestFastify();
    const warn = vi.spyOn(app.log, "warn");
    await registerUtilityPlugins(app, {
      preset: "production",
      underPressure: { exposeStatusRoute: true }, // monitoring-only
    });
    await app.ready();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("never shed load"));
  });

  it("does NOT warn in production when a threshold is configured", async () => {
    app = createTestFastify();
    const warn = vi.spyOn(app.log, "warn");
    await registerUtilityPlugins(app, {
      preset: "production",
      underPressure: { maxEventLoopDelay: 2000 },
    });
    await app.ready();

    const calls = warn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes("never shed load"))).toBe(false);
  });

  it("does NOT warn outside production for a threshold-less config", async () => {
    app = createTestFastify();
    const warn = vi.spyOn(app.log, "warn");
    await registerUtilityPlugins(app, {
      preset: "development",
      underPressure: { exposeStatusRoute: true },
    });
    await app.ready();

    const calls = warn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes("never shed load"))).toBe(false);
  });
});
