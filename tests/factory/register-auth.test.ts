/**
 * registerAuth — Unit Tests
 *
 * Tests decorateRequestScope, registerAuth, registerElevation, registerErrorHandler
 * in isolation with a real Fastify instance.
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  decorateRequestScope,
  registerAuth,
  registerElevation,
  registerErrorHandler,
} from "../../src/factory/registerAuth.js";
import { PUBLIC_SCOPE } from "../../src/scope/types.js";

const noopTrack = () => {};

function createTestFastify(): FastifyInstance {
  return Fastify({ logger: false });
}

/** Register arc core (required by registerAuth for fastify.arc) */
async function withArcCore(app: FastifyInstance): Promise<FastifyInstance> {
  const { arcCorePlugin } = await import("../../src/plugins/index.js");
  await app.register(arcCorePlugin, { emitEvents: false });
  return app;
}

describe("decorateRequestScope", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("decorates request.scope with PUBLIC_SCOPE default", async () => {
    app = createTestFastify();
    decorateRequestScope(app);

    let capturedScope: unknown;
    app.get("/test", async (request) => {
      capturedScope = request.scope;
      return { ok: true };
    });
    await app.ready();

    await app.inject({ method: "GET", url: "/test" });
    expect(capturedScope).toEqual(PUBLIC_SCOPE);
  });

  it("does not overwrite scope if already set", async () => {
    app = createTestFastify();
    decorateRequestScope(app);

    const customScope = { kind: "authenticated" as const, userId: "123", roles: ["admin"] };
    app.addHook("onRequest", async (request) => {
      request.scope = customScope as unknown as typeof request.scope;
    });

    let capturedScope: unknown;
    app.get("/test", async (request) => {
      capturedScope = request.scope;
      return { ok: true };
    });
    await app.ready();

    await app.inject({ method: "GET", url: "/test" });
    // Custom scope survives — decorateRequestScope only sets if falsy
    expect(capturedScope).toEqual(customScope);
  });
});

describe("registerAuth", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("auth: false — no authenticate decorator", async () => {
    app = createTestFastify();
    await withArcCore(app);
    await registerAuth(app, { auth: false }, noopTrack);
    await app.ready();

    expect(app.hasDecorator("authenticate")).toBe(false);
  });

  it("auth: undefined — no authenticate decorator", async () => {
    app = createTestFastify();
    await withArcCore(app);
    await registerAuth(app, {}, noopTrack);
    await app.ready();

    expect(app.hasDecorator("authenticate")).toBe(false);
  });

  it("type: 'authenticator' — decorates authenticate", async () => {
    app = createTestFastify();
    await withArcCore(app);

    const mockAuth = async (request: FastifyRequest, _reply: FastifyReply) => {
      request.user = { id: "user-1", role: "admin" };
    };

    await registerAuth(
      app,
      { auth: { type: "authenticator", authenticate: mockAuth } },
      noopTrack,
    );
    await app.ready();

    expect(app.hasDecorator("authenticate")).toBe(true);
    expect(app.hasDecorator("optionalAuthenticate")).toBe(true);
  });

  it("type: 'authenticator' — authenticate runs correctly", async () => {
    app = createTestFastify();
    await withArcCore(app);

    const mockAuth = async (request: FastifyRequest, _reply: FastifyReply) => {
      const token = request.headers.authorization;
      if (!token) {
        throw new Error("No token");
      }
      request.user = { id: "user-1" };
    };

    decorateRequestScope(app);
    await registerAuth(
      app,
      { auth: { type: "authenticator", authenticate: mockAuth } },
      noopTrack,
    );

    app.get("/protected", {
      preHandler: [app.authenticate],
    }, async (request) => {
      return { user: request.user };
    });
    await app.ready();

    // With token
    const okRes = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer test" },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().user.id).toBe("user-1");

    // Without token
    const failRes = await app.inject({ method: "GET", url: "/protected" });
    expect(failRes.statusCode).toBe(500); // Throws, Fastify wraps as 500
  });

  it("type: 'authenticator' — optionalAuthenticate ignores auth failure", async () => {
    app = createTestFastify();
    await withArcCore(app);

    const mockAuth = async (request: FastifyRequest, reply: FastifyReply) => {
      const token = request.headers.authorization;
      if (!token) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      request.user = { id: "user-1" };
    };

    decorateRequestScope(app);
    await registerAuth(
      app,
      { auth: { type: "authenticator", authenticate: mockAuth } },
      noopTrack,
    );

    app.get("/public", {
      preHandler: [app.optionalAuthenticate],
    }, async (request) => {
      return { user: request.user ?? null };
    });
    await app.ready();

    // Without token — should still succeed (optional auth)
    const res = await app.inject({ method: "GET", url: "/public" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toBeNull();

    // With token — should have user
    const authRes = await app.inject({
      method: "GET",
      url: "/public",
      headers: { authorization: "Bearer test" },
    });
    expect(authRes.statusCode).toBe(200);
    expect(authRes.json().user.id).toBe("user-1");
  });

  it("type: 'authenticator' — custom optionalAuthenticate used when provided", async () => {
    app = createTestFastify();
    await withArcCore(app);

    let customOptionalCalled = false;

    await registerAuth(
      app,
      {
        auth: {
          type: "authenticator",
          authenticate: async () => {},
          optionalAuthenticate: async () => {
            customOptionalCalled = true;
          },
        },
      },
      noopTrack,
    );

    app.get("/test", { preHandler: [app.optionalAuthenticate] }, async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: "GET", url: "/test" });
    expect(customOptionalCalled).toBe(true);
  });

  it("type: 'jwt' — decorates authenticate via auth plugin", async () => {
    app = createTestFastify();
    await withArcCore(app);

    await registerAuth(
      app,
      { auth: { type: "jwt", jwt: { secret: "test-secret-32-chars-minimum-len" } } },
      noopTrack,
    );
    await app.ready();

    expect(app.hasDecorator("authenticate")).toBe(true);
  });

  it("type: 'custom' — registers user plugin", async () => {
    app = createTestFastify();
    await withArcCore(app);

    let pluginRegistered = false;

    await registerAuth(
      app,
      {
        auth: {
          type: "custom",
          plugin: async () => {
            pluginRegistered = true;
          },
        },
      },
      noopTrack,
    );
    await app.ready();

    expect(pluginRegistered).toBe(true);
  });

  it("auto-generated optionalAuthenticate intercepts reply.code(401).send()", async () => {
    // This specifically tests the Proxy in createOptionalAuthenticate:
    // authenticators that call reply.code(401).send() instead of throwing
    // must be silently intercepted so the request proceeds as public.
    app = createTestFastify();
    await withArcCore(app);

    const replyBasedAuth = async (request: FastifyRequest, reply: FastifyReply) => {
      const token = request.headers.authorization;
      if (!token) {
        // This pattern calls reply.code().send() — the Proxy must intercept it
        reply.code(401).send({ error: "No token" });
        return;
      }
      request.user = { id: "user-1" };
    };

    decorateRequestScope(app);
    await registerAuth(
      app,
      { auth: { type: "authenticator", authenticate: replyBasedAuth } },
      noopTrack,
    );

    app.get("/optional", {
      preHandler: [app.optionalAuthenticate],
    }, async (request) => {
      return { authenticated: !!request.user, user: request.user ?? null };
    });
    await app.ready();

    // No token — optionalAuthenticate intercepts 401, request continues as public
    const noAuth = await app.inject({ method: "GET", url: "/optional" });
    expect(noAuth.statusCode).toBe(200);
    expect(noAuth.json().authenticated).toBe(false);

    // With token — authenticates normally
    const withAuth = await app.inject({
      method: "GET",
      url: "/optional",
      headers: { authorization: "Bearer valid" },
    });
    expect(withAuth.statusCode).toBe(200);
    expect(withAuth.json().authenticated).toBe(true);
    expect(withAuth.json().user.id).toBe("user-1");
  });

  it("auto-generated optionalAuthenticate intercepts reply.code(403).send()", async () => {
    app = createTestFastify();
    await withArcCore(app);

    const forbidAuth = async (_request: FastifyRequest, reply: FastifyReply) => {
      // Always forbidden
      reply.code(403).send({ error: "Forbidden" });
    };

    decorateRequestScope(app);
    await registerAuth(
      app,
      { auth: { type: "authenticator", authenticate: forbidAuth } },
      noopTrack,
    );

    app.get("/test", {
      preHandler: [app.optionalAuthenticate],
    }, async () => {
      return { ok: true };
    });
    await app.ready();

    // 403 intercepted — request proceeds
    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("auto-generated optionalAuthenticate intercepts thrown errors", async () => {
    app = createTestFastify();
    await withArcCore(app);

    const throwingAuth = async () => {
      throw new Error("Token expired");
    };

    decorateRequestScope(app);
    await registerAuth(
      app,
      { auth: { type: "authenticator", authenticate: throwingAuth } },
      noopTrack,
    );

    app.get("/test", {
      preHandler: [app.optionalAuthenticate],
    }, async () => {
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
  });

  it("tracks plugin name via trackPlugin callback", async () => {
    app = createTestFastify();
    await withArcCore(app);

    const tracked: string[] = [];
    const track = (name: string) => tracked.push(name);

    await registerAuth(
      app,
      { auth: { type: "jwt", jwt: { secret: "test-secret-32-chars-minimum-len" } } },
      track,
    );

    expect(tracked).toContain("auth-jwt");
  });
});

describe("registerErrorHandler", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("registers error handler by default", async () => {
    app = createTestFastify();
    await withArcCore(app);

    await registerErrorHandler(app, {}, noopTrack);

    app.get("/error", async () => {
      throw new Error("test error");
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/error" });
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
  });

  it("skips when errorHandler: false", async () => {
    app = createTestFastify();
    await withArcCore(app);

    await registerErrorHandler(app, { errorHandler: false }, noopTrack);
    await app.ready();
    // No error — just no custom handler registered
  });

  it("passes includeStack: false for production preset", async () => {
    app = createTestFastify();
    await withArcCore(app);

    await registerErrorHandler(app, { preset: "production" }, noopTrack);

    app.get("/error", async () => {
      throw new Error("prod error");
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/error" });
    const body = res.json();
    expect(body.success).toBe(false);
    // Stack should not be in production response
    expect(body.stack).toBeUndefined();
  });
});
