/**
 * Multi-Tenant Preset × Multi-Field Filtering Tests — 2.7.1 Gap 2
 *
 * Behavioral tests for the new `tenantFields` config that lets a single
 * preset apply lockstep filtering across multiple tenancy dimensions
 * (org + branch, org + project, org + team + workspace, etc).
 *
 * Pre-2.7.1, the preset only supported one tenant field. Single-org-with-
 * branches and multi-project-per-team scenarios required custom middleware.
 *
 * The single-field form (`tenantField: '...'`) still works untouched —
 * regression-tested in tests/presets/multi-tenant-service-scope.test.ts and
 * tests/presets/multi-tenant.test.ts. This file exclusively tests the new
 * multi-field form.
 */

import { describe, expect, it, vi } from "vitest";
import { multiTenantPreset, type TenantFieldSpec } from "../../src/presets/multiTenant.js";
import type { RequestScope } from "../../src/scope/types.js";
import type { RequestWithExtras, RouteHandler } from "../../src/types/index.js";

// ============================================================================
// Helpers
// ============================================================================

function makeRequest(scope: RequestScope, body?: Record<string, unknown>): RequestWithExtras {
  return {
    scope,
    body,
    _policyFilters: undefined,
  } as unknown as RequestWithExtras;
}

function makeReply(): {
  reply: { code: (n: number) => unknown; send: (p: unknown) => unknown };
  status: { code?: number; payload?: unknown };
} {
  const status: { code?: number; payload?: unknown } = {};
  const reply = {
    code: vi.fn((n: number) => {
      status.code = n;
      return reply;
    }),
    send: vi.fn((p: unknown) => {
      status.payload = p;
      return reply;
    }),
  };
  return { reply, status };
}

async function run(
  middleware: RouteHandler,
  request: RequestWithExtras,
  reply: ReturnType<typeof makeReply>["reply"],
): Promise<void> {
  await (middleware as unknown as (req: unknown, rep: unknown) => Promise<void>)(request, reply);
}

// ============================================================================
// Strict filter — multi-field, member scope
// ============================================================================

describe("multiTenantPreset({ tenantFields }) — strict filter, member scope", () => {
  const tenantFields: TenantFieldSpec[] = [
    { field: "organizationId", type: "org" },
    { field: "branchId", contextKey: "branchId" },
  ];
  const preset = multiTenantPreset({ tenantFields });
  const listMiddleware = preset.middlewares?.list?.[0] as RouteHandler;

  it("applies BOTH org and branch filters when both are present in scope", async () => {
    const request = makeRequest({
      kind: "member",
      userId: "user-1",
      userRoles: [],
      organizationId: "org-acme",
      orgRoles: ["member"],
      context: { branchId: "eng-paris" },
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toEqual({
      organizationId: "org-acme",
      branchId: "eng-paris",
    });
  });

  it("403s when org is present but branch context is missing (fail-closed)", async () => {
    const request = makeRequest({
      kind: "member",
      userId: "user-1",
      userRoles: [],
      organizationId: "org-acme",
      orgRoles: ["member"],
      // no context.branchId
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBe(403);
    expect((status.payload as { message: string }).message).toContain("branchId");
    expect((status.payload as { message: string }).message).toContain("missing");
    expect(request._policyFilters).toBeUndefined();
  });

  it("preserves existing _policyFilters when adding multi-field filters", async () => {
    const request = makeRequest({
      kind: "member",
      userId: "user-1",
      userRoles: [],
      organizationId: "org-acme",
      orgRoles: ["member"],
      context: { branchId: "eng-paris" },
    });
    request._policyFilters = { existingField: "preserved" };
    const { reply } = makeReply();

    await run(listMiddleware, request, reply);

    expect(request._policyFilters).toEqual({
      existingField: "preserved",
      organizationId: "org-acme",
      branchId: "eng-paris",
    });
  });
});

// ============================================================================
// Strict filter — multi-field, service scope (API key)
// ============================================================================

describe("multiTenantPreset({ tenantFields }) — service scope (API key)", () => {
  const preset = multiTenantPreset({
    tenantFields: [
      { field: "organizationId", type: "org" },
      { field: "projectId", contextKey: "projectId" },
    ],
  });
  const listMiddleware = preset.middlewares?.list?.[0] as RouteHandler;

  it("applies all filters for an API key with full context", async () => {
    const request = makeRequest({
      kind: "service",
      clientId: "api-key-fajr",
      organizationId: "org-acme",
      context: { projectId: "p-123" },
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toEqual({
      organizationId: "org-acme",
      projectId: "p-123",
    });
  });

  it("403s when API key has org but no projectId context", async () => {
    const request = makeRequest({
      kind: "service",
      clientId: "api-key-incomplete",
      organizationId: "org-acme",
      // no context
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBe(403);
    expect((status.payload as { message: string }).message).toContain("projectId");
  });
});

// ============================================================================
// Elevated bypass — applies what resolves, skips what doesn't
// ============================================================================

describe("multiTenantPreset({ tenantFields }) — elevated bypass", () => {
  const preset = multiTenantPreset({
    tenantFields: [
      { field: "organizationId", type: "org" },
      { field: "branchId", contextKey: "branchId" },
    ],
  });
  const listMiddleware = preset.middlewares?.list?.[0] as RouteHandler;

  it("applies all dimensions when elevated has full context", async () => {
    const request = makeRequest({
      kind: "elevated",
      userId: "admin-1",
      elevatedBy: "x-arc-scope",
      organizationId: "org-acme",
      context: { branchId: "eng-paris" },
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toEqual({
      organizationId: "org-acme",
      branchId: "eng-paris",
    });
  });

  it("applies only org filter when elevated has org but no branch (partial bypass)", async () => {
    const request = makeRequest({
      kind: "elevated",
      userId: "admin-1",
      elevatedBy: "x-arc-scope",
      organizationId: "org-acme",
      // no branch context
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    // Critical: elevated admin is NOT blocked by missing branch dimension.
    // This preserves the "platform admin can act anywhere" semantics.
    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toEqual({ organizationId: "org-acme" });
  });

  it("applies no filter when elevated has neither org nor branch (full cross-tenant)", async () => {
    const request = makeRequest({
      kind: "elevated",
      userId: "admin-1",
      elevatedBy: "x-arc-scope",
      // no org, no branch — true cross-tenant admin view
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toBeUndefined();
  });
});

// ============================================================================
// Tenant injection — multi-field create flow
// ============================================================================

describe("multiTenantPreset({ tenantFields }) — injection (create)", () => {
  const preset = multiTenantPreset({
    tenantFields: [
      { field: "organizationId", type: "org" },
      { field: "branchId", contextKey: "branchId" },
      { field: "projectId", contextKey: "projectId" },
    ],
  });
  const createMiddleware = preset.middlewares?.create?.[0] as RouteHandler;

  it("injects ALL configured tenant fields into the body", async () => {
    const request = makeRequest(
      {
        kind: "member",
        userId: "user-1",
        userRoles: [],
        organizationId: "org-acme",
        orgRoles: ["member"],
        context: { branchId: "eng-paris", projectId: "p-1" },
      },
      { name: "Job 1", status: "open" },
    );
    const { reply, status } = makeReply();

    await run(createMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request.body).toEqual({
      name: "Job 1",
      status: "open",
      organizationId: "org-acme",
      branchId: "eng-paris",
      projectId: "p-1",
    });
  });

  it("403s create when ANY required dimension is missing", async () => {
    const request = makeRequest(
      {
        kind: "member",
        userId: "user-1",
        userRoles: [],
        organizationId: "org-acme",
        orgRoles: ["member"],
        context: { branchId: "eng-paris" }, // no projectId
      },
      { name: "Job 1" },
    );
    const { reply, status } = makeReply();

    await run(createMiddleware, request, reply);

    expect(status.code).toBe(403);
    expect((status.payload as { message: string }).message).toContain("projectId");
    expect(request.body).toEqual({ name: "Job 1" }); // unchanged
  });

  it("injects multi-field for service scope (API key)", async () => {
    const request = makeRequest(
      {
        kind: "service",
        clientId: "api-key-fajr",
        organizationId: "org-acme",
        context: { branchId: "eng-paris", projectId: "p-1" },
      },
      { name: "Job 1" },
    );
    const { reply, status } = makeReply();

    await run(createMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request.body).toEqual({
      name: "Job 1",
      organizationId: "org-acme",
      branchId: "eng-paris",
      projectId: "p-1",
    });
  });
});

// ============================================================================
// Team type — built-in scope.teamId source
// ============================================================================

describe("multiTenantPreset({ tenantFields }) — type: 'team' source", () => {
  const preset = multiTenantPreset({
    tenantFields: [
      { field: "organizationId", type: "org" },
      { field: "teamId", type: "team" },
    ],
  });
  const listMiddleware = preset.middlewares?.list?.[0] as RouteHandler;

  it("reads scope.teamId via type: 'team'", async () => {
    const request = makeRequest({
      kind: "member",
      userId: "user-1",
      userRoles: [],
      organizationId: "org-acme",
      orgRoles: ["member"],
      teamId: "team-backend",
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toEqual({
      organizationId: "org-acme",
      teamId: "team-backend",
    });
  });

  it("403s when teamId is missing on member scope", async () => {
    const request = makeRequest({
      kind: "member",
      userId: "user-1",
      userRoles: [],
      organizationId: "org-acme",
      orgRoles: ["member"],
      // no teamId
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBe(403);
    expect((status.payload as { message: string }).message).toContain("teamId");
  });
});

// ============================================================================
// Mutual exclusion + validation
// ============================================================================

describe("multiTenantPreset — config validation", () => {
  it("throws when both tenantField and tenantFields are passed", () => {
    expect(() =>
      multiTenantPreset({
        tenantField: "organizationId",
        tenantFields: [{ field: "branchId", contextKey: "branchId" }],
      }),
    ).toThrow(/either `tenantField`.*or `tenantFields`/);
  });

  it("throws when tenantFields is an empty array", () => {
    expect(() => multiTenantPreset({ tenantFields: [] })).toThrow(/at least one entry/);
  });

  it("backwards compatible: single tenantField still works (no tenantFields needed)", () => {
    // Smoke check — full coverage lives in tests/presets/multi-tenant.test.ts
    // and tests/presets/multi-tenant-service-scope.test.ts. This just confirms
    // the new normalization preserves the old behavior.
    expect(() => multiTenantPreset({ tenantField: "organizationId" })).not.toThrow();
    expect(() => multiTenantPreset()).not.toThrow(); // default
  });
});

// ============================================================================
// Flexible filter (allowPublic) — multi-field
// ============================================================================

describe("multiTenantPreset({ tenantFields, allowPublic }) — flexible filter", () => {
  const preset = multiTenantPreset({
    tenantFields: [
      { field: "organizationId", type: "org" },
      { field: "branchId", contextKey: "branchId" },
    ],
    allowPublic: ["list"],
  });
  const listMiddleware = preset.middlewares?.list?.[0] as RouteHandler;

  it("public/unauthenticated falls through (no filter, no 401)", async () => {
    const request = makeRequest({ kind: "public" });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toBeUndefined();
  });

  it("authenticated tenant caller still must satisfy ALL dimensions", async () => {
    // Critical: API keys / members don't get a free pass on allowPublic routes.
    // Partial context = 403, otherwise we'd leak data the caller shouldn't see.
    const request = makeRequest({
      kind: "member",
      userId: "user-1",
      userRoles: [],
      organizationId: "org-acme",
      orgRoles: ["member"],
      // no branchId context
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBe(403);
    expect((status.payload as { message: string }).message).toContain("branchId");
  });

  it("authenticated tenant caller WITH all dimensions gets the filter", async () => {
    const request = makeRequest({
      kind: "member",
      userId: "user-1",
      userRoles: [],
      organizationId: "org-acme",
      orgRoles: ["member"],
      context: { branchId: "eng-paris" },
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toEqual({
      organizationId: "org-acme",
      branchId: "eng-paris",
    });
  });
});
