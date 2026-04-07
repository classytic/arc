/**
 * Auth Error Detail Exposure Tests
 *
 * Verifies that auth error detail exposure is controlled by an explicit
 * `exposeAuthErrors` option, not tied to log level.
 *
 * Scenarios:
 * - Default (exposeAuthErrors: false) → generic "Authentication required"
 * - exposeAuthErrors: true → detailed error message
 * - JWT auth (authPlugin) with both settings
 * - Better Auth adapter with both settings
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { authPlugin } from "../../src/auth/authPlugin.js";
import { type BetterAuthHandler, createBetterAuthAdapter } from "../../src/auth/betterAuth.js";

const JWT_SECRET = "a-secure-secret-that-is-at-least-32-chars-long!!";

describe("Auth Error Detail Exposure", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  // --------------------------------------------------------------------------
  // JWT Auth Plugin (authPlugin)
  // --------------------------------------------------------------------------

  describe("JWT authPlugin", () => {
    async function createJwtApp(exposeAuthErrors?: boolean) {
      app = Fastify({ logger: false });
      await app.register(authPlugin, {
        jwt: { secret: JWT_SECRET },
        exposeAuthErrors,
      });

      app.get(
        "/protected",
        {
          preHandler: [app.authenticate],
        },
        async () => ({ ok: true }),
      );

      await app.ready();
      return app;
    }

    it("should hide error details by default (exposeAuthErrors unset)", async () => {
      await createJwtApp();

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer invalid.token.here" },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Authentication required");
      expect(body.message).not.toContain("jwt");
    });

    it("should hide error details when exposeAuthErrors is false", async () => {
      await createJwtApp(false);

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer invalid.token.here" },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Authentication required");
    });

    it("should expose error details when exposeAuthErrors is true", async () => {
      await createJwtApp(true);

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer invalid.token.here" },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      // Should contain the actual JWT error, not the generic message
      expect(body.message).not.toBe("Authentication required");
      expect(body.message.length).toBeGreaterThan(0);
    });

    it("should hide details even with debug log level when exposeAuthErrors is false", async () => {
      // This verifies the decoupling — log level should NOT affect error exposure
      app = Fastify({ logger: { level: "debug" } });
      await app.register(authPlugin, {
        jwt: { secret: JWT_SECRET },
        exposeAuthErrors: false,
      });

      app.get(
        "/protected",
        {
          preHandler: [app.authenticate],
        },
        async () => ({ ok: true }),
      );

      await app.ready();

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer bad-token" },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Authentication required");
    });

    it("should return 401 with generic message when no token provided", async () => {
      await createJwtApp(false);

      const res = await app.inject({
        method: "GET",
        url: "/protected",
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Authentication required");
    });
  });

  // --------------------------------------------------------------------------
  // Better Auth Adapter
  // --------------------------------------------------------------------------

  describe("Better Auth adapter", () => {
    /** Auth handler that throws an exception (simulates network/runtime failure) */
    function createThrowingAuthHandler(): BetterAuthHandler {
      return {
        handler: async () => {
          throw new Error("ECONNREFUSED: auth service unreachable");
        },
      };
    }

    async function createBetterAuthApp(exposeAuthErrors?: boolean) {
      app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({
        auth: createThrowingAuthHandler(),
        exposeAuthErrors,
      });
      await app.register(plugin);

      app.get(
        "/protected",
        {
          preHandler: [app.authenticate],
        },
        async () => ({ ok: true }),
      );

      await app.ready();
      return app;
    }

    it("should hide error details by default", async () => {
      await createBetterAuthApp();

      const res = await app.inject({
        method: "GET",
        url: "/protected",
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Authentication required");
    });

    it("should hide error details when exposeAuthErrors is false", async () => {
      await createBetterAuthApp(false);

      const res = await app.inject({
        method: "GET",
        url: "/protected",
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Authentication required");
    });

    it("should expose error details when exposeAuthErrors is true", async () => {
      await createBetterAuthApp(true);

      const res = await app.inject({
        method: "GET",
        url: "/protected",
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      // Should contain the actual error, not the generic message
      expect(body.message).toContain("ECONNREFUSED");
    });
  });
});
