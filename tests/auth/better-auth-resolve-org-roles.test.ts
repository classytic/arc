/**
 * `resolveOrgRoles` — the organization-hierarchy seam: a host computes the roles a caller carries in
 * the active organization (e.g. roles held at a head office apply in every branch).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type BetterAuthHandler, createBetterAuthAdapter } from "../../src/auth/betterAuth.js";

function authFor(opts: { activeOrgId: string; memberRole?: string }): BetterAuthHandler {
  return {
    handler: async () => new Response("{}", { status: 200 }),
    api: {
      getSession: async () => ({
        user: { id: "user-1", role: "user" },
        session: { id: "s1", activeOrganizationId: opts.activeOrgId },
      }),
      organization: {
        getActiveMember: async () =>
          opts.memberRole
            ? { userId: "user-1", organizationId: opts.activeOrgId, role: opts.memberRole }
            : null,
        getActiveMemberRole: async () => (opts.memberRole ? { role: opts.memberRole } : null),
      },
    },
  } as unknown as BetterAuthHandler;
}

describe("createBetterAuthAdapter — resolveOrgRoles", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
  });

  async function scopeOf(
    auth: BetterAuthHandler,
    resolveOrgRoles: Parameters<typeof createBetterAuthAdapter>[0]["resolveOrgRoles"],
    hook: "authenticate" | "optionalAuthenticate" = "authenticate",
  ): Promise<Record<string, unknown>> {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({ auth, orgContext: true, resolveOrgRoles });
    await app.register(plugin);
    let captured: Record<string, unknown> = {};
    app.get("/t", { preHandler: [app[hook]] }, async (request) => {
      captured = (request as unknown as { scope: Record<string, unknown> }).scope;
      return {};
    });
    await app.ready();
    await app.inject({ method: "GET", url: "/t" });
    return captured;
  }

  it("grants a member scope in an org the caller is not a member of (inherited roles)", async () => {
    const seen: unknown[] = [];
    const scope = await scopeOf(authFor({ activeOrgId: "branch-b" }), (input) => {
      seen.push(input);
      return ["auditor"];
    });
    expect(scope).toMatchObject({
      kind: "member",
      organizationId: "branch-b",
      orgRoles: ["auditor"],
    });
    expect(seen).toEqual([{ userId: "user-1", organizationId: "branch-b", memberRoles: null }]);
  });

  it("receives the caller's own roles and may extend them", async () => {
    const scope = await scopeOf(
      authFor({ activeOrgId: "branch-a", memberRole: "cashier" }),
      ({ memberRoles }) => [...(memberRoles ?? []), "finance_manager"],
    );
    expect(scope).toMatchObject({ orgRoles: ["cashier", "finance_manager"] });
  });

  it("returning null leaves the request non-member", async () => {
    const scope = await scopeOf(authFor({ activeOrgId: "branch-b" }), () => null);
    expect(scope).toMatchObject({ kind: "authenticated" });
  });

  it("applies on optionalAuthenticate too — one path, not two", async () => {
    const scope = await scopeOf(
      authFor({ activeOrgId: "branch-b" }),
      () => ["auditor"],
      "optionalAuthenticate",
    );
    expect(scope).toMatchObject({ kind: "member", orgRoles: ["auditor"] });
  });

  it("refuses to compose without orgContext", () => {
    expect(() =>
      createBetterAuthAdapter({ auth: authFor({ activeOrgId: "x" }), resolveOrgRoles: () => [] }),
    ).toThrow(/requires `orgContext: true`/);
  });
});
