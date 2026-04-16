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

  // ==========================================================================
  // strictTokenType option (v2.9)
  //
  // Defence-in-depth against apps reusing the JWT secret to sign non-access
  // tokens (invite links, verification codes, legacy tokens from third-party
  // issuers). Default is `true` — only tokens with explicit `type: "access"`
  // pass. Set to `false` to re-enable the pre-2.9 lenient behavior that
  // accepted ANY non-refresh token.
  //
  // Security model:
  //   strict (default): `type === "access"` required. Everything else → 401.
  //   lenient:          `type === "refresh"` rejected. Everything else → OK.
  // ==========================================================================

  describe("strictTokenType (v2.9 default: true)", () => {
    it("rejects tokens with NO type claim (e.g. legacy issuer, invite links)", async () => {
      await createApp();
      // Raw token with no `type` field — signed with the same secret, so the
      // signature is valid. Pre-v2.9 this would have been accepted.
      const jwt = await import("jsonwebtoken");
      const legacyToken = jwt.default.sign({ id: "user-1" }, JWT_SECRET);

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${legacyToken}` },
      });

      expect(res.statusCode).toBe(401);
    });

    it("rejects tokens with UNEXPECTED type claim (e.g. type=invite, type=verify)", async () => {
      await createApp();
      const jwt = await import("jsonwebtoken");
      const inviteToken = jwt.default.sign({ id: "user-1", type: "invite" }, JWT_SECRET);

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${inviteToken}` },
      });

      expect(res.statusCode).toBe(401);
    });

    it("accepts arc-issued tokens (always stamped type=access)", async () => {
      await createApp();
      const tokens = app.auth.issueTokens({ id: "user-1" });

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it("still rejects refresh tokens even when type is set", async () => {
      // The refresh-token guard is independent of strictTokenType — it fires
      // FIRST, so turning off strict mode does NOT re-open this hole.
      await createApp();
      const tokens = app.auth.issueTokens({ id: "user-1" });

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${tokens.refreshToken}` },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe("strictTokenType: false (opt-in legacy mode)", () => {
    it("accepts tokens with no type claim when strictTokenType=false", async () => {
      await createApp({ strictTokenType: false });
      const jwt = await import("jsonwebtoken");
      const legacyToken = jwt.default.sign({ id: "user-1", role: "admin" }, JWT_SECRET);

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${legacyToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user.id).toBe("user-1");
    });

    it("accepts tokens with arbitrary type claim when strictTokenType=false", async () => {
      // Legacy behavior — any non-refresh token was accepted. Users who
      // deliberately opt in get that behavior back, not silently.
      await createApp({ strictTokenType: false });
      const jwt = await import("jsonwebtoken");
      const customToken = jwt.default.sign({ id: "user-1", type: "custom" }, JWT_SECRET);

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${customToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it("STILL rejects refresh tokens even in lenient mode", async () => {
      // Non-negotiable: refresh-token-as-access is a confused-deputy
      // vulnerability regardless of strictTokenType.
      await createApp({ strictTokenType: false });
      const tokens = app.auth.issueTokens({ id: "user-1" });

      const res = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: `Bearer ${tokens.refreshToken}` },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe("strictTokenType on optional-auth routes", () => {
    it("silently treats no-type tokens as unauthenticated in strict mode", async () => {
      // Optional-auth = 'authenticateOptional'. The strict check there must
      // stay non-throwing so public routes keep working — the token just
      // gets ignored as if absent.
      await createApp({}, (instance) => {
        instance.get(
          "/optional",
          { preHandler: [instance.optionalAuthenticate] },
          async (request) => {
            const user = (request as { user?: { id?: string } }).user;
            return { authed: !!user, id: user?.id };
          },
        );
      });
      const jwt = await import("jsonwebtoken");
      const legacyToken = jwt.default.sign({ id: "user-1" }, JWT_SECRET);

      const res = await app.inject({
        method: "GET",
        url: "/optional",
        headers: { authorization: `Bearer ${legacyToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.authed).toBe(false);
      expect(body.id).toBeUndefined();
    });

    it("honors lenient mode on optional-auth routes too", async () => {
      await createApp({ strictTokenType: false }, (instance) => {
        instance.get(
          "/optional-lenient",
          { preHandler: [instance.optionalAuthenticate] },
          async (request) => {
            const user = (request as { user?: { id?: string } }).user;
            return { authed: !!user, id: user?.id };
          },
        );
      });
      const jwt = await import("jsonwebtoken");
      const legacyToken = jwt.default.sign({ id: "user-1" }, JWT_SECRET);

      const res = await app.inject({
        method: "GET",
        url: "/optional-lenient",
        headers: { authorization: `Bearer ${legacyToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.authed).toBe(true);
      expect(body.id).toBe("user-1");
    });
  });
});
