/**
 * Authorize Decorator & Optional Authenticate Tests
 *
 * Tests the role-based authorization middleware:
 * - Role-based access (single role, multiple roles)
 * - Wildcard '*' (any authenticated user)
 * - No user context → 401
 * - Insufficient roles → 403
 * - Combined with authenticate
 *
 * Also tests optionalAuthenticate:
 * - Populates request.user when valid token present
 * - Does NOT fail when no token (unauthenticated)
 * - Does NOT fail on invalid/expired tokens
 * - Ignores refresh tokens
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { authPlugin } from "../../src/auth/authPlugin.js";

const JWT_SECRET = "a-secure-secret-that-is-at-least-32-chars-long!!";

describe("Authorize Decorator", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function createApp() {
    app = Fastify({ logger: false });
    await app.register(authPlugin, {
      jwt: { secret: JWT_SECRET },
    });

    // Admin-only route
    app.get(
      "/admin",
      {
        preHandler: [app.authenticate, app.authorize("admin")],
      },
      async (request) => {
        return { success: true, user: (request as any).user };
      },
    );

    // Multiple roles route
    app.get(
      "/editor",
      {
        preHandler: [app.authenticate, app.authorize("admin", "editor")],
      },
      async () => {
        return { success: true };
      },
    );

    // Wildcard route (any authenticated user)
    app.get(
      "/any-user",
      {
        preHandler: [app.authenticate, app.authorize("*")],
      },
      async () => {
        return { success: true };
      },
    );

    // Superadmin-only
    app.delete(
      "/dangerous",
      {
        preHandler: [app.authenticate, app.authorize("superadmin")],
      },
      async () => {
        return { success: true, message: "deleted" };
      },
    );

    await app.ready();
    return app;
  }

  function issueToken(payload: Record<string, unknown>) {
    return app.auth.issueTokens(payload).accessToken;
  }

  // ========================================================================
  // Role Access
  // ========================================================================

  describe("Role-based access", () => {
    it("should allow admin to access admin-only route", async () => {
      await createApp();
      const token = issueToken({ id: "user-1", role: ["admin"] });

      const res = await app.inject({
        method: "GET",
        url: "/admin",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it("should reject non-admin from admin-only route with 403", async () => {
      await createApp();
      const token = issueToken({ id: "user-2", role: ["viewer"] });

      const res = await app.inject({
        method: "GET",
        url: "/admin",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe("Forbidden");
      expect(body.message).toContain("admin");
    });

    it("should allow either admin or editor to access editor route", async () => {
      await createApp();

      // Admin should work
      const adminToken = issueToken({ id: "u1", role: ["admin"] });
      const res1 = await app.inject({
        method: "GET",
        url: "/editor",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res1.statusCode).toBe(200);

      // Editor should work
      const editorToken = issueToken({ id: "u2", role: ["editor"] });
      const res2 = await app.inject({
        method: "GET",
        url: "/editor",
        headers: { authorization: `Bearer ${editorToken}` },
      });
      expect(res2.statusCode).toBe(200);

      // Viewer should be rejected
      const viewerToken = issueToken({ id: "u3", role: ["viewer"] });
      const res3 = await app.inject({
        method: "GET",
        url: "/editor",
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res3.statusCode).toBe(403);
    });

    it("should handle user with multiple roles", async () => {
      await createApp();
      const token = issueToken({ id: "u1", role: ["viewer", "editor", "moderator"] });

      const res = await app.inject({
        method: "GET",
        url: "/editor",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ========================================================================
  // Wildcard
  // ========================================================================

  describe("Wildcard authorization (*)", () => {
    it("should allow any authenticated user with wildcard", async () => {
      await createApp();
      const token = issueToken({ id: "u1", role: [] }); // No roles at all

      const res = await app.inject({
        method: "GET",
        url: "/any-user",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it("should still require authentication for wildcard", async () => {
      await createApp();

      const res = await app.inject({
        method: "GET",
        url: "/any-user",
        // No auth header
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ========================================================================
  // No User Context
  // ========================================================================

  describe("No user context", () => {
    it("should return 401 when no token provided", async () => {
      await createApp();

      const res = await app.inject({
        method: "GET",
        url: "/admin",
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it("should return 401 with invalid token", async () => {
      await createApp();

      const res = await app.inject({
        method: "GET",
        url: "/admin",
        headers: { authorization: "Bearer invalid-token" },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ========================================================================
  // Empty roles
  // ========================================================================

  describe("Edge cases", () => {
    it("should treat user without roles property as empty roles", async () => {
      await createApp();
      // Issue token without roles field
      const token = issueToken({ id: "u1" });

      const res = await app.inject({
        method: "GET",
        url: "/admin",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it("should reject when user has wrong roles for specific endpoint", async () => {
      await createApp();
      const token = issueToken({ id: "u1", role: ["admin", "editor"] });

      const res = await app.inject({
        method: "DELETE",
        url: "/dangerous",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain("superadmin");
    });

    it("should pass with exact matching role", async () => {
      await createApp();
      const token = issueToken({ id: "u1", role: ["superadmin"] });

      const res = await app.inject({
        method: "DELETE",
        url: "/dangerous",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});

// ============================================================================
// Optional Authenticate
// ============================================================================

describe("Optional Authenticate", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function createApp() {
    app = Fastify({ logger: false });
    await app.register(authPlugin, {
      jwt: { secret: JWT_SECRET },
    });

    // Route using optionalAuthenticate — public but populates user if token present
    app.get(
      "/public",
      {
        preHandler: [app.optionalAuthenticate],
      },
      async (request) => {
        return { user: (request as any).user ?? null };
      },
    );

    await app.ready();
    return app;
  }

  function issueToken(payload: Record<string, unknown>) {
    return app.auth.issueTokens(payload).accessToken;
  }

  it("should populate request.user when valid token is present", async () => {
    await createApp();
    const token = issueToken({ id: "user-1", role: ["admin"], organizationId: "org-1" });

    const res = await app.inject({
      method: "GET",
      url: "/public",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user).not.toBeNull();
    expect(body.user.id).toBe("user-1");
    expect(body.user.role).toEqual(["admin"]);
    expect(body.user.organizationId).toBe("org-1");
  });

  it("should NOT fail when no token is provided (unauthenticated)", async () => {
    await createApp();

    const res = await app.inject({
      method: "GET",
      url: "/public",
      // No authorization header
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user).toBeNull();
  });

  it("should NOT fail on invalid/expired tokens", async () => {
    await createApp();

    const res = await app.inject({
      method: "GET",
      url: "/public",
      headers: { authorization: "Bearer invalid-garbage-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user).toBeNull();
  });

  it("should ignore refresh tokens (not populate user)", async () => {
    await createApp();
    // Issue a refresh token — optionalAuthenticate should silently ignore it
    const tokens = app.auth.issueTokens({ id: "user-1", role: ["admin"] });

    const res = await app.inject({
      method: "GET",
      url: "/public",
      headers: { authorization: `Bearer ${tokens.refreshToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user).toBeNull();
  });

  it("should work alongside authenticate on different routes", async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin, {
      jwt: { secret: JWT_SECRET },
    });

    // Public route with optional auth
    app.get(
      "/public",
      {
        preHandler: [app.optionalAuthenticate],
      },
      async (request) => {
        return { user: (request as any).user ?? null };
      },
    );

    // Protected route with strict auth
    app.get(
      "/protected",
      {
        preHandler: [app.authenticate],
      },
      async (request) => {
        return { user: (request as any).user };
      },
    );

    await app.ready();

    // Public works without token
    const publicRes = await app.inject({ method: "GET", url: "/public" });
    expect(publicRes.statusCode).toBe(200);
    expect(JSON.parse(publicRes.body).user).toBeNull();

    // Protected fails without token
    const protectedRes = await app.inject({ method: "GET", url: "/protected" });
    expect(protectedRes.statusCode).toBe(401);
  });
});
