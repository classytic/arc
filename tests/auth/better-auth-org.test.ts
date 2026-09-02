/**
 * Better Auth Org Context Tests
 *
 * Tests the orgContext bridge that populates request.scope
 * from Better Auth's organization plugin.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type BetterAuthHandler, createBetterAuthAdapter } from "../../src/auth/betterAuth.js";

// ============================================================================
// Mock auth handlers
// ============================================================================

/** Auth handler with org membership support — exposes both `handler` (catch-all) and `api` (direct in-process). */
function createOrgAuthHandler(
  opts: {
    activeOrgId?: string;
    memberRole?: string;
    memberNotFound?: boolean;
    userRoles?: string[];
    activeTeamId?: string;
    /** Teams returned by `api.organization.listUserTeams` */
    teams?: Array<Record<string, unknown>>;
    /** When true, listUserTeams returns `{ teams: [...] }` envelope instead of bare array */
    teamsEnvelope?: boolean;
    onListUserTeams?: (input: unknown) => void;
  } = {},
): BetterAuthHandler {
  const session = {
    id: "session-1",
    activeOrganizationId: opts.activeOrgId ?? null,
    activeTeamId: opts.activeTeamId ?? null,
  };
  const user = {
    id: "user-1",
    name: "Test User",
    email: "test@example.com",
    roles: opts.userRoles ?? [],
  };

  return {
    // Catch-all handler is still needed for routes that go through /api/auth/*
    // (sign-up, sign-in, etc.). Tests that only exercise authenticate hit the
    // `api` map below directly.
    handler: async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    api: {
      getSession: async () => ({ user, session }),
      organization: {
        getActiveMember: async () => {
          if (opts.memberNotFound) return null;
          return {
            id: "member-1",
            userId: "user-1",
            organizationId: opts.activeOrgId,
            role: opts.memberRole ?? "member",
          };
        },
        /**
         * `listUserTeams` — the name Better Auth actually exposes on `auth.api`.
         *
         * This double was `listTeams` until 2026-09-02, which no Better Auth
         * version registers server-side (it is the CLIENT name). The fake
         * therefore had no `listUserTeams`, so every team test fell through to
         * the adapter's `listTeams` fallback and green-lit a path that could not
         * run in production — while the path that DOES run had no coverage at
         * all. The fallback is now gone and this name is the real one.
         */
        listUserTeams: async (input: unknown) => {
          opts.onListUserTeams?.(input);
          const teams = opts.teams ?? [];
          return opts.teamsEnvelope ? { teams } : teams;
        },
      },
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Better Auth Org Context Bridge", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("populates request.scope as member for org member", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: "org-123", memberRole: "admin,member" }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect(capturedScope).toMatchObject({
      kind: "member",
      organizationId: "org-123",
      orgRoles: ["admin", "member"],
    });
  });

  it("sets scope to authenticated when no active organization", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: undefined }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect(capturedScope).toMatchObject({ kind: "authenticated" });
  });

  it("prefers org member scope for superadmin users when active org membership exists", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: "org-123", userRoles: ["superadmin"] }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    // Superadmin with active org = member scope (no implicit bypass)
    expect(capturedScope).toMatchObject({
      kind: "member",
      organizationId: "org-123",
      orgRoles: ["member"],
    });
  });

  it("sets authenticated scope for superadmin users when no active org is selected", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: undefined, userRoles: ["superadmin"] }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    // No implicit bypass — superadmin without org = just authenticated
    expect(capturedScope).toMatchObject({ kind: "authenticated" });
  });

  it("sets authenticated scope when user is not a member", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: "org-123", memberNotFound: true }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect(capturedScope).toMatchObject({ kind: "authenticated" });
  });

  it("does not set org scope when orgContext is disabled", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: "org-123", memberRole: "admin" }),
      // orgContext not set (defaults to false)
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    // Without orgContext, scope should be authenticated (user is logged in)
    expect((capturedScope as any)?.kind).toBe("authenticated");
  });

  // ──────────────────────────────────────────────────────────────
  // Multi-role support (Better Auth stores "admin,recruiter")
  // ──────────────────────────────────────────────────────────────

  it("splits comma-separated roles into array", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: "org-1", memberRole: "account_manager,recruiter" }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect((capturedScope as any)?.orgRoles).toEqual(["account_manager", "recruiter"]);
  });

  it("trims whitespace in comma-separated roles", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({
        activeOrgId: "org-1",
        memberRole: " admin , delivery_manager ",
      }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect((capturedScope as any)?.orgRoles).toEqual(["admin", "delivery_manager"]);
  });

  it("handles single role string without comma", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: "org-1", memberRole: "admin" }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect((capturedScope as any)?.orgRoles).toEqual(["admin"]);
  });

  it("handles empty role string gracefully", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: "org-1", memberRole: "" }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect((capturedScope as any)?.orgRoles).toEqual([]);
  });

  it("multi-role user passes requireOrgRole for any matching role", async () => {
    app = Fastify({ logger: false });
    const { plugin, permissions } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: "org-1", memberRole: "account_manager,recruiter" }),
      orgContext: true,
    });
    await app.register(plugin);

    const check = permissions.requireOrgRole("admin", "recruiter");
    let capturedResult: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedResult = check({
        user: (request as any).user,
        request: request as any,
        resource: "job",
        action: "create",
      });
      return { ok: true };
    });
    await app.ready();

    await app.inject({ method: "GET", url: "/test" });
    expect(capturedResult).toBe(true);
  });

  it("multi-role user fails requireOrgRole when no role matches", async () => {
    app = Fastify({ logger: false });
    const { plugin, permissions } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: "org-1", memberRole: "account_manager,recruiter" }),
      orgContext: true,
    });
    await app.register(plugin);

    const check = permissions.requireOrgRole("admin", "delivery_manager");
    let capturedResult: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedResult = check({
        user: (request as any).user,
        request: request as any,
        resource: "job",
        action: "create",
      });
      return { ok: true };
    });
    await app.ready();

    await app.inject({ method: "GET", url: "/test" });
    const result = capturedResult as { effect: string; reason: string };
    expect(result.effect).toBe("deny");
    expect(result.reason).toContain("Required org roles");
  });

  // ──────────────────────────────────────────────────────────────
  // Team context bridge (activeTeamId resolution via list-teams)
  // ──────────────────────────────────────────────────────────────

  it("attaches teamId to scope when activeTeamId matches a team in the org", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({
        activeOrgId: "org-1",
        memberRole: "admin",
        activeTeamId: "team-a",
        teams: [
          { id: "team-a", name: "Engineering", organizationId: "org-1" },
          { id: "team-b", name: "Sales", organizationId: "org-1" },
        ],
      }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect(capturedScope).toMatchObject({
      kind: "member",
      organizationId: "org-1",
      orgRoles: ["admin"],
      teamId: "team-a",
    });
  });

  it("does not attach teamId when activeTeamId does not match any team", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({
        activeOrgId: "org-1",
        memberRole: "admin",
        activeTeamId: "team-ghost",
        teams: [{ id: "team-a", name: "Engineering", organizationId: "org-1" }],
      }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect(capturedScope).toMatchObject({ kind: "member", organizationId: "org-1" });
    expect((capturedScope as any).teamId).toBeUndefined();
  });

  it("does not attach a team from a different active organization", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({
        activeOrgId: "org-1",
        memberRole: "admin",
        activeTeamId: "team-other-org",
        teams: [{ id: "team-other-org", name: "Foreign", organizationId: "org-2" }],
      }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = request.scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect(capturedScope).toMatchObject({ kind: "member", organizationId: "org-1" });
    expect((capturedScope as { teamId?: string }).teamId).toBeUndefined();
  });

  it("projects the same active team through optional authentication", async () => {
    app = Fastify({ logger: false });
    let listInput: unknown;
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({
        activeOrgId: "org-1",
        memberRole: "member",
        activeTeamId: "team-a",
        teams: [{ id: "team-a", name: "Engineering", organizationId: "org-1" }],
        onListUserTeams: (input) => {
          listInput = input;
        },
      }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/optional", { preHandler: [app.optionalAuthenticate] }, async (request) => {
      capturedScope = request.scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/optional" });
    expect(res.statusCode).toBe(200);
    expect(capturedScope).toMatchObject({
      kind: "member",
      organizationId: "org-1",
      teamId: "team-a",
    });
    expect(listInput).toMatchObject({ query: { organizationId: "org-1" } });
  });

  it("handles list-teams envelope shape ({ teams: [...] })", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({
        activeOrgId: "org-1",
        memberRole: "admin",
        activeTeamId: "team-a",
        teams: [{ id: "team-a", name: "Engineering", organizationId: "org-1" }],
        teamsEnvelope: true,
      }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect((capturedScope as any).teamId).toBe("team-a");
  });

  it("matches team id stored as object with _id (mongoose-style)", async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({
        activeOrgId: "org-1",
        memberRole: "admin",
        activeTeamId: "team-a",
        // Some adapters return ids as { _id: '...' } objects
        teams: [{ id: { _id: "team-a" }, name: "Engineering", organizationId: "org-1" }],
      }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedScope: unknown;
    app.get("/test", { preHandler: [app.authenticate] }, async (request) => {
      capturedScope = (request as any).scope;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    expect((capturedScope as any).teamId).toBe("team-a");
  });

  it("returns permissions helper", () => {
    const { permissions } = createBetterAuthAdapter({
      auth: createOrgAuthHandler(),
      orgContext: true,
    });

    expect(permissions.requireOrgRole).toBeDefined();
    expect(permissions.requireOrgMembership).toBeDefined();
    expect(typeof permissions.requireOrgRole("admin")).toBe("function");
    expect(typeof permissions.requireOrgMembership()).toBe("function");
  });
});

/**
 * `orgContext: true` without Better Auth's `organization()` plugin.
 *
 * Arc resolves membership through `auth.api.getActiveMember` /
 * `getActiveMemberRole`. Absent the plugin those are undefined, every lookup
 * returns null, and scope silently stays `'authenticated'` — so every
 * tenant-scoped route answers 403 with nothing pointing at the missing
 * plugin. Fails closed, but undiagnosably; now it fails at BOOT.
 */
describe("orgContext without the organization plugin", () => {
  it("REFUSES at registration, naming the plugin", async () => {
    const app = Fastify({ logger: false });
    const authNoOrg = {
      handler: async () => new Response("{}", { status: 200 }),
      api: { getSession: async () => null }, // no organization methods
    } as never;

    const { plugin } = createBetterAuthAdapter({ auth: authNoOrg, orgContext: true });
    await expect(app.register(plugin).ready()).rejects.toThrow(/organization\(\)/);
    await app.close();
  });

  it("boots fine when orgContext is OFF — the plugin is only needed for org scope", async () => {
    const app = Fastify({ logger: false });
    const authNoOrg = {
      handler: async () => new Response("{}", { status: 200 }),
      api: { getSession: async () => null },
    } as never;

    const { plugin } = createBetterAuthAdapter({ auth: authNoOrg });
    await expect(app.register(plugin).ready()).resolves.toBeTruthy();
    await app.close();
  });
});

// ============================================================================
// `getActiveMember` must not be called when the session names no active org
// ============================================================================

/**
 * `getActiveMember` resolves the member for the SESSION's active organization.
 * With no `activeOrganizationId` it can only throw, and the adapter swallows
 * that into `null` — after paying a full Better Auth endpoint round trip.
 *
 * A bearer-only deployment never calls `setActive`, so this was every request:
 * ~440ms of measured, guaranteed-useless work before the header-based lookup
 * that actually answers.
 */
describe("org resolution skips the call that cannot succeed", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
  });

  function handlerWithSpies(activeOrgId: string | null) {
    const calls = { getActiveMember: 0, getActiveMemberRole: 0 };
    const session = { id: "session-1", activeOrganizationId: activeOrgId, activeTeamId: null };
    const user = { id: "user-1", name: "T", email: "t@example.com", roles: [] };
    const auth = {
      handler: async () => new Response("{}", { status: 200 }),
      api: {
        getSession: async () => ({ user, session }),
        organization: {
          getActiveMember: async () => {
            calls.getActiveMember += 1;
            if (!activeOrgId) throw new Error("No active organization");
            return { id: "m-1", userId: "user-1", organizationId: activeOrgId, role: "admin" };
          },
          getActiveMemberRole: async () => {
            calls.getActiveMemberRole += 1;
            return { role: "branch_manager" };
          },
          listUserTeams: async () => [],
        },
      },
    } as unknown as BetterAuthHandler;
    return { auth, calls };
  }

  async function run(activeOrgId: string | null, header: string) {
    const { auth, calls } = handlerWithSpies(activeOrgId);
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({ auth, orgContext: true });
    await app.register(plugin);
    let scope: any;
    app.get("/t", { preHandler: [app.authenticate] }, async (req) => {
      scope = (req as any).scope;
      return { ok: true };
    });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/t",
      headers: { authorization: "Bearer tok", "x-organization-id": header },
    });
    return { calls, scope, status: res.statusCode };
  }

  it("session has NO activeOrganizationId → getActiveMember is never called", async () => {
    const { calls, scope, status } = await run(null, "org-from-header");

    expect(status).toBe(200);
    expect(calls.getActiveMember).toBe(0);
    // Still resolves membership — via the header path that can actually answer.
    expect(calls.getActiveMemberRole).toBe(1);
    expect(scope.kind).toBe("member");
    expect(scope.organizationId).toBe("org-from-header");
    expect(scope.orgRoles).toContain("branch_manager");
  });

  it("session HAS activeOrganizationId → getActiveMember is still used first", async () => {
    const { calls, scope, status } = await run("org-123", "org-123");

    expect(status).toBe(200);
    expect(calls.getActiveMember).toBe(1);
    // It succeeded, so the fallback must not run.
    expect(calls.getActiveMemberRole).toBe(0);
    expect(scope.kind).toBe("member");
    expect(scope.orgRoles).toContain("admin");
  });
});
