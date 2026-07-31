/**
 * Unit tests for the single-source-of-truth permission seam (arc 2.30).
 *
 * Every call site in Arc (createCrudRouter, createActionRouter, MCP tool
 * handlers) funnels through these functions to normalize a check return into an
 * AuthorizationDecision and apply its side-effects. If the behavior here
 * changes, all call sites inherit the change — these tests pin the contract.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  applyAuthorizationDecision,
  evaluateAndApplyPermission,
  evaluatePermissionDecision,
  normalizeToDecision,
} from "../../src/permissions/authorizationDecision.js";
import type {
  AuthorizationDecision,
  PermissionCheck,
  PermissionContext,
} from "../../src/permissions/types.js";
import type { RequestScope } from "../../src/scope/types.js";
import { ForbiddenError } from "../../src/utils/errors.js";

type Sink = FastifyRequest & {
  _policyFilters?: Record<string, unknown>;
  scope?: RequestScope;
};

function makeRequest(initial: Partial<Sink> = {}): Sink {
  return { ...initial } as Sink;
}

describe("evaluatePermission — transport-neutral PDP", () => {
  const ctx = { user: null, resource: "widget", action: "list" } as unknown as PermissionContext;

  it("normalizes a boolean/allow/deny check into a decision", async () => {
    expect(await evaluatePermissionDecision(async () => true, ctx)).toEqual({ effect: "allow" });
    expect(
      await evaluatePermissionDecision(async () => ({ effect: "deny", reason: "no" }), ctx),
    ).toEqual({
      effect: "deny",
      reason: "no",
    });
  });

  it("fails CLOSED (deny) when a check throws a generic error — never falls open", async () => {
    const decision = await evaluatePermissionDecision(async () => {
      throw new Error("db down");
    }, ctx);
    expect(decision.effect).toBe("deny");
  });

  it("RE-THROWS a structured ArcError so the transport can surface it verbatim", async () => {
    const check: PermissionCheck = async () => {
      throw new ForbiddenError("tier required");
    };
    await expect(evaluatePermissionDecision(check, ctx)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("normalizeToDecision", () => {
  it("promotes `true`/`false` to an allow/deny decision", () => {
    expect(normalizeToDecision(true)).toEqual({ effect: "allow" });
    expect(normalizeToDecision(false)).toEqual({ effect: "deny" });
  });

  it("passes AuthorizationDecision objects through unchanged", () => {
    const input: AuthorizationDecision = {
      effect: "allow",
      policy: { userId: "u1" },
      scope: { kind: "public" },
    };
    expect(normalizeToDecision(input)).toBe(input);
  });
});

describe("applyAuthorizationDecision — data policy", () => {
  it("conjoins policy into an empty request", () => {
    const req = makeRequest();
    applyAuthorizationDecision({ effect: "allow", policy: { userId: "u1" } }, req);
    expect(req._policyFilters).toEqual({ userId: "u1" });
  });

  it("carries non-overlapping keys through flat", () => {
    const req = makeRequest({ _policyFilters: { tenantId: "t1" } });
    applyAuthorizationDecision({ effect: "allow", policy: { feature: "beta" } }, req);
    expect(req._policyFilters).toEqual({ tenantId: "t1", feature: "beta" });
  });

  it("CONJOINS a same-key conflict under $and — never silently overwrites", () => {
    const req = makeRequest({ _policyFilters: { projectId: "p1" } });
    applyAuthorizationDecision({ effect: "allow", policy: { projectId: "p2" } }, req);
    expect(req._policyFilters).toEqual({ $and: [{ projectId: "p1" }, { projectId: "p2" }] });
  });

  it("is a no-op when the decision has no policy", () => {
    const req = makeRequest({ _policyFilters: { existing: true } });
    applyAuthorizationDecision({ effect: "allow" }, req);
    expect(req._policyFilters).toEqual({ existing: true });
  });

  it("is a no-op on a denied decision (defensive)", () => {
    const req = makeRequest();
    applyAuthorizationDecision({ effect: "deny", policy: { leak: "no" } }, req);
    expect(req._policyFilters).toBeUndefined();
    expect(req.scope).toBeUndefined();
  });
});

describe("applyAuthorizationDecision — scope non-downgrade rule", () => {
  const service: RequestScope = { kind: "service", clientId: "client-1", organizationId: "org-1" };
  const member: RequestScope = {
    kind: "member",
    userId: "u1",
    userRoles: ["user"],
    organizationId: "org-1",
    orgRoles: ["admin"],
  };
  const elevated: RequestScope = {
    kind: "elevated",
    userId: "u1",
    organizationId: "org-1",
    elevatedBy: "u1",
  };

  it("installs scope when request.scope is undefined", () => {
    const req = makeRequest();
    applyAuthorizationDecision({ effect: "allow", scope: service }, req);
    expect(req.scope).toEqual(service);
  });

  it("installs scope when current scope is `public`", () => {
    const req = makeRequest({ scope: { kind: "public" } });
    applyAuthorizationDecision({ effect: "allow", scope: service }, req);
    expect(req.scope).toEqual(service);
  });

  it("NEVER downgrades a `member` scope", () => {
    const req = makeRequest({ scope: member });
    applyAuthorizationDecision({ effect: "allow", scope: service }, req);
    expect(req.scope).toEqual(member);
  });

  it("NEVER downgrades an `elevated` scope", () => {
    const req = makeRequest({ scope: elevated });
    applyAuthorizationDecision({ effect: "allow", scope: service }, req);
    expect(req.scope).toEqual(elevated);
  });

  it("installs both policy and scope atomically", () => {
    const req = makeRequest();
    applyAuthorizationDecision(
      { effect: "allow", policy: { projectId: "p1" }, scope: service },
      req,
    );
    expect(req.scope).toEqual(service);
    expect(req._policyFilters).toEqual({ projectId: "p1" });
  });
});

// ============================================================================
// evaluateAndApplyPermission — end-to-end flow
// ============================================================================

type ReplyMock = {
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  statusCode?: number;
  payload?: unknown;
};

function makeReply(): ReplyMock & FastifyReply {
  const reply: ReplyMock = { code: vi.fn(), send: vi.fn() };
  reply.code.mockImplementation((status: number) => {
    reply.statusCode = status;
    return reply;
  });
  reply.send.mockImplementation((body: unknown) => {
    reply.payload = body;
    return reply;
  });
  return reply as ReplyMock & FastifyReply;
}

function makeContext(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    user: null,
    request: {} as FastifyRequest,
    resource: "widget",
    action: "list",
    ...overrides,
  };
}

function makeEvalRequest(initial: Partial<Sink> = {}): Sink {
  const req = { ...initial } as Sink & { log?: { warn: ReturnType<typeof vi.fn> } };
  req.log = { warn: vi.fn() } as unknown as FastifyRequest["log"];
  return req;
}

describe("evaluateAndApplyPermission — grant path", () => {
  it("returns true on boolean true (no reply interaction)", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = vi.fn(async () => true);

    const authorized = await evaluateAndApplyPermission(check, makeContext(), req, reply);

    expect(authorized).toBe(true);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("applies policy + scope when the check returns an allow decision", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const scope: RequestScope = { kind: "service", clientId: "c1", organizationId: "o1" };
    const check: PermissionCheck = async () => ({
      effect: "allow",
      policy: { projectId: "p1" },
      scope,
    });

    const authorized = await evaluateAndApplyPermission(check, makeContext(), req, reply);

    expect(authorized).toBe(true);
    expect(req._policyFilters).toEqual({ projectId: "p1" });
    expect(req.scope).toEqual(scope);
    expect(reply.code).not.toHaveBeenCalled();
  });
});

describe("evaluateAndApplyPermission — denial path", () => {
  it("returns 401 'Authentication required' when user is null", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => false;

    const authorized = await evaluateAndApplyPermission(
      check,
      makeContext({ user: null }),
      req,
      reply,
    );

    expect(authorized).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.unauthorized",
      message: "Authentication required",
      status: 401,
    });
  });

  it("returns 403 'Permission denied' when user is present", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => false;

    await evaluateAndApplyPermission(check, makeContext({ user: { id: "u1" } }), req, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.forbidden",
      message: "Permission denied",
      status: 403,
    });
  });

  it("uses the decision reason when provided and ≤100 chars", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => ({
      effect: "deny",
      reason: "user lacks role admin",
    });

    await evaluateAndApplyPermission(check, makeContext({ user: { id: "u1" } }), req, reply);

    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.forbidden",
      message: "user lacks role admin",
      status: 403,
    });
  });

  it("clamps an over-long reason to the default (prevents info leak)", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => ({ effect: "deny", reason: "x".repeat(101) });

    await evaluateAndApplyPermission(check, makeContext({ user: { id: "u1" } }), req, reply);

    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.forbidden",
      message: "Permission denied",
      status: 403,
    });
  });

  it("honors defaultDenialMessage for callsite-specific strings", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => false;

    await evaluateAndApplyPermission(
      check,
      makeContext({ user: { id: "u1" }, action: "approve" }),
      req,
      reply,
      {
        defaultDenialMessage: (user) =>
          user ? "Permission denied for 'approve'" : "Auth required",
      },
    );

    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.forbidden",
      message: "Permission denied for 'approve'",
      status: 403,
    });
  });

  it("does NOT apply policy from a denied decision (defensive)", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => ({
      effect: "deny",
      reason: "nope",
      policy: { leak: "no" },
    });

    await evaluateAndApplyPermission(check, makeContext({ user: { id: "u1" } }), req, reply);

    expect(req._policyFilters).toBeUndefined();
  });
});

describe("evaluateAndApplyPermission — thrown check", () => {
  it("catches a non-ArcError throw and fails closed to a 403 forbidden", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => {
      throw new Error("boom");
    };

    // The throw is normalized + logged once by the shared evaluation core
    // (`evaluatePermissionOutcome` → arc's namespaced logger, same channel the
    // neutral PDP uses). The HTTP PEP only maps the classified outcome onto the
    // wire — so the observable contract is the fail-closed 403, not the log sink.
    const authorized = await evaluateAndApplyPermission(check, makeContext(), req, reply);

    expect(authorized).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: "arc.forbidden", status: 403 }),
    );
  });

  it("thrown check returns 403 even when user is null (never leak auth state)", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => {
      throw new Error("db down");
    };

    await evaluateAndApplyPermission(check, makeContext({ user: null }), req, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });
});
