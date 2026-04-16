/**
 * Better Auth adapter — API-key auth path via `x-organization-id` header
 *
 * When a machine-to-machine caller authenticates with an API key, the
 * synthetic session has no `activeOrganizationId`. Better Auth's
 * `getActiveMember` endpoint returns nothing because it reads the session.
 * Instead, arc falls back to:
 *
 *   1. Read `x-organization-id` from the request header
 *   2. Call `auth.api.organization.getActiveMemberRole({ headers, query: { organizationId } })`
 *      (the tier-2 direct-API path at betterAuth.ts:316-339)
 *   3. Populate `request.scope` as a `member` scope with the explicit org
 *
 * None of the pre-existing org tests exercise this path — they all put the
 * org on the session. This file plugs that hole.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BetterAuthHandler, createBetterAuthAdapter } from "../../src/auth/betterAuth.js";

/**
 * Build a BetterAuthHandler that simulates API-key auth:
 *   - `auth.api.getSession` returns a user with NO activeOrganizationId
 *   - `auth.api.organization.getActiveMemberRole` returns the role for the
 *     explicitly-provided organizationId query param
 *   - `auth.api.organization.getActiveMember` returns null (no session org)
 */
function createApiKeyAuthHandler(opts: {
  userId?: string;
  /** Map of org → role returned by getActiveMemberRole(query.organizationId). */
  roleByOrg: Record<string, string | string[]>;
  getRoleSpy?: ReturnType<typeof vi.fn>;
}): BetterAuthHandler {
  const userId = opts.userId ?? "api-key-user-1";

  const getSession = vi.fn(async () => ({
    user: { id: userId, email: "svc@example.com" },
    session: { id: "sess-1", activeOrganizationId: null },
  }));

  const getActiveMember = vi.fn(async () => null);

  const getActiveMemberRole =
    opts.getRoleSpy ??
    vi.fn(async ({ query }: { query: { organizationId: string } }) => {
      const role = opts.roleByOrg[query.organizationId];
      if (!role) return null;
      return { role };
    });

  const handler = vi.fn(async (req: Request) => {
    // HTTP fallback path — arc calls this only when all direct-API tiers
    // returned null. Return 404 so `resolveOrgRoles` resolves to null rather
    // than "valid membership with empty roles" (which would wrongly flip
    // scope to 'member' for an attacker-controlled org).
    const url = new URL(req.url);
    if (
      url.pathname.endsWith("/organization/get-active-member") ||
      url.pathname.endsWith("/organization/get-active-member-role") ||
      url.pathname.endsWith("/organization/list")
    ) {
      return new Response("null", {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });

  const betterAuth: BetterAuthHandler = {
    handler,
    api: {
      getSession,
      organization: {
        getActiveMember,
        getActiveMemberRole,
      },
    },
  };

  return betterAuth;
}

async function buildApp(auth: BetterAuthHandler): Promise<{
  app: FastifyInstance;
  getCapturedScope: () => unknown;
}> {
  const app = Fastify({ logger: false });
  const { plugin, authenticate } = createBetterAuthAdapter({ auth, orgContext: true });
  await app.register(plugin);

  let captured: unknown;
  app.get("/me", { preHandler: [authenticate] }, async (req) => {
    captured = (req as unknown as { scope: unknown }).scope;
    return { ok: true };
  });

  await app.ready();
  return { app, getCapturedScope: () => captured };
}

describe("Better Auth adapter — API-key path via x-organization-id header", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("falls back to x-organization-id header when session lacks activeOrganizationId", async () => {
    const getRoleSpy = vi.fn(async ({ query }: { query: { organizationId: string } }) => {
      if (query.organizationId === "org-42") return { role: "admin" };
      return null;
    });

    const auth = createApiKeyAuthHandler({ roleByOrg: { "org-42": "admin" }, getRoleSpy });
    const built = await buildApp(auth);
    app = built.app;

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { "x-organization-id": "org-42" },
    });

    expect(res.statusCode).toBe(200);

    const scope = built.getCapturedScope() as Record<string, unknown>;
    expect(scope).toMatchObject({
      kind: "member",
      organizationId: "org-42",
      userId: "api-key-user-1",
    });
    expect(scope.orgRoles).toContain("admin");

    // Proves tier-2 (getActiveMemberRole) was reached with the header's org id.
    expect(getRoleSpy).toHaveBeenCalledTimes(1);
    expect(getRoleSpy.mock.calls[0][0].query).toEqual({ organizationId: "org-42" });
  });

  it("prefers session.activeOrganizationId over x-organization-id when session has one", async () => {
    // Direct-api getSession returns session with an activeOrganizationId.
    const handler: BetterAuthHandler = {
      handler: vi.fn(),
      api: {
        getSession: vi.fn(async () => ({
          user: { id: "u-1" },
          session: { id: "s-1", activeOrganizationId: "org-from-session" },
        })),
        organization: {
          getActiveMember: vi.fn(async () => ({
            id: "m-1",
            userId: "u-1",
            organizationId: "org-from-session",
            role: "member",
          })),
          getActiveMemberRole: vi.fn(async () => ({ role: "member" })),
        },
      },
    };

    const built = await buildApp(handler);
    app = built.app;

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { "x-organization-id": "org-ignored-header" },
    });

    expect(res.statusCode).toBe(200);
    const scope = built.getCapturedScope() as Record<string, unknown>;
    expect(scope).toMatchObject({
      kind: "member",
      organizationId: "org-from-session",
    });
  });

  it("returns unauthenticated scope when header org is not a member (tier-2 returns null)", async () => {
    const auth = createApiKeyAuthHandler({ roleByOrg: {} }); // no role for any org
    const built = await buildApp(auth);
    app = built.app;

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { "x-organization-id": "org-not-a-member" },
    });

    expect(res.statusCode).toBe(200);
    const scope = built.getCapturedScope() as Record<string, unknown>;
    // Membership resolution failed — scope must NOT claim member kind for
    // the attacker-controlled org id.
    expect(scope.kind).not.toBe("member");
    expect(scope.kind).toBe("authenticated");
  });

  it("normalizes comma-separated roles from getActiveMemberRole", async () => {
    const auth = createApiKeyAuthHandler({
      roleByOrg: { "org-42": "admin,operator,viewer" },
    });
    const built = await buildApp(auth);
    app = built.app;

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { "x-organization-id": "org-42" },
    });

    expect(res.statusCode).toBe(200);
    const scope = built.getCapturedScope() as Record<string, unknown>;
    expect(scope.orgRoles).toEqual(expect.arrayContaining(["admin", "operator", "viewer"]));
  });

  it("no org header + no session org → stays at authenticated scope (no member)", async () => {
    const auth = createApiKeyAuthHandler({ roleByOrg: { "org-42": "admin" } });
    const built = await buildApp(auth);
    app = built.app;

    const res = await app.inject({ method: "GET", url: "/me" }); // no header

    expect(res.statusCode).toBe(200);
    const scope = built.getCapturedScope() as Record<string, unknown>;
    expect(scope.kind).toBe("authenticated");
    expect(scope.organizationId).toBeUndefined();
  });
});
