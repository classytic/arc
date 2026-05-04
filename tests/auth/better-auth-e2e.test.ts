/**
 * Better Auth E2E Integration Tests
 *
 * Comprehensive tests modeled after a real production auth config
 * (be-prod/auth.config.ts) covering:
 *
 * - Email+password sign-up/sign-in
 * - Bearer token auth (API key style)
 * - Cookie-based session auth (browser)
 * - Multi-org context (branches as organizations)
 * - CORS with cookies from different origins
 * - Strict origin enforcement
 * - scope.userId / scope.userRoles populated correctly
 * - optionalAuthenticate for public routes
 *
 * These tests use mock Better Auth handlers that simulate real BA responses
 * without requiring a database. The mock faithfully reproduces the HTTP
 * contract that BA exposes (get-session, sign-in, sign-up, org membership).
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type BetterAuthHandler, createBetterAuthAdapter } from "../../src/auth/betterAuth.js";

// ============================================================================
// Mock Better Auth handler — simulates real BA HTTP responses
// ============================================================================

interface MockUser {
  id: string;
  name: string;
  email: string;
  role?: string;
  phone?: string;
  isActive?: boolean;
}

interface MockSession {
  id: string;
  userId: string;
  activeOrganizationId?: string | null;
  expiresAt: string;
}

interface MockOrg {
  id: string;
  name: string;
  slug: string;
}

interface MockMember {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
}

interface MockAuthState {
  users: MockUser[];
  sessions: Map<string, { user: MockUser; session: MockSession }>;
  orgs: MockOrg[];
  members: MockMember[];
  bearerTokens: Map<string, MockUser>;
}

function createMockBetterAuth(
  opts: { users?: MockUser[]; orgs?: MockOrg[]; members?: MockMember[] } = {},
): { handler: BetterAuthHandler; state: MockAuthState } {
  const state: MockAuthState = {
    users: opts.users ?? [],
    sessions: new Map(),
    orgs: opts.orgs ?? [],
    members: opts.members ?? [],
    bearerTokens: new Map(),
  };

  // Seed bearer tokens for users (simulates bearer plugin)
  for (const user of state.users) {
    state.bearerTokens.set(`bearer_${user.id}`, user);
  }

  const handler: BetterAuthHandler = {
    handler: async (request: Request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // Extract session cookie or bearer token
      const cookies = request.headers.get("cookie") ?? "";
      const sessionCookie = cookies.match(/better-auth\.session_token=([^;]+)/)?.[1];
      const authHeader = request.headers.get("authorization") ?? "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

      // ---------- GET /get-session ----------
      if (path.endsWith("/get-session") && method === "GET") {
        // Try session cookie first
        if (sessionCookie && state.sessions.has(sessionCookie)) {
          const { user, session } = state.sessions.get(sessionCookie)!;
          return jsonResponse({ user, session });
        }

        // Try bearer token
        if (bearerToken && state.bearerTokens.has(bearerToken)) {
          const user = state.bearerTokens.get(bearerToken)!;
          return jsonResponse({
            user,
            session: {
              id: `bearer-session-${user.id}`,
              userId: user.id,
              activeOrganizationId: null,
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
          });
        }

        return jsonResponse({ error: "Not authenticated" }, 401);
      }

      // ---------- POST /sign-up/email ----------
      if (path.endsWith("/sign-up/email") && method === "POST") {
        const body = (await request.json()) as Record<string, string>;
        const existing = state.users.find((u) => u.email === body.email);
        if (existing) {
          return jsonResponse({ error: "User already exists" }, 400);
        }

        const newUser: MockUser = {
          id: `user_${Date.now()}`,
          name: body.name,
          email: body.email,
          role: "user",
          isActive: true,
        };
        state.users.push(newUser);
        state.bearerTokens.set(`bearer_${newUser.id}`, newUser);

        // Create session
        const sessionToken = `session_${Date.now()}`;
        const session: MockSession = {
          id: `sess_${Date.now()}`,
          userId: newUser.id,
          activeOrganizationId: null,
          expiresAt: new Date(Date.now() + 604800000).toISOString(), // 7 days
        };
        state.sessions.set(sessionToken, { user: newUser, session });

        return jsonResponse({ user: newUser, session }, 200, {
          "set-cookie": `better-auth.session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`,
        });
      }

      // ---------- POST /sign-in/email ----------
      if (path.endsWith("/sign-in/email") && method === "POST") {
        const body = (await request.json()) as Record<string, string>;
        const user = state.users.find((u) => u.email === body.email);
        if (!user) {
          return jsonResponse({ error: "Invalid credentials" }, 401);
        }

        const sessionToken = `session_${Date.now()}`;
        const session: MockSession = {
          id: `sess_${Date.now()}`,
          userId: user.id,
          activeOrganizationId: null,
          expiresAt: new Date(Date.now() + 604800000).toISOString(),
        };
        state.sessions.set(sessionToken, { user, session });

        return jsonResponse({ user, session }, 200, {
          "set-cookie": `better-auth.session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`,
        });
      }

      // ---------- POST /organization/set-active ----------
      if (path.endsWith("/organization/set-active") && method === "POST") {
        const body = (await request.json()) as Record<string, string>;
        const orgId = body.organizationId;

        // Find session
        const sessionEntry = sessionCookie ? state.sessions.get(sessionCookie) : null;
        if (!sessionEntry) return jsonResponse({ error: "Not authenticated" }, 401);

        // Update session's active org
        sessionEntry.session.activeOrganizationId = orgId;
        return jsonResponse({ ...sessionEntry.session, activeOrganizationId: orgId });
      }

      // ---------- GET /organization/get-active-member ----------
      if (path.endsWith("/organization/get-active-member") && method === "GET") {
        const sessionEntry = sessionCookie ? state.sessions.get(sessionCookie) : null;
        if (!sessionEntry) return jsonResponse(null, 200);

        const orgId = sessionEntry.session.activeOrganizationId;
        if (!orgId) return jsonResponse(null, 200);

        const member = state.members.find(
          (m) => m.userId === sessionEntry.user.id && m.organizationId === orgId,
        );
        if (!member) return jsonResponse(null, 200);

        return jsonResponse({ role: member.role });
      }

      // ---------- GET /organization/list-members ----------
      if (path.endsWith("/organization/list-members") && method === "GET") {
        const sessionEntry = sessionCookie ? state.sessions.get(sessionCookie) : null;
        if (!sessionEntry) return jsonResponse({ error: "Not authenticated" }, 401);

        const orgId = sessionEntry.session.activeOrganizationId;
        const members = state.members.filter((m) => m.organizationId === orgId);
        return jsonResponse(members);
      }

      // Catch-all
      return jsonResponse({ path, method }, 200);
    },
    // Direct in-process API used by arc's authenticate. Mirrors the HTTP routes
    // above against the same `state`. Real betterAuth() instances expose this
    // map natively — the mock just simulates it.
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookies = headers.get("cookie") ?? "";
        const sessionCookie = cookies.match(/better-auth\.session_token=([^;]+)/)?.[1];
        if (sessionCookie && state.sessions.has(sessionCookie)) {
          return state.sessions.get(sessionCookie)!;
        }
        const authHeader = headers.get("authorization") ?? "";
        const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (bearerToken && state.bearerTokens.has(bearerToken)) {
          const user = state.bearerTokens.get(bearerToken)!;
          return {
            user,
            session: {
              id: `bearer-session-${user.id}`,
              userId: user.id,
              activeOrganizationId: null,
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
          };
        }
        return null;
      },
      organization: {
        getActiveMember: async ({ headers }: { headers: Headers }) => {
          const cookies = headers.get("cookie") ?? "";
          const sessionCookie = cookies.match(/better-auth\.session_token=([^;]+)/)?.[1];
          const sessionEntry = sessionCookie ? state.sessions.get(sessionCookie) : null;
          if (!sessionEntry) return null;
          const orgId = sessionEntry.session.activeOrganizationId;
          if (!orgId) return null;
          const member = state.members.find(
            (m) => m.userId === sessionEntry.user.id && m.organizationId === orgId,
          );
          return member ? { role: member.role } : null;
        },
      },
    },
  };

  return { handler, state };
}

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

// ============================================================================
// Test helpers
// ============================================================================

async function buildApp(
  authHandler: BetterAuthHandler,
  corsConfig: unknown = { origin: true, credentials: true },
  orgContext = true,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register CORS first
  if (corsConfig !== false) {
    const cors = await import("@fastify/cors");
    await app.register(cors.default ?? cors, corsConfig as any);
  }

  const { plugin } = createBetterAuthAdapter({
    auth: authHandler,
    orgContext,
  });
  await app.register(plugin);

  // Test routes
  app.get("/protected", { preHandler: [app.authenticate] }, async (request) => {
    return {
      user: (request as any).user,
      scope: (request as any).scope,
    };
  });

  app.get("/public", { preHandler: [app.optionalAuthenticate] }, async (request) => {
    return {
      user: (request as any).user ?? null,
      scope: (request as any).scope,
    };
  });

  await app.ready();
  return app;
}

// ============================================================================
// Tests
// ============================================================================

describe("Better Auth E2E — Email + Password", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should sign up a new user and return session cookie", async () => {
    const { handler } = createMockBetterAuth();
    app = await buildApp(handler);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: "Jane Doe", email: "jane@example.com", password: "secret123" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.email).toBe("jane@example.com");
    expect(body.user.name).toBe("Jane Doe");

    // Should set session cookie
    const setCookie = res.headers["set-cookie"] as string;
    expect(setCookie).toContain("better-auth.session_token");
    expect(setCookie).toContain("HttpOnly");
  });

  it("should sign in with email+password and return session cookie", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "Admin", email: "admin@example.com", role: "superadmin" }],
    });
    app = await buildApp(handler);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "admin@example.com", password: "admin123" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.email).toBe("admin@example.com");
    expect(res.headers["set-cookie"]).toContain("better-auth.session_token");
  });

  it("should reject sign-in with unknown email", async () => {
    const { handler } = createMockBetterAuth();
    app = await buildApp(handler);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "nobody@example.com", password: "wrong" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("should reject duplicate sign-up", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "Existing", email: "exists@example.com" }],
    });
    app = await buildApp(handler);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: "Dup", email: "exists@example.com", password: "pass" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("Better Auth E2E — Cookie-based session auth", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should authenticate protected route with session cookie", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "User", email: "user@example.com", role: "user" }],
    });
    app = await buildApp(handler);

    // Sign in first
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "user@example.com", password: "pass" },
    });
    const cookie = (signIn.headers["set-cookie"] as string).split(";")[0]!;

    // Access protected route with cookie
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.email).toBe("user@example.com");
    expect(body.scope.kind).toBe("authenticated");
    expect(body.scope.userId).toBe("u1");
  });

  it("should reject protected route without cookie", async () => {
    const { handler } = createMockBetterAuth();
    app = await buildApp(handler);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
    });

    expect(res.statusCode).toBe(401);
  });

  it("should allow public route without cookie (optionalAuthenticate)", async () => {
    const { handler } = createMockBetterAuth();
    app = await buildApp(handler);

    const res = await app.inject({
      method: "GET",
      url: "/public",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user).toBeNull();
  });

  it("should populate user on public route when cookie is present", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "OptUser", email: "opt@example.com", role: "user" }],
    });
    app = await buildApp(handler);

    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "opt@example.com", password: "pass" },
    });
    const cookie = (signIn.headers["set-cookie"] as string).split(";")[0]!;

    const res = await app.inject({
      method: "GET",
      url: "/public",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.email).toBe("opt@example.com");
  });
});

describe("Better Auth E2E — Bearer token auth", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should authenticate with bearer token (API key style)", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "api-user", name: "API Bot", email: "bot@example.com", role: "user" }],
    });
    app = await buildApp(handler);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer bearer_api-user" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.id).toBe("api-user");
    expect(body.user.email).toBe("bot@example.com");
  });

  it("should reject invalid bearer token", async () => {
    const { handler } = createMockBetterAuth();
    app = await buildApp(handler);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer invalid_token" },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("Better Auth E2E — Multi-org (branches)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should set member scope when user has active org with membership", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "Staff", email: "staff@example.com", role: "user" }],
      orgs: [
        { id: "org-hq", name: "HQ Branch", slug: "hq" },
        { id: "org-branch1", name: "Branch 1", slug: "branch-1" },
      ],
      members: [
        { id: "m1", userId: "u1", organizationId: "org-hq", role: "branch_manager" },
        { id: "m2", userId: "u1", organizationId: "org-branch1", role: "cashier" },
      ],
    });
    app = await buildApp(handler);

    // Sign in
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "staff@example.com", password: "pass" },
    });
    const cookie = (signIn.headers["set-cookie"] as string).split(";")[0]!;

    // Set active org to HQ
    await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie },
      payload: { organizationId: "org-hq" },
    });

    // Access protected route — should have member scope with branch_manager role
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scope).toMatchObject({
      kind: "member",
      organizationId: "org-hq",
      orgRoles: ["branch_manager"],
    });
    expect(body.scope.userId).toBe("u1");
  });

  it("should switch org context when user changes active org", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "Multi", email: "multi@example.com", role: "user" }],
      orgs: [
        { id: "org-a", name: "Org A", slug: "a" },
        { id: "org-b", name: "Org B", slug: "b" },
      ],
      members: [
        { id: "m1", userId: "u1", organizationId: "org-a", role: "admin" },
        { id: "m2", userId: "u1", organizationId: "org-b", role: "viewer" },
      ],
    });
    app = await buildApp(handler);

    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "multi@example.com", password: "pass" },
    });
    const cookie = (signIn.headers["set-cookie"] as string).split(";")[0]!;

    // Set active org A
    await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie },
      payload: { organizationId: "org-a" },
    });

    const resA = await app.inject({ method: "GET", url: "/protected", headers: { cookie } });
    expect(JSON.parse(resA.body).scope.orgRoles).toEqual(["admin"]);

    // Switch to org B
    await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie },
      payload: { organizationId: "org-b" },
    });

    const resB = await app.inject({ method: "GET", url: "/protected", headers: { cookie } });
    expect(JSON.parse(resB.body).scope.orgRoles).toEqual(["viewer"]);
    expect(JSON.parse(resB.body).scope.organizationId).toBe("org-b");
  });

  it("should set authenticated scope when no active org is selected", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "NoOrg", email: "noorg@example.com", role: "user" }],
    });
    app = await buildApp(handler);

    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "noorg@example.com", password: "pass" },
    });
    const cookie = (signIn.headers["set-cookie"] as string).split(";")[0]!;

    const res = await app.inject({ method: "GET", url: "/protected", headers: { cookie } });
    const body = JSON.parse(res.body);

    expect(body.scope.kind).toBe("authenticated");
    expect(body.scope.userId).toBe("u1");
  });
});

describe("Better Auth E2E — scope.userId and scope.userRoles", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should populate userRoles from user.role (comma-separated)", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "Admin", email: "admin@ex.com", role: "superadmin,finance-admin" }],
    });
    app = await buildApp(handler);

    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "admin@ex.com", password: "pass" },
    });
    const cookie = (signIn.headers["set-cookie"] as string).split(";")[0]!;

    const res = await app.inject({ method: "GET", url: "/protected", headers: { cookie } });
    const body = JSON.parse(res.body);

    expect(body.scope.userId).toBe("u1");
    expect(body.scope.userRoles).toEqual(["superadmin", "finance-admin"]);
  });

  it("should have empty userRoles when user has no role field", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "Basic", email: "basic@ex.com" }], // No role
    });
    app = await buildApp(handler);

    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "basic@ex.com", password: "pass" },
    });
    const cookie = (signIn.headers["set-cookie"] as string).split(";")[0]!;

    const res = await app.inject({ method: "GET", url: "/protected", headers: { cookie } });
    const body = JSON.parse(res.body);

    expect(body.scope.userRoles).toEqual([]);
  });

  it("should populate userId from bearer token user", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "bot-123", name: "Bot", email: "bot@ex.com", role: "service" }],
    });
    app = await buildApp(handler);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer bearer_bot-123" },
    });

    const body = JSON.parse(res.body);
    expect(body.scope.userId).toBe("bot-123");
    expect(body.scope.userRoles).toEqual(["service"]);
  });
});

describe("Better Auth E2E — CORS with cookies from different origins", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should allow cookie-based auth from allowed origin", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "User", email: "user@ex.com" }],
    });
    app = await buildApp(handler, {
      origin: ["https://dashboard.myapp.com", "https://admin.myapp.com"],
      credentials: true,
    });

    // Sign in
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: "https://dashboard.myapp.com" },
      payload: { email: "user@ex.com", password: "pass" },
    });

    expect(signIn.headers["access-control-allow-origin"]).toBe("https://dashboard.myapp.com");
    expect(signIn.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("should not reflect CORS for non-allowed origin", async () => {
    const { handler } = createMockBetterAuth();
    app = await buildApp(handler, {
      origin: ["https://trusted.myapp.com"],
      credentials: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: "https://evil.com" },
      payload: { email: "x@x.com", password: "x" },
    });

    // @fastify/cors with array origin doesn't reflect non-matching origins
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("should handle preflight from microservice origin", async () => {
    const { handler } = createMockBetterAuth();
    app = await buildApp(handler, {
      origin: [
        "https://web.myapp.com",
        "https://mobile-api.myapp.com",
        /^https:\/\/.*\.myapp\.com$/,
      ],
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      allowedHeaders: ["Content-Type", "Authorization", "x-organization-id"],
    });

    // Preflight from microservice
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/sign-in/email",
      headers: {
        origin: "https://checkout-svc.myapp.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://checkout-svc.myapp.com");
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("should work with wildcard origin and credentials (smart CORS)", async () => {
    const { handler } = createMockBetterAuth({
      users: [{ id: "u1", name: "Dev", email: "dev@ex.com" }],
    });

    // Simulate dev environment: origin: '*', credentials: true
    // Arc's smart CORS converts this to origin: true
    const corsApp = Fastify({ logger: false });
    const cors = await import("@fastify/cors");

    // Manually apply the smart CORS logic (same as createApp does)
    const corsOpts: Record<string, unknown> = { origin: "*", credentials: true };
    if (corsOpts.credentials && corsOpts.origin === "*") {
      corsOpts.origin = true;
    }
    await corsApp.register(cors.default ?? cors, corsOpts as any);

    const { plugin } = createBetterAuthAdapter({ auth: handler, orgContext: false });
    await corsApp.register(plugin);
    corsApp.get("/test", { preHandler: [corsApp.authenticate] }, async (_req) => ({ ok: true }));
    await corsApp.ready();

    const res = await corsApp.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: {
        origin: "http://localhost:5173",
        authorization: "Bearer bearer_u1",
      },
    });

    // Should reflect the origin, not literal '*'
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");

    await corsApp.close();
    app = null as any;
  });

  it("strict origin should reject unknown origins for auth endpoints", async () => {
    const { handler } = createMockBetterAuth();
    app = await buildApp(handler, {
      origin: ["https://app.production.com"],
      credentials: true,
    });

    // Sign-in attempt from unknown origin
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: "https://attacker-site.com" },
      payload: { email: "victim@ex.com", password: "stolen" },
    });

    // No CORS header — browser would block the response
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("Better Auth E2E — Full sign-up → sign-in → org → protected flow", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("should handle complete user lifecycle", async () => {
    const { handler, state } = createMockBetterAuth({
      orgs: [{ id: "org-hq", name: "HQ", slug: "hq" }],
    });
    app = await buildApp(handler);

    // 1. Sign up
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: "New Employee", email: "new@example.com", password: "pass123" },
    });
    expect(signUp.statusCode).toBe(200);
    const newUser = JSON.parse(signUp.body).user;
    const cookie = (signUp.headers["set-cookie"] as string).split(";")[0]!;

    // 2. Add user as member of org (server-side simulation)
    state.members.push({
      id: "m-new",
      userId: newUser.id,
      organizationId: "org-hq",
      role: "cashier",
    });

    // 3. Set active org
    await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie },
      payload: { organizationId: "org-hq" },
    });

    // 4. Access protected route — should have member scope
    const protectedRes = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { cookie },
    });

    expect(protectedRes.statusCode).toBe(200);
    const body = JSON.parse(protectedRes.body);
    expect(body.scope.kind).toBe("member");
    expect(body.scope.organizationId).toBe("org-hq");
    expect(body.scope.orgRoles).toEqual(["cashier"]);
    expect(body.scope.userId).toBe(newUser.id);

    // 5. Access public route with same cookie — should have user info
    const publicRes = await app.inject({
      method: "GET",
      url: "/public",
      headers: { cookie },
    });
    expect(publicRes.statusCode).toBe(200);
    expect(JSON.parse(publicRes.body).user.email).toBe("new@example.com");
  });
});
