/**
 * Custom Token Extractor Tests
 *
 * Verifies that the tokenExtractor option allows extracting JWT tokens
 * from sources other than the Authorization header (cookies, custom headers).
 */

import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it } from "vitest";

const JWT_SECRET = "test-secret-must-be-at-least-32-characters-long";

async function registerAuthPlugin(app: FastifyInstance, opts: Record<string, unknown> = {}) {
  const { default: authPlugin } = await import("../../src/auth/authPlugin.js");
  await app.register(authPlugin, {
    jwt: { secret: JWT_SECRET },
    exposeAuthErrors: true,
    ...opts,
  });
}

describe("tokenExtractor option", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should use default Bearer header extraction when no tokenExtractor is provided", async () => {
    app = Fastify({ logger: false });
    await registerAuthPlugin(app);

    let capturedUser: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedUser = (request as any).user;
      return { ok: true };
    });
    await app.ready();

    const token = jwt.sign({ id: "user-1", role: "admin" }, JWT_SECRET);

    // Bearer header works
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((capturedUser as any).id).toBe("user-1");
  });

  it("should extract token from custom header via tokenExtractor", async () => {
    app = Fastify({ logger: false });
    await registerAuthPlugin(app, {
      tokenExtractor: (request: any) => (request.headers["x-api-token"] as string) ?? null,
    });

    let capturedUser: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedUser = (request as any).user;
      return { ok: true };
    });
    await app.ready();

    const token = jwt.sign({ id: "user-2", role: "editor" }, JWT_SECRET);

    // Custom header works
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "x-api-token": token },
    });
    expect(res.statusCode).toBe(200);
    expect((capturedUser as any).id).toBe("user-2");
  });

  it("should reject when tokenExtractor returns null", async () => {
    app = Fastify({ logger: false });
    await registerAuthPlugin(app, {
      tokenExtractor: () => null,
    });

    app.get("/test", { preHandler: [app.authenticate] }, async () => {
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/test",
    });
    expect(res.statusCode).toBe(401);
  });

  it("should ignore Authorization header when custom tokenExtractor is provided", async () => {
    app = Fastify({ logger: false });
    await registerAuthPlugin(app, {
      // Always returns null — ignores Authorization header
      tokenExtractor: () => null,
    });

    app.get("/test", { preHandler: [app.authenticate] }, async () => {
      return { ok: true };
    });
    await app.ready();

    const token = jwt.sign({ id: "user-3" }, JWT_SECRET);

    // Even with a valid Bearer token, custom extractor returning null = 401
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("should work with optionalAuthenticate and custom tokenExtractor", async () => {
    app = Fastify({ logger: false });
    await registerAuthPlugin(app, {
      tokenExtractor: (request: any) => (request.headers["x-session-token"] as string) ?? null,
    });

    let capturedUser: unknown;
    app.get("/test", { preHandler: [app.optionalAuthenticate] }, async (request) => {
      capturedUser = (request as any).user;
      return { ok: true };
    });
    await app.ready();

    // No token — should succeed (optional auth)
    const noTokenRes = await app.inject({ method: "GET", url: "/test" });
    expect(noTokenRes.statusCode).toBe(200);

    // With token in custom header
    const token = jwt.sign({ id: "user-4", role: "viewer" }, JWT_SECRET);
    capturedUser = null;
    const withTokenRes = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "x-session-token": token },
    });
    expect(withTokenRes.statusCode).toBe(200);
    expect((capturedUser as any)?.id).toBe("user-4");
  });
});
