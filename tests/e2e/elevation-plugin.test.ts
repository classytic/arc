/**
 * Elevation Plugin E2E Tests
 *
 * Tests that elevation works correctly in a real auth flow:
 * - authenticate() runs first → sets request.user
 * - elevation check runs after → upgrades scope to 'elevated' if header present
 *
 * This validates the fix for the lifecycle timing issue where elevation
 * previously ran at onRequest (before auth set request.user).
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";
import type { RequestScope } from "../../src/scope/types.js";
import { getOrgId, isElevated } from "../../src/scope/types.js";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";

describe("Elevation Plugin (real auth flow)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  function issueToken(payload: Record<string, unknown>) {
    return app.auth.issueTokens(payload).accessToken;
  }

  function authHeader(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  // ========================================================================
  // Core: Elevation wraps authenticate correctly
  // ========================================================================

  it("superadmin with x-arc-scope: platform gets elevated scope", async () => {
    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: { platformRoles: ["superadmin"] },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        fastify.get(
          "/items",
          {
            preHandler: [fastify.authenticate],
          },
          async (request) => {
            const scope = (request as any).scope as RequestScope;
            return {
              kind: scope.kind,
              elevated: isElevated(scope),
              orgId: getOrgId(scope),
            };
          },
        );
      },
    });
    await app.ready();

    const token = issueToken({ id: "admin-1", role: ["superadmin"] });
    const res = await app.inject({
      method: "GET",
      url: "/items",
      headers: {
        ...authHeader(token),
        "x-arc-scope": "platform",
        "x-organization-id": "org-123",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.kind).toBe("elevated");
    expect(body.elevated).toBe(true);
    expect(body.orgId).toBe("org-123");
  });

  it("superadmin WITHOUT elevation header gets normal scope (not elevated)", async () => {
    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: { platformRoles: ["superadmin"] },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        fastify.get(
          "/items",
          {
            preHandler: [fastify.authenticate],
          },
          async (request) => {
            const scope = (request as any).scope as RequestScope;
            return { kind: scope.kind };
          },
        );
      },
    });
    await app.ready();

    const token = issueToken({ id: "admin-1", role: ["superadmin"] });
    const res = await app.inject({
      method: "GET",
      url: "/items",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    // Without the elevation header, should be 'authenticated' (default from JWT auth)
    expect(JSON.parse(res.body).kind).toBe("authenticated");
  });

  it("non-superadmin with elevation header gets 403", async () => {
    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: { platformRoles: ["superadmin"] },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        fastify.get(
          "/items",
          {
            preHandler: [fastify.authenticate],
          },
          async () => ({ data: "secret" }),
        );
      },
    });
    await app.ready();

    const token = issueToken({ id: "user-1", role: ["user"] });
    const res = await app.inject({
      method: "GET",
      url: "/items",
      headers: {
        ...authHeader(token),
        "x-arc-scope": "platform",
      },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("ELEVATION_FORBIDDEN");
  });

  it("unauthenticated request with elevation header gets 401 from auth (not elevation)", async () => {
    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: { platformRoles: ["superadmin"] },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        fastify.get(
          "/items",
          {
            preHandler: [fastify.authenticate],
          },
          async () => ({ data: "secret" }),
        );
      },
    });
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/items",
      headers: { "x-arc-scope": "platform" },
    });

    // Auth fails first (no token), returns 401
    expect(res.statusCode).toBe(401);
  });

  // ========================================================================
  // Audit callback
  // ========================================================================

  it("calls onElevation callback with correct event data", async () => {
    const elevationEvents: Array<{
      userId: string;
      organizationId?: string;
    }> = [];

    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: {
        platformRoles: ["superadmin"],
        onElevation: (event) => {
          elevationEvents.push({
            userId: event.userId,
            organizationId: event.organizationId,
          });
        },
      },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        fastify.get(
          "/items",
          {
            preHandler: [fastify.authenticate],
          },
          async () => ({ ok: true }),
        );
      },
    });
    await app.ready();

    const token = issueToken({ id: "admin-1", role: ["superadmin"] });
    await app.inject({
      method: "GET",
      url: "/items",
      headers: {
        ...authHeader(token),
        "x-arc-scope": "platform",
        "x-organization-id": "org-abc",
      },
    });

    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0].userId).toBe("admin-1");
    expect(elevationEvents[0].organizationId).toBe("org-abc");
  });

  // ========================================================================
  // Custom headers
  // ========================================================================

  it("supports custom header names", async () => {
    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: {
        platformRoles: ["superadmin"],
        scopeHeader: "x-custom-scope",
        orgHeader: "x-custom-org",
      },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        fastify.get(
          "/items",
          {
            preHandler: [fastify.authenticate],
          },
          async (request) => {
            const scope = (request as any).scope as RequestScope;
            return { kind: scope.kind, orgId: getOrgId(scope) };
          },
        );
      },
    });
    await app.ready();

    const token = issueToken({ id: "admin-1", role: ["superadmin"] });
    const res = await app.inject({
      method: "GET",
      url: "/items",
      headers: {
        ...authHeader(token),
        "x-custom-scope": "platform",
        "x-custom-org": "org-xyz",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.kind).toBe("elevated");
    expect(body.orgId).toBe("org-xyz");
  });

  // ========================================================================
  // Edge: No elevation config = normal behavior
  // ========================================================================

  it("without elevation config, authenticate works normally", async () => {
    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      // No elevation option
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        fastify.get(
          "/items",
          {
            preHandler: [fastify.authenticate],
          },
          async (request) => {
            return { scope: (request as any).scope };
          },
        );
      },
    });
    await app.ready();

    const token = issueToken({ id: "user-1", role: ["user"] });
    const res = await app.inject({
      method: "GET",
      url: "/items",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).scope.kind).toBe("authenticated");
  });

  // ========================================================================
  // Edge: Elevated without org header
  // ========================================================================

  it("elevated scope without org header gives global access (no orgId)", async () => {
    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      elevation: { platformRoles: ["superadmin"] },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        fastify.get(
          "/items",
          {
            preHandler: [fastify.authenticate],
          },
          async (request) => {
            const scope = (request as any).scope as RequestScope;
            return { kind: scope.kind, orgId: getOrgId(scope) };
          },
        );
      },
    });
    await app.ready();

    const token = issueToken({ id: "admin-1", role: ["superadmin"] });
    const res = await app.inject({
      method: "GET",
      url: "/items",
      headers: {
        ...authHeader(token),
        "x-arc-scope": "platform",
        // No x-organization-id header
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.kind).toBe("elevated");
    expect(body.orgId).toBeUndefined();
  });
});
