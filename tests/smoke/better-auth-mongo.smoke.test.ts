/**
 * Real Better Auth + MongoDB smoke test.
 *
 * Unlike tests/auth/better-auth-org.test.ts (which mocks the BA handler),
 * this test boots a real `betterAuth()` instance backed by the official
 * `@better-auth/mongo-adapter` against mongodb-memory-server, then drives
 * it through our Fastify adapter from src/auth/betterAuth.ts.
 *
 * This is the canary that catches real 1.x upgrade regressions:
 * if BA changes the shape of get-session, organization endpoints, or
 * the direct API, our mock-based tests won't catch it — this one will.
 *
 * Provider choice: we use the native `mongodb` driver (required by
 * @better-auth/mongo-adapter) alongside mongokit-compatible collections.
 * Arc's adapter is intentionally provider-agnostic, so proving it works
 * against one real provider validates the whole contract.
 *
 * Scenarios covered:
 *   1. email+password sign-up → sign-in → cookie session
 *   2. createOrganization + setActiveOrganization → request.scope = member
 *   3. Multi-role ("admin,recruiter") → requireOrgRole matches any
 *   4. createTeam + setActiveTeam → request.scope.teamId populated
 *   5. x-organization-id header fallback (API-key style) via getActiveMemberRole
 */

import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import Fastify, { type FastifyInstance } from "fastify";
import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBetterAuthAdapter } from "../../src/auth/betterAuth.js";
import type { RequestScope } from "../../src/scope/types.js";

// ============================================================================
// Infrastructure
// ============================================================================

let mongoServer: MongoMemoryServer;
let mongoClient: MongoClient;
let db: Db;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  mongoClient = new MongoClient(mongoServer.getUri());
  await mongoClient.connect();
  db = mongoClient.db("arc-ba-smoke");
}, 60_000);

afterAll(async () => {
  await mongoClient?.close();
  await mongoServer?.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  for (const { name } of collections) {
    await db.collection(name).deleteMany({});
  }
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a real `betterAuth()` instance wired to our in-memory mongo.
 * mongo-memory-server is a standalone server (no replica set), so the
 * mongo adapter's default transaction mode MUST be disabled.
 */
function makeAuth() {
  return betterAuth({
    database: mongodbAdapter(db, { client: mongoClient, transaction: false }),
    baseURL: "http://localhost",
    basePath: "/api/auth",
    secret: "smoke-test-secret-please-ignore-0123456789",
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    plugins: [
      organization({
        teams: { enabled: true },
      }),
    ],
  });
}

/** Build a Fastify app with arc's BA adapter wired in. */
async function makeApp(auth: ReturnType<typeof makeAuth>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { plugin, authenticate } = createBetterAuthAdapter({
    auth: auth as unknown as Parameters<typeof createBetterAuthAdapter>[0]["auth"],
    orgContext: true,
  });
  await app.register(plugin);
  app.get("/whoami", { preHandler: [authenticate] }, async (request) => {
    return {
      user: request.user,
      scope: (request as unknown as { scope: RequestScope }).scope,
    };
  });
  await app.ready();
  return app;
}

/** Extract set-cookie values from a Fastify injected response. */
function extractCookies(res: { cookies: Array<{ name: string; value: string }> }): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// ============================================================================
// Tests
// ============================================================================

describe("real better-auth + mongo smoke — arc adapter alignment", () => {
  it("signs up a user and resolves session via arc adapter (scope: authenticated)", async () => {
    const auth = makeAuth();
    const app = await makeApp(auth);
    try {
      // Sign up via the catch-all route (real BA handler processes it)
      const signUpRes = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json" },
        payload: {
          email: "alice@example.com",
          password: "supersecure-password-123",
          name: "Alice",
        },
      });
      expect(signUpRes.statusCode).toBe(200);
      const cookies = extractCookies(signUpRes);
      expect(cookies).toContain("better-auth.session_token");

      // Call a protected route with the session cookie
      const meRes = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { cookie: cookies },
      });
      expect(meRes.statusCode).toBe(200);
      const body = meRes.json() as { user: Record<string, unknown>; scope: RequestScope };
      expect(body.user.email).toBe("alice@example.com");
      // No active org yet → scope is authenticated, not member
      expect(body.scope.kind).toBe("authenticated");
      expect((body.scope as { userId?: string }).userId).toBeTruthy();
    } finally {
      await app.close();
    }
  }, 30_000);

  it("populates member scope after createOrganization + setActiveOrganization", async () => {
    const auth = makeAuth();
    const app = await makeApp(auth);
    try {
      // Sign up
      const signUpRes = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json" },
        payload: {
          email: "bob@example.com",
          password: "supersecure-password-123",
          name: "Bob",
        },
      });
      expect(signUpRes.statusCode).toBe(200);
      const cookies = extractCookies(signUpRes);

      // Create org via BA's real endpoint
      const createOrgRes = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        headers: { "content-type": "application/json", cookie: cookies },
        payload: { name: "Acme Corp", slug: "acme" },
      });
      expect(createOrgRes.statusCode).toBe(200);
      const orgBody = createOrgRes.json() as { id: string };
      expect(orgBody.id).toBeTruthy();

      // Set active organization (updates session)
      const setActiveRes = await app.inject({
        method: "POST",
        url: "/api/auth/organization/set-active",
        headers: { "content-type": "application/json", cookie: cookies },
        payload: { organizationId: orgBody.id },
      });
      expect(setActiveRes.statusCode).toBe(200);

      // Protected route → arc adapter should resolve member scope
      const meRes = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { cookie: cookies },
      });
      expect(meRes.statusCode).toBe(200);
      const body = meRes.json() as { scope: RequestScope };
      expect(body.scope.kind).toBe("member");
      expect((body.scope as { organizationId: string }).organizationId).toBe(orgBody.id);
      // Creator is always "owner" in BA org plugin
      expect((body.scope as { orgRoles: string[] }).orgRoles).toContain("owner");
    } finally {
      await app.close();
    }
  }, 30_000);

  it("multi-role member passes requireOrgRole for any matching role", async () => {
    const auth = makeAuth();
    const { plugin, authenticate, permissions } = createBetterAuthAdapter({
      auth: auth as unknown as Parameters<typeof createBetterAuthAdapter>[0]["auth"],
      orgContext: true,
    });
    const app = Fastify({ logger: false });
    await app.register(plugin);

    let capturedResult: unknown;
    const check = permissions.requireOrgRole("admin", "recruiter");
    app.get("/job", { preHandler: [authenticate] }, async (request) => {
      capturedResult = check({
        user: request.user as Record<string, unknown>,
        request: request as unknown as Parameters<typeof check>[0]["request"],
        resource: "job",
        action: "create",
      });
      return { ok: true };
    });
    await app.ready();

    try {
      // Owner signs up + creates org
      const ownerSignUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json" },
        payload: { email: "owner@example.com", password: "password-1234567", name: "Owner" },
      });
      expect(ownerSignUp.statusCode).toBe(200);
      const ownerCookies = extractCookies(ownerSignUp);

      const orgRes = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        headers: { "content-type": "application/json", cookie: ownerCookies },
        payload: { name: "Multi Corp", slug: "multi" },
      });
      expect(orgRes.statusCode).toBe(200);
      const orgId = (orgRes.json() as { id: string }).id;

      // Second user signs up
      const memberSignUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json" },
        payload: { email: "multi@example.com", password: "password-1234567", name: "Multi" },
      });
      expect(memberSignUp.statusCode).toBe(200);
      const memberCookies = extractCookies(memberSignUp);

      // Owner adds member with multi-role via direct JS API.
      // BA's addMember endpoint is exposed as auth.api.addMember (server-side
      // call), not as a public HTTP route — see crud-members.mjs line 24 where
      // createAuthEndpoint is invoked in option-form without a path string.
      // Server-to-server admin operations are the intended use case here.
      const memberUserId = (memberSignUp.json() as { user: { id: string } }).user.id;
      await auth.api.addMember({
        body: {
          organizationId: orgId,
          userId: memberUserId,
          role: ["admin", "recruiter"],
        },
      });

      // Member sets active org
      const setActiveRes = await app.inject({
        method: "POST",
        url: "/api/auth/organization/set-active",
        headers: { "content-type": "application/json", cookie: memberCookies },
        payload: { organizationId: orgId },
      });
      expect(setActiveRes.statusCode).toBe(200);

      // Hit protected route — permission check should pass on 'recruiter'
      const jobRes = await app.inject({
        method: "GET",
        url: "/job",
        headers: { cookie: memberCookies },
      });
      expect(jobRes.statusCode).toBe(200);
      expect(capturedResult).toBe(true);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("populates scope.teamId when activeTeamId matches a team in the org", async () => {
    const auth = makeAuth();
    const app = await makeApp(auth);
    try {
      const signUpRes = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json" },
        payload: { email: "team@example.com", password: "password-1234567", name: "Team" },
      });
      expect(signUpRes.statusCode).toBe(200);
      const cookies = extractCookies(signUpRes);

      const orgRes = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        headers: { "content-type": "application/json", cookie: cookies },
        payload: { name: "Team Co", slug: "team-co" },
      });
      expect(orgRes.statusCode).toBe(200);
      const orgId = (orgRes.json() as { id: string }).id;

      await app.inject({
        method: "POST",
        url: "/api/auth/organization/set-active",
        headers: { "content-type": "application/json", cookie: cookies },
        payload: { organizationId: orgId },
      });

      const teamRes = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create-team",
        headers: { "content-type": "application/json", cookie: cookies },
        payload: { name: "Engineering", organizationId: orgId },
      });
      expect([200, 201]).toContain(teamRes.statusCode);
      const teamId = (teamRes.json() as { id: string }).id;
      expect(teamId).toBeTruthy();

      // Add the user as a team member before they can activate it.
      // addTeamMember requires session context (it's a permission-checked op),
      // so we forward the cookie via Headers.
      const userId = (signUpRes.json() as { user: { id: string } }).user.id;
      const sessionHeaders = new Headers();
      sessionHeaders.set("cookie", cookies);
      await auth.api.addTeamMember({
        body: { teamId, userId },
        headers: sessionHeaders,
      });

      const setTeamRes = await app.inject({
        method: "POST",
        url: "/api/auth/organization/set-active-team",
        headers: { "content-type": "application/json", cookie: cookies },
        payload: { teamId },
      });
      expect(setTeamRes.statusCode).toBe(200);

      const meRes = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { cookie: cookies },
      });
      expect(meRes.statusCode).toBe(200);
      const body = meRes.json() as { scope: RequestScope };
      expect(body.scope.kind).toBe("member");
      expect((body.scope as { teamId?: string }).teamId).toBe(teamId);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("resolves org roles via x-organization-id header fallback (no activeOrganizationId in session)", async () => {
    // This exercises the getActiveMemberRole explicit-org path that exists
    // specifically for API-key / header-driven org context.
    const auth = makeAuth();
    const app = await makeApp(auth);
    try {
      const signUpRes = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json" },
        payload: { email: "header@example.com", password: "password-1234567", name: "Hdr" },
      });
      expect(signUpRes.statusCode).toBe(200);
      const cookies = extractCookies(signUpRes);

      const orgRes = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        headers: { "content-type": "application/json", cookie: cookies },
        payload: { name: "Header Co", slug: "header-co" },
      });
      expect(orgRes.statusCode).toBe(200);
      const orgId = (orgRes.json() as { id: string }).id;

      // Deliberately DO NOT call set-active — session has no activeOrganizationId.
      // arc adapter should fall back to the x-organization-id header.
      const meRes = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { cookie: cookies, "x-organization-id": orgId },
      });
      expect(meRes.statusCode).toBe(200);
      const body = meRes.json() as { scope: RequestScope };
      expect(body.scope.kind).toBe("member");
      expect((body.scope as { organizationId: string }).organizationId).toBe(orgId);
      expect((body.scope as { orgRoles: string[] }).orgRoles).toContain("owner");
    } finally {
      await app.close();
    }
  }, 30_000);
});
