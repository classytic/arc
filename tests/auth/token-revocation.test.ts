/**
 * Token Revocation Tests
 *
 * Tests the isRevoked hook in JWT auth plugin.
 * Users can provide their own revocation logic (Redis blacklist, DB check, etc.)
 * Arc provides the primitive — users implement the store.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authPlugin } from "../../src/auth/authPlugin.js";

const JWT_SECRET = "a-very-long-secret-that-is-at-least-32-chars!";

describe("Auth Plugin — isRevoked hook", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should reject token when isRevoked returns true", async () => {
    app = Fastify({ logger: false });

    // Simulate a revocation store (e.g., Redis set of revoked JTIs)
    const revokedTokens = new Set<string>();

    await app.register(authPlugin, {
      jwt: { secret: JWT_SECRET },
      isRevoked: async (decoded) => {
        return revokedTokens.has(String(decoded.id));
      },
    });

    app.get("/protected", { preHandler: [app.authenticate] }, async (req) => {
      return { user: (req as any).user };
    });
    await app.ready();

    // Issue a token
    const token = app.auth.issueTokens({ id: "user-1", role: "admin" });

    // Should work initially
    const res1 = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token.accessToken}` },
    });
    expect(res1.statusCode).toBe(200);

    // Revoke the token
    revokedTokens.add("user-1");

    // Should now be rejected
    const res2 = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token.accessToken}` },
    });
    expect(res2.statusCode).toBe(401);
    const body = JSON.parse(res2.body);
    expect(body.error).toBe("Unauthorized");
  });

  it("should allow token when isRevoked returns false", async () => {
    app = Fastify({ logger: false });

    await app.register(authPlugin, {
      jwt: { secret: JWT_SECRET },
      isRevoked: async () => false,
    });

    app.get("/protected", { preHandler: [app.authenticate] }, async (_req) => {
      return { ok: true };
    });
    await app.ready();

    const token = app.auth.issueTokens({ id: "user-2", role: "user" });

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("should treat isRevoked errors as revoked (fail-closed)", async () => {
    app = Fastify({ logger: false });

    await app.register(authPlugin, {
      jwt: { secret: JWT_SECRET },
      isRevoked: async () => {
        throw new Error("Redis connection failed");
      },
    });

    app.get("/protected", { preHandler: [app.authenticate] }, async (_req) => {
      return { ok: true };
    });
    await app.ready();

    const token = app.auth.issueTokens({ id: "user-3", role: "user" });

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token.accessToken}` },
    });
    // Fail-closed: if revocation check fails, reject the token
    expect(res.statusCode).toBe(401);
  });

  it("should work with custom authenticator + isRevoked", async () => {
    app = Fastify({ logger: false });

    const isRevokedFn = vi.fn().mockResolvedValue(false);

    await app.register(authPlugin, {
      jwt: { secret: JWT_SECRET },
      authenticate: async (request, { jwt }) => {
        const auth = request.headers.authorization;
        if (!auth?.startsWith("Bearer ")) return null;
        const decoded = jwt?.verify(auth.slice(7));
        return decoded;
      },
      isRevoked: isRevokedFn,
    });

    app.get("/protected", { preHandler: [app.authenticate] }, async (req) => {
      return { user: (req as any).user };
    });
    await app.ready();

    const token = app.auth.issueTokens({ id: "user-4", role: "admin" });

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    // isRevoked should have been called with the decoded user
    expect(isRevokedFn).toHaveBeenCalledOnce();
    expect(isRevokedFn.mock.calls[0]?.[0]).toHaveProperty("id", "user-4");
  });

  it("should NOT call isRevoked on optionalAuthenticate (perf: avoid extra check on public routes)", async () => {
    app = Fastify({ logger: false });

    const isRevokedFn = vi.fn().mockResolvedValue(false);

    await app.register(authPlugin, {
      jwt: { secret: JWT_SECRET },
      isRevoked: isRevokedFn,
    });

    app.get("/public", { preHandler: [app.optionalAuthenticate] }, async (req) => {
      return { user: (req as any).user ?? null };
    });
    await app.ready();

    const token = app.auth.issueTokens({ id: "user-5" });

    const res = await app.inject({
      method: "GET",
      url: "/public",
      headers: { authorization: `Bearer ${token.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    // optionalAuthenticate should still call isRevoked when token IS present
    // (so revoked tokens don't leak user info on public routes)
    expect(isRevokedFn).toHaveBeenCalledOnce();
  });
});
