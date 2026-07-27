/**
 * usagePlugin — per-actor, per-period counters (2.22).
 *
 * Pins: manual record() with scope + raw actor keys, current-period
 * summary(), automatic request tracking (+ ignorePaths), egress bytes
 * from content-length, disabled no-op registration, store failure
 * isolation (a throwing store never fails the request).
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageStore } from "../../src/usage/index.js";
import usagePlugin, { MemoryUsageStore, usagePeriod } from "../../src/usage/index.js";

const apps: Array<{ close(): Promise<void> }> = [];

async function build(opts: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false });
  await app.register(usagePlugin, opts);
  app.get("/hello", async () => ({ ok: true }));
  app.get("/_health/live", async () => ({ ok: true }));
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

describe("usagePlugin", () => {
  it("records manual usage for a raw actor and a scope", async () => {
    const store = new MemoryUsageStore();
    const app = await build({ store, track: { requests: false } });

    await app.usage?.record("org-42", "ai.tokens", 1500);
    await app.usage?.record("org-42", "ai.tokens", 500);
    await app.usage?.record(
      { kind: "member", organizationId: "org-42", userId: "u1", userRoles: [], orgRoles: [] },
      "export.rows",
      12,
    );

    const summary = await app.usage?.summary("org-42");
    expect(summary).toEqual({ "ai.tokens": 2000, "export.rows": 12 });
  });

  it("tracks requests automatically and skips ignorePaths", async () => {
    const store = new MemoryUsageStore();
    const app = await build({ store });

    await app.inject({ method: "GET", url: "/hello" });
    await app.inject({ method: "GET", url: "/hello" });
    await app.inject({ method: "GET", url: "/_health/live" }); // ignored by default

    const actor = `ip:${(await app.inject({ method: "GET", url: "/hello" })).raw.req.socket.remoteAddress ?? "127.0.0.1"}`;
    // inject requests report ip 127.0.0.1
    const summary = await app.usage?.summary("ip:127.0.0.1");
    expect(actor).toBeTruthy();
    expect(summary?.["api.requests"]).toBe(3);
  });

  it("tracks egress bytes from content-length when enabled", async () => {
    const store = new MemoryUsageStore();
    const app = await build({ store, track: { requests: true, egress: true } });

    const res = await app.inject({ method: "GET", url: "/hello" });
    const len = Number(res.headers["content-length"]);

    const summary = await app.usage?.summary("ip:127.0.0.1");
    expect(summary?.["api.egress.bytes"]).toBe(len);
  });

  it("registers a typed no-op when disabled", async () => {
    const app = await build({ enabled: false });
    await app.usage?.record("org-1", "anything", 5);
    expect(await app.usage?.summary("org-1")).toEqual({});
  });

  it("never fails a request when the store throws", async () => {
    const broken: UsageStore = {
      name: "broken",
      increment: () => {
        throw new Error("store down");
      },
      summary: async () => ({}),
    };
    const app = await build({ store: broken });
    const res = await app.inject({ method: "GET", url: "/hello" });
    expect(res.statusCode).toBe(200);
  });

  it("usagePeriod produces UTC YYYY-MM keys", () => {
    expect(usagePeriod(new Date(Date.UTC(2026, 6, 14)))).toBe("2026-07");
    expect(usagePeriod(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01");
  });
});
