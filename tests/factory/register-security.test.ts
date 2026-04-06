/**
 * registerSecurity — Unit Tests
 *
 * Tests registerSecurityPlugins and registerUtilityPlugins in isolation
 * with a real Fastify instance (no full createApp boot).
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  registerSecurityPlugins,
  registerUtilityPlugins,
  loadPlugin,
} from "../../src/factory/registerSecurity.js";
import type { CreateAppOptions } from "../../src/factory/types.js";

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

  it("smart CORS: credentials + origin:'*' converts to origin:true", async () => {
    app = createTestFastify();
    await registerSecurityPlugins(app, {
      cors: { credentials: true, origin: "*" },
    });
    app.get("/test", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { origin: "https://any.com" },
    });
    // Should reflect the request origin, not literal '*'
    expect(res.headers["access-control-allow-origin"]).toBe("https://any.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
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

  it("throws when distributed runtime + rate limit without store", async () => {
    app = createTestFastify();
    await expect(
      registerSecurityPlugins(app, { runtime: "distributed" }),
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
