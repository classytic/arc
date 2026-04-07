/**
 * Auth Token Type Enforcement Tests
 *
 * Prevents token confusion attacks:
 * - Refresh tokens must NOT be accepted as access tokens
 * - Access tokens must NOT be accepted as refresh tokens
 * - issueTokens() must embed explicit type field
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { authPlugin } from "../../src/auth/authPlugin.js";

const JWT_SECRET = "a-secure-secret-that-is-at-least-32-chars-long!!";

describe("Auth Token Type Enforcement", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function createApp(
    opts: Record<string, unknown> = {},
    extraRoutes?: (instance: FastifyInstance) => void,
  ) {
    app = Fastify({ logger: false });
    await app.register(authPlugin, {
      jwt: { secret: JWT_SECRET },
      ...opts,
    });

    // Protected route for testing authenticate
    app.get("/protected", { preHandler: [app.authenticate] }, async (request) => {
      return { user: (request as any).user };
    });

    // Register extra routes before ready() — Fastify locks routing after ready
    if (extraRoutes) extraRoutes(app);

    await app.ready();
    return app;
  }

  describe("issueTokens()", () => {
    it("should embed type=access in access token", async () => {
      await createApp();

      const tokens = app.auth.issueTokens({ id: "user-1", role: ["admin"] });
      const decoded = app.auth.jwt?.decode<Record<string, unknown>>(tokens.accessToken);

      expect(decoded).not.toBeNull();
      expect(decoded?.type).toBe("access");
      expect(decoded?.id).toBe("user-1");
    });

    it("should embed type=refresh in refresh token", async () => {
      await createApp();

      const tokens = app.auth.issueTokens({ id: "user-1" });
      expect(tokens.refreshToken).toBeDefined();

      const decoded = app.auth.jwt?.decode<Record<string, unknown>>(tokens.refreshToken!);

      expect(decoded).not.toBeNull();
      expect(decoded?.type).toBe("refresh");
      expect(decoded?.id).toBe("user-1");
    });

    it("should return valid token pair with expiresIn", async () => {
      await createApp();

      const tokens = app.auth.issueTokens({ id: "user-1" });

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
      expect(tokens.expiresIn).toBeGreaterThan(0);
      expect(tokens.refreshExpiresIn).toBeGreaterThan(0);
      expect(tokens.tokenType).toBe("Bearer");
    });
  });

  describe("authenticate()", () => {
    it("should accept a valid access token", async () => {
      await createApp();

      const tokens = app.auth.issueTokens({ id: "user-1", role: ["admin"] });

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user.id).toBe("user-1");
      expect(body.user.type).toBe("access");
    });

    it("should REJECT a refresh token used as access token", async () => {
      await createApp();

      const tokens = app.auth.issueTokens({ id: "user-1" });

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: {
          authorization: `Bearer ${tokens.refreshToken}`,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe("Unauthorized");
    });

    it("should return 401 with no token", async () => {
      await createApp();

      const res = await app.inject({
        method: "GET",
        url: "/protected",
      });

      expect(res.statusCode).toBe(401);
    });

    it("should mirror custom userProperty to request.user for Arc compatibility", async () => {
      await createApp({ userProperty: "currentUser" }, (instance) => {
        instance.get(
          "/custom-user-prop",
          { preHandler: [instance.authenticate] },
          async (request) => {
            const req = request as unknown as {
              user?: { id?: string };
              currentUser?: { id?: string };
            };
            return {
              userId: req.user?.id,
              currentUserId: req.currentUser?.id,
            };
          },
        );
      });

      const tokens = app.auth.issueTokens({ id: "user-42" });
      const res = await app.inject({
        method: "GET",
        url: "/custom-user-prop",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.userId).toBe("user-42");
      expect(body.currentUserId).toBe("user-42");
    });
  });

  describe("verifyRefreshToken()", () => {
    it("should accept a valid refresh token", async () => {
      await createApp();

      const tokens = app.auth.issueTokens({ id: "user-1" });
      const decoded = app.auth.verifyRefreshToken<{ id: string; type: string }>(
        tokens.refreshToken!,
      );

      expect(decoded.id).toBe("user-1");
      expect(decoded.type).toBe("refresh");
    });

    it("should REJECT an access token used as refresh token", async () => {
      await createApp();

      const tokens = app.auth.issueTokens({ id: "user-1" });

      expect(() => {
        app.auth.verifyRefreshToken(tokens.accessToken);
      }).toThrow("Invalid token type: expected refresh token");
    });

    it("should reject an invalid token", async () => {
      await createApp();

      expect(() => {
        app.auth.verifyRefreshToken("invalid-token");
      }).toThrow();
    });
  });

  describe("error message hiding in production", () => {
    it("should show generic message when log level is not debug/trace", async () => {
      await createApp();

      const res = await app.inject({
        method: "GET",
        url: "/protected",
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      // Log level is false (disabled) in tests, so it should show generic message
      expect(body.message).toBe("Authentication required");
    });
  });
});
