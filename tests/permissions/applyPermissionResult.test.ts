/**
 * Unit tests for the single-source-of-truth permission-result helper.
 *
 * Every call site in Arc (createCrudRouter, createActionRouter, MCP tool
 * handlers) funnels through these two functions to apply PermissionResult
 * side-effects. If the behavior here changes, all three call sites inherit
 * the change — and these tests pin the contract.
 */

import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  applyPermissionResult,
  normalizePermissionResult,
} from "../../src/permissions/applyPermissionResult.js";
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
