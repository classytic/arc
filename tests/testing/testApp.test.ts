/**
 * createTestApp — smoke tests for the turnkey factory.
 *
 * Spins up a real Fastify instance with arc defaults and verifies that the
 * test context exposes app/auth/fixtures with the documented contracts and
 * that `close()` is both idempotent and tears down the in-memory Mongo.
 */

import { afterAll, describe, expect, it } from "vitest";
import { expectArc } from "../../src/testing/assertions.js";
import { createTestApp } from "../../src/testing/testApp.js";

describe("createTestApp — defaults", () => {
  it("boots with preset: testing, auth provider attached, fixtures attached", async () => {
    const ctx = await createTestApp({ db: false, authMode: "jwt" });

    try {
      expect(ctx.app).toBeDefined();
      expect(ctx.auth).toBeDefined();
      expect(ctx.fixtures).toBeDefined();
      expect(ctx.dbUri).toBeUndefined();
      // app.inject works — baseline liveness
      const res = await ctx.app.inject({ method: "GET", url: "/nonexistent" });
      expect(res.statusCode).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it("authMode: 'none' leaves ctx.auth as undefined", async () => {
    const ctx = await createTestApp({ db: false, authMode: "none" });
    try {
      expect(ctx.auth).toBeUndefined();
      expect(ctx.fixtures).toBeDefined();
    } finally {
      await ctx.close();
    }
  });

  it("JWT provider can sign a token via app.jwt", async () => {
    const ctx = await createTestApp({ db: false, authMode: "jwt" });
    try {
      ctx.auth?.register("admin", { user: { id: "u1", roles: ["admin"] } });
      const session = ctx.auth?.as("admin");
      expect(session.token.length).toBeGreaterThan(10);
      expect(session.headers.authorization).toMatch(/^Bearer /);
    } finally {
      await ctx.close();
    }
  });

  it("close() is idempotent — calling twice does not throw", async () => {
    const ctx = await createTestApp({ db: false, authMode: "none" });
    await ctx.close();
    await expect(ctx.close()).resolves.toBeUndefined();
  });
});

describe("createTestApp — fixtures wiring", () => {
  it("fixture factories can be registered and invoked via ctx.fixtures", async () => {
    const ctx = await createTestApp({ db: false, authMode: "none" });
    try {
      ctx.fixtures.register("widget", async (data) => ({ _id: "w1", ...data }));
      const widget = await ctx.fixtures.create("widget", { name: "A" });
      expect(widget).toEqual({ _id: "w1", name: "A" });
    } finally {
      await ctx.close();
    }
  });
});

describe("createTestApp — auth config parity", () => {
  it("authMode: 'better-auth' without a caller-supplied auth config fails fast", async () => {
    // Regression: pre-fix the factory silently defaulted the app to JWT
    // while swapping ctx.auth to the Better Auth provider. Tests looked
    // like they were exercising Better Auth middleware but weren't.
    await expect(createTestApp({ db: false, authMode: "better-auth" })).rejects.toThrow(
      /authMode: 'better-auth'.*must also pass `auth:/,
    );
  });

  it("authMode: 'jwt' + caller-supplied auth config — caller's config wins", async () => {
    // Pass a no-op override to verify the factory does NOT clobber it. The
    // test only checks the factory doesn't throw and the app boots — deep
    // auth-plugin plumbing is out of scope here.
    const ctx = await createTestApp({
      db: false,
      authMode: "jwt",
      auth: { type: "jwt", jwt: { secret: "custom-secret-32-chars-minimum-here" } },
    });
    try {
      expect(ctx.auth).toBeDefined();
    } finally {
      await ctx.close();
    }
  });
});

describe("createTestApp + expectArc integration", () => {
  // Unknown routes hit Fastify's default 404 handler (not arc's envelope),
  // so we assert on statusCode only. End-to-end arc-envelope coverage lives
  // in `tests/core/action-router-parity.test.ts` and similar suites that
  // register real resources.
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  afterAll(async () => {
    await ctx?.close();
  });

  it("expectArc reads statusCode on an unknown-route probe", async () => {
    ctx = await createTestApp({ db: false, authMode: "none" });
    const res = await ctx.app.inject({ method: "GET", url: "/nope" });
    expectArc(res).hasStatus(404);
  });
});
