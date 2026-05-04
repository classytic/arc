/**
 * Unit tests for the single-source-of-truth permission-result helper.
 *
 * Every call site in Arc (createCrudRouter, createActionRouter, MCP tool
 * handlers) funnels through these two functions to apply PermissionResult
 * side-effects. If the behavior here changes, all three call sites inherit
 * the change — and these tests pin the contract.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  applyPermissionResult,
  evaluateAndApplyPermission,
  normalizePermissionResult,
} from "../../src/permissions/applyPermissionResult.js";
import type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
} from "../../src/permissions/types.js";
import type { RequestScope } from "../../src/scope/types.js";

type Sink = FastifyRequest & {
  _policyFilters?: Record<string, unknown>;
  scope?: RequestScope;
};

function makeRequest(initial: Partial<Sink> = {}): Sink {
  return { ...initial } as Sink;
}

describe("normalizePermissionResult", () => {
  it("promotes `true` to { granted: true }", () => {
    expect(normalizePermissionResult(true)).toEqual({ granted: true });
  });

  it("promotes `false` to { granted: false }", () => {
    expect(normalizePermissionResult(false)).toEqual({ granted: false });
  });

  it("passes PermissionResult objects through unchanged", () => {
    const input = {
      granted: true,
      filters: { userId: "u1" },
      scope: { kind: "public" } as const,
    };
    expect(normalizePermissionResult(input)).toBe(input);
  });

  it("preserves reason on denied results", () => {
    expect(normalizePermissionResult({ granted: false, reason: "no access" })).toEqual({
      granted: false,
      reason: "no access",
    });
  });
});

describe("applyPermissionResult — filters", () => {
  it("merges filters into an empty request", () => {
    const req = makeRequest();
    applyPermissionResult({ granted: true, filters: { userId: "u1" } }, req);
    expect(req._policyFilters).toEqual({ userId: "u1" });
  });

  it("merges filters on top of existing _policyFilters (last-writer-wins per key)", () => {
    const req = makeRequest({ _policyFilters: { tenantId: "t1", projectId: "p1" } });
    applyPermissionResult({ granted: true, filters: { projectId: "p2", feature: "beta" } }, req);
    expect(req._policyFilters).toEqual({
      tenantId: "t1",
      projectId: "p2",
      feature: "beta",
    });
  });

  it("is a no-op when result has no filters", () => {
    const req = makeRequest({ _policyFilters: { existing: true } });
    applyPermissionResult({ granted: true }, req);
    expect(req._policyFilters).toEqual({ existing: true });
  });

  it("is a no-op when result is not granted (defensive — callers should have already responded)", () => {
    const req = makeRequest();
    applyPermissionResult({ granted: false, filters: { leak: "should-not-apply" } }, req);
    expect(req._policyFilters).toBeUndefined();
    expect(req.scope).toBeUndefined();
  });
});

describe("applyPermissionResult — scope non-downgrade rule", () => {
  const service: RequestScope = {
    kind: "service",
    clientId: "client-1",
    organizationId: "org-1",
  };
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
    applyPermissionResult({ granted: true, scope: service }, req);
    expect(req.scope).toEqual(service);
  });

  it("installs scope when current scope is `public`", () => {
    const req = makeRequest({ scope: { kind: "public" } });
    applyPermissionResult({ granted: true, scope: service }, req);
    expect(req.scope).toEqual(service);
  });

  it("NEVER downgrades a `member` scope", () => {
    const req = makeRequest({ scope: member });
    applyPermissionResult({ granted: true, scope: service }, req);
    expect(req.scope).toEqual(member);
  });

  it("NEVER downgrades an `elevated` scope", () => {
    const req = makeRequest({ scope: elevated });
    applyPermissionResult({ granted: true, scope: service }, req);
    expect(req.scope).toEqual(elevated);
  });

  it("NEVER downgrades an `authenticated` scope", () => {
    const authenticated: RequestScope = {
      kind: "authenticated",
      userId: "u1",
      userRoles: [],
    };
    const req = makeRequest({ scope: authenticated });
    applyPermissionResult({ granted: true, scope: service }, req);
    expect(req.scope).toEqual(authenticated);
  });

  it("installs scope even when the result has no filters", () => {
    const req = makeRequest();
    applyPermissionResult({ granted: true, scope: service }, req);
    expect(req.scope).toEqual(service);
    expect(req._policyFilters).toBeUndefined();
  });

  it("installs both filters and scope atomically", () => {
    const req = makeRequest();
    applyPermissionResult({ granted: true, filters: { projectId: "p1" }, scope: service }, req);
    expect(req.scope).toEqual(service);
    expect(req._policyFilters).toEqual({ projectId: "p1" });
  });
});

// ============================================================================
// evaluateAndApplyPermission — end-to-end flow
// ============================================================================
//
// Pins the contract shared by createCrudRouter + createActionRouter:
//   1. try/catch permissionCheck → 403 on throw
//   2. normalize boolean → PermissionResult
//   3. denial → 401 (no user) / 403 (user) with clamped reason
//   4. grant → apply filters + scope, return true
//
// The CRUD router and action router now both delegate to this function.
// Any change here affects both callsites, so these tests lock the behavior.

type ReplyMock = {
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  statusCode?: number;
  payload?: unknown;
};

function makeReply(): ReplyMock & FastifyReply {
  const reply: ReplyMock = {
    code: vi.fn(),
    send: vi.fn(),
  };
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
  it("returns true when check returns boolean true (no reply interaction)", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = vi.fn(async () => true);

    const authorized = await evaluateAndApplyPermission(check, makeContext(), req, reply);

    expect(authorized).toBe(true);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("returns true and applies filters+scope when check returns granted result", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const scope: RequestScope = {
      kind: "service",
      clientId: "c1",
      organizationId: "o1",
    };
    const check: PermissionCheck = async () => ({
      granted: true,
      filters: { projectId: "p1" },
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
  it("returns 401 with 'Authentication required' when user is null", async () => {
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

  it("returns 403 with 'Permission denied' when user is present", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => false;

    const authorized = await evaluateAndApplyPermission(
      check,
      makeContext({ user: { id: "u1" } }),
      req,
      reply,
    );

    expect(authorized).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.forbidden",
      message: "Permission denied",
      status: 403,
    });
  });

  it("uses PermissionResult.reason when provided and ≤100 chars", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => ({
      granted: false,
      reason: "user lacks role admin",
    });

    await evaluateAndApplyPermission(check, makeContext({ user: { id: "u1" } }), req, reply);

    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.forbidden",
      message: "user lacks role admin",
      status: 403,
    });
  });

  it("clamps reason and falls back to default when >100 chars (prevents info leak)", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const longReason = "x".repeat(101);
    const check: PermissionCheck = async () => ({ granted: false, reason: longReason });

    await evaluateAndApplyPermission(check, makeContext({ user: { id: "u1" } }), req, reply);

    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.forbidden",
      message: "Permission denied",
      status: 403,
    });
  });

  it("honors defaultDenialMessage callback for callsite-specific error strings", async () => {
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
          user ? `Permission denied for 'approve'` : "Authentication required",
      },
    );

    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.forbidden",
      message: "Permission denied for 'approve'",
      status: 403,
    });
  });

  it("defaultDenialMessage is still overridden by a short PermissionResult.reason", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => ({ granted: false, reason: "rate limited" });

    await evaluateAndApplyPermission(check, makeContext({ user: { id: "u1" } }), req, reply, {
      defaultDenialMessage: () => "ignored default",
    });

    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.forbidden",
      message: "rate limited",
      status: 403,
    });
  });

  it("does NOT apply filters from a denied PermissionResult (defensive)", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () =>
      ({
        granted: false,
        reason: "nope",
        filters: { leak: "should-not-apply" },
      }) as PermissionResult;

    await evaluateAndApplyPermission(check, makeContext({ user: { id: "u1" } }), req, reply);

    expect(req._policyFilters).toBeUndefined();
  });
});

describe("evaluateAndApplyPermission — thrown check", () => {
  it("catches thrown errors, logs a warn, returns 403", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => {
      throw new Error("boom");
    };

    const authorized = await evaluateAndApplyPermission(check, makeContext(), req, reply);

    expect(authorized).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      code: "arc.forbidden",
      message: "Permission denied",
      status: 403,
    });
    expect(req.log?.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        resource: "widget",
        action: "list",
      }),
      "Permission check threw",
    );
  });

  it("thrown check returns 403 even when user is null (security: never leak auth state via throw)", async () => {
    const req = makeEvalRequest();
    const reply = makeReply();
    const check: PermissionCheck = async () => {
      throw new Error("db down");
    };

    await evaluateAndApplyPermission(check, makeContext({ user: null }), req, reply);

    // NB: unlike the controlled denial path (401 when unauthenticated),
    // throws always produce 403. This is fail-closed: a broken check
    // must never be confused with "just needs to log in".
    expect(reply.code).toHaveBeenCalledWith(403);
  });
});
