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
    /** Teams returned by api.organization.listTeams */
    teams?: Array<Record<string, unknown>>;
    /** When true, listTeams returns `{ teams: [...] }` envelope instead of bare array */
    teamsEnvelope?: boolean;
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
        listTeams: async () => {
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
    const result = capturedResult as { granted: boolean; reason: string };
    expect(result.granted).toBe(false);
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
