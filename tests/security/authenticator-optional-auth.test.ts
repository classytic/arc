/**
 * Security Tests: Custom Authenticator + optionalAuthenticate
 *
 * Validates that auth: { type: 'authenticator' } properly decorates both
 * `authenticate` and `optionalAuthenticate`, so public routes (allowPublic)
 * correctly parse authenticated users for org-scoped filtering.
 *
 * Regression test for: custom authenticator breaking Arc's public-route
 * auth parsing contract, causing authenticated users on allowPublic()
 * multi-tenant routes to be treated as anonymous.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Custom Authenticator: optionalAuthenticate decoration", () => {
  let app: FastifyInstance;

  // Simple authenticator that sets user or sends 401
  async function myAuthenticator(request: FastifyRequest, reply: FastifyReply) {
    const token = request.headers.authorization;
    if (!token) {
      reply.code(401).send({ error: "No token" });
      return;
    }
    if (token === "Bearer valid-token") {
      (request as any).user = { id: "user-1", organizationId: "org-1" };
      (request as any).scope = {
        kind: "member",
        organizationId: "org-1",
        orgRoles: ["user"],
      };
    } else {
      reply.code(401).send({ error: "Invalid token" });
    }
  }

  beforeAll(async () => {
    const { createApp } = await import("../../src/factory/createApp.js");

    app = await createApp({
      preset: "development",
      auth: { type: "authenticator", authenticate: myAuthenticator },
      logger: false,
      helmet: false,
      rateLimit: false,
    });

    // Register a test route that uses optionalAuthenticate
    app.get("/public-test", {
      preHandler: [app.optionalAuthenticate as any],
      handler: async (request) => {
        return {
          hasUser: !!(request as any).user,
          userId: (request as any).user?.id ?? null,
          scope: (request as any).scope?.kind ?? "public",
          orgId: (request as any).scope?.organizationId ?? null,
        };
      },
    });

    // Register a protected test route
    app.get("/protected-test", {
      preHandler: [app.authenticate as any],
      handler: async (request) => {
        return {
          userId: (request as any).user?.id,
        };
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("should have both authenticate and optionalAuthenticate decorators", () => {
    expect(app.hasDecorator("authenticate")).toBe(true);
    expect(app.hasDecorator("optionalAuthenticate")).toBe(true);
  });

  it("optionalAuthenticate: authenticated user gets user/scope populated", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/public-test",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasUser).toBe(true);
    expect(body.userId).toBe("user-1");
    expect(body.scope).toBe("member");
    expect(body.orgId).toBe("org-1");
  });

  it("optionalAuthenticate: unauthenticated request continues as public", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/public-test",
      // No authorization header
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasUser).toBe(false);
    expect(body.userId).toBeNull();
    expect(body.scope).toBe("public");
  });

  it("optionalAuthenticate: invalid token continues as public (no 401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/public-test",
      headers: { authorization: "Bearer invalid-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasUser).toBe(false);
  });

  it("authenticate: still returns 401 for missing token on protected routes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected-test",
    });

    expect(res.statusCode).toBe(401);
  });

  it("authenticate: still returns 401 for invalid token on protected routes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected-test",
      headers: { authorization: "Bearer invalid-token" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("authenticate: allows valid token on protected routes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected-test",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.userId).toBe("user-1");
  });
});

describe("Custom Authenticator: explicit optionalAuthenticate", () => {
  let app: FastifyInstance;

  // Authenticator that throws instead of sending reply
  async function throwingAuth(request: FastifyRequest, _reply: FastifyReply) {
    const token = request.headers.authorization;
    if (!token || token !== "Bearer my-token") {
      throw new Error("Auth failed");
    }
    (request as any).user = { id: "user-2" };
    (request as any).scope = { kind: "authenticated" };
  }

  // Explicit optional authenticator
  async function optionalAuth(request: FastifyRequest, _reply: FastifyReply) {
    const token = request.headers.authorization;
    if (!token || token !== "Bearer my-token") {
      return; // Silently skip
    }
    (request as any).user = { id: "user-2" };
    (request as any).scope = { kind: "authenticated" };
  }

  beforeAll(async () => {
    const { createApp } = await import("../../src/factory/createApp.js");

    app = await createApp({
      preset: "development",
      auth: {
        type: "authenticator",
        authenticate: throwingAuth,
        optionalAuthenticate: optionalAuth,
      },
      logger: false,
      helmet: false,
      rateLimit: false,
    });

    app.get("/test", {
      preHandler: [app.optionalAuthenticate as any],
      handler: async (request) => ({
        hasUser: !!(request as any).user,
      }),
    });

    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("uses explicit optionalAuthenticate instead of auto-generated one", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test",
      // No auth header
    });

    // Should succeed because explicit optionalAuth silently skips
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasUser).toBe(false);
  });

  it("explicit optionalAuthenticate populates user when auth is present", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer my-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hasUser).toBe(true);
  });
});
