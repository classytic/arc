/**
 * Plan-aware rate limiting (2.22) — `rateLimit.plan { resolve, limits, default }`.
 *
 * Pins: per-plan ceilings within one window, `false` = effectively
 * unlimited, unknown plan / throwing resolver falls back to `default`
 * (fail-safe, never fail-open), and the tenant keyGenerator default.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

const apps: Array<{ close(): Promise<void> }> = [];

async function buildApp(plan: Record<string, unknown>) {
  const app = await createApp({
    preset: "testing",
    auth: false,
    rateLimit: {
      max: 2, // global fallback when no plan matches
      timeWindow: "1 minute",
      plan,
    },
  });
  app.get("/ping", async () => ({ ok: true }));
  await app.ready();
  apps.push(app);
  return app;
}

const headerPlan = {
  resolve: (req: { headers: Record<string, unknown> }) =>
    req.headers["x-plan"] as string | undefined,
  limits: { free: { max: 1 }, pro: { max: 100 }, boundless: false as const },
  default: "free",
};

describe("rateLimit.plan", () => {
  afterEach(async () => {
    while (apps.length) await apps.pop()?.close();
  });

  it("applies the resolved plan's ceiling", async () => {
    const app = await buildApp(headerPlan);
    const h = { "x-plan": "free" };
    expect((await app.inject({ method: "GET", url: "/ping", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ping", headers: h })).statusCode).toBe(429);
  });

  it("treats `false` as effectively unlimited", async () => {
    const app = await buildApp(headerPlan);
    const h = { "x-plan": "boundless" };
    for (let i = 0; i < 10; i++) {
      expect((await app.inject({ method: "GET", url: "/ping", headers: h })).statusCode).toBe(200);
    }
  });

  it("falls back to `default` for unknown plans and resolver errors", async () => {
    const app = await buildApp({
      ...headerPlan,
      resolve: () => {
        throw new Error("plan service down");
      },
    });
    // default: 'free' (max 1) — fail-safe, not fail-open
    expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(429);
  });

  it("higher plans get their own ceiling on the same bucket key", async () => {
    const app = await buildApp(headerPlan);
    const h = { "x-plan": "pro" };
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/ping", headers: h })).statusCode).toBe(200);
    }
  });
});
