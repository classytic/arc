/**
 * `memberLookup: 'resolver'` skips Better Auth's membership lookup when `resolveOrgRoles` reads
 * membership itself. Pins: one fewer membership read per request, and the SAME auth outcome as the
 * default for every case the resolver decides.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type BetterAuthHandler, createBetterAuthAdapter } from "../../src/auth/betterAuth.js";
import { requireOrgRole } from "../../src/permissions/index.js";

interface Member {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: string;
}

/** A Better Auth stub over an in-memory `member` table that counts every membership read. */
function world() {
  const members: Member[] = [
    { userId: "manager", organizationId: "org-a", role: "manager" },
    { userId: "manager", organizationId: "org-b", role: "cashier" },
    { userId: "cashier", organizationId: "org-a", role: "cashier" },
  ];
  const banned = new Set<string>();
  const activeOrg = new Map<string, string>([
    ["manager", "org-a"],
    ["cashier", "org-a"],
    ["outsider", "org-a"],
  ]);
  let memberReads = 0;
  const find = (userId: string, organizationId: string): Member | undefined => {
    memberReads++;
    return members.find((m) => m.userId === userId && m.organizationId === organizationId);
  };
  const userOf = (headers: Headers): string | null => {
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    return token && !banned.has(token) ? token : null;
  };
  const auth = {
    handler: async () => new Response("{}", { status: 200 }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const userId = userOf(headers);
        if (!userId) return null;
        return {
          user: { id: userId, role: "user" },
          session: { id: `s-${userId}`, activeOrganizationId: activeOrg.get(userId) },
        };
      },
      organization: {
        getActiveMember: async ({ headers }: { headers: Headers }) => {
          const userId = userOf(headers);
          const orgId = userId ? activeOrg.get(userId) : undefined;
          return userId && orgId ? (find(userId, orgId) ?? null) : null;
        },
        getActiveMemberRole: async ({
          headers,
          query,
        }: {
          headers: Headers;
          query: { organizationId: string };
        }) => {
          const userId = userOf(headers);
          const member = userId ? find(userId, query.organizationId) : undefined;
          return member ? { role: member.role } : null;
        },
      },
    },
  } as unknown as BetterAuthHandler;
  /** The host's resolver: reads membership itself and ignores `memberRoles`. */
  const resolveOrgRoles = ({
    userId,
    organizationId,
  }: {
    userId: string;
    organizationId: string;
  }) => {
    const member = find(userId, organizationId);
    return member ? [member.role] : null;
  };
  return {
    auth,
    resolveOrgRoles,
    ban: (userId: string) => banned.add(userId),
    switchOrg: (userId: string, orgId: string) => activeOrg.set(userId, orgId),
    reads: () => memberReads,
  };
}

type Lookup = "better-auth" | "resolver";

describe("createBetterAuthAdapter — memberLookup", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Runs the scenario; returns every request's outcome and the membership reads it cost. */
  async function run(memberLookup: Lookup) {
    const w = world();
    const server = Fastify({ logger: false });
    app = server;
    const { plugin } = createBetterAuthAdapter({
      auth: w.auth,
      orgContext: true,
      resolveOrgRoles: w.resolveOrgRoles,
      memberLookup,
    });
    await server.register(plugin);
    const gate = requireOrgRole("manager");
    server.get("/managers-only", { preHandler: [server.authenticate] }, async (request, reply) => {
      const scope = (request as unknown as { scope: Record<string, unknown> }).scope;
      const user = (request as unknown as { user: Record<string, unknown> }).user;
      const verdict = await gate({
        user: user as never,
        scope: scope as never,
        request,
        resource: "t",
        action: "get",
      });
      const allowed = verdict === true || (typeof verdict === "object" && verdict.granted);
      return reply.code(allowed ? 200 : 403).send({ scope });
    });
    await server.ready();

    const call = async (token: string, organizationId?: string) => {
      const before = w.reads();
      const res = await server.inject({
        method: "GET",
        url: "/managers-only",
        headers: {
          authorization: `Bearer ${token}`,
          ...(organizationId ? { "x-organization-id": organizationId } : {}),
        },
      });
      return {
        status: res.statusCode,
        scope: res.statusCode === 401 ? null : (res.json() as { scope: unknown }).scope,
        reads: w.reads() - before,
      };
    };

    const allowed = await call("manager");
    const requestedOther = await call("manager", "org-b");
    const requestedUnknown = await call("manager", "org-missing");
    const denied = await call("cashier");
    const notAMember = await call("outsider");
    w.switchOrg("manager", "org-b");
    const afterSwitch = await call("manager");
    w.ban("cashier");
    const banned = await call("cashier");
    return { allowed, denied, notAMember, afterSwitch, banned, requestedOther, requestedUnknown };
  }

  it("decides every case exactly as the default does", async () => {
    const strip = (r: Awaited<ReturnType<typeof run>>) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, { status: v.status, scope: v.scope }]),
      );
    const byDefault = await run("better-auth");
    await app?.close();
    const viaResolver = await run("resolver");

    expect(strip(viaResolver)).toEqual(strip(byDefault));
    expect(byDefault.allowed.status).toBe(200);
    expect(byDefault.requestedOther).toMatchObject({
      status: 403,
      scope: { kind: "member", organizationId: "org-b", orgRoles: ["cashier"] },
    });
    expect(byDefault.requestedUnknown).toMatchObject({
      status: 403,
      scope: { kind: "authenticated" },
    });
    expect(byDefault.denied.status).toBe(403);
    expect(byDefault.notAMember).toMatchObject({ status: 403, scope: { kind: "authenticated" } });
    expect(byDefault.afterSwitch).toMatchObject({
      status: 403,
      scope: { kind: "member", organizationId: "org-b", orgRoles: ["cashier"] },
    });
    expect(byDefault.banned.status).toBe(401);
  });

  it("reads membership once per request instead of twice (three for a non-member)", async () => {
    const byDefault = await run("better-auth");
    await app?.close();
    const viaResolver = await run("resolver");

    expect(byDefault.allowed.reads).toBe(2);
    expect(byDefault.notAMember.reads).toBe(3);
    for (const outcome of [
      viaResolver.allowed,
      viaResolver.denied,
      viaResolver.notAMember,
      viaResolver.afterSwitch,
    ]) {
      expect(outcome.reads).toBe(1);
    }
    expect(viaResolver.banned.reads).toBe(0);
  });

  it("calls the resolver with memberRoles: null", async () => {
    const w = world();
    const seen: unknown[] = [];
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: w.auth,
      orgContext: true,
      memberLookup: "resolver",
      resolveOrgRoles: (input) => {
        seen.push(input);
        return w.resolveOrgRoles(input);
      },
    });
    await app.register(plugin);
    app.get("/t", { preHandler: [app.authenticate] }, async () => ({}));
    await app.ready();
    await app.inject({ method: "GET", url: "/t", headers: { authorization: "Bearer manager" } });
    expect(seen).toEqual([{ userId: "manager", organizationId: "org-a", memberRoles: null }]);
  });

  it("refuses 'resolver' without resolveOrgRoles, and an unknown value", () => {
    const { auth } = world();
    expect(() =>
      createBetterAuthAdapter({ auth, orgContext: true, memberLookup: "resolver" }),
    ).toThrow(/requires `resolveOrgRoles`/);
    expect(() =>
      createBetterAuthAdapter({
        auth,
        orgContext: true,
        memberLookup: "skip" as unknown as Lookup,
      }),
    ).toThrow(/must be 'better-auth' or 'resolver'/);
  });
});
