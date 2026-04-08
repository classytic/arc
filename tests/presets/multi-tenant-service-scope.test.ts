/**
 * Multi-Tenant Preset × Service Scope Tests — 2.7.0 Gap 1c
 *
 * Behavioral tests that invoke the multiTenantPreset middlewares directly
 * against fake Fastify requests to verify the filter/injection logic
 * recognizes service scopes (API key auth) and applies the same org
 * isolation it does for member scopes.
 *
 * Pre-2.7.0, the preset only checked `isMember || isElevated`, so an API
 * call that authenticated via an API key (synthetic `service` scope with
 * `organizationId` set) would 403 with "Organization context required for
 * this operation" — making it impossible to use API keys with multi-tenant
 * resources without bypassing the preset entirely.
 */

import { describe, expect, it, vi } from "vitest";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import type { RequestScope } from "../../src/scope/types.js";
import type { RequestWithExtras, RouteHandler } from "../../src/types/index.js";

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal fake Fastify request with a scope and optional body. */
function makeRequest(scope: RequestScope, body?: Record<string, unknown>): RequestWithExtras {
  return {
    scope,
    body,
    _policyFilters: undefined,
  } as unknown as RequestWithExtras;
}

/** Build a minimal fake Fastify reply that captures status + payload. */
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

/** Run a middleware handler against a request/reply pair. */
async function run(
  middleware: RouteHandler,
  request: RequestWithExtras,
  reply: ReturnType<typeof makeReply>["reply"],
): Promise<void> {
  // Cast to satisfy the RouteHandler signature; the fake reply has the
  // surface area the multiTenant middlewares actually use (code, send).
  await (middleware as unknown as (req: unknown, rep: unknown) => Promise<void>)(request, reply);
}

// ============================================================================
// Strict filter (default) — service scope behavior
// ============================================================================

describe("multiTenantPreset filter (strict) — service scope (Gap 1c)", () => {
  const preset = multiTenantPreset({ tenantField: "organizationId" });
  const listMiddleware = preset.middlewares?.list?.[0] as RouteHandler;

  it("applies tenant filter for service scope bound to an org", async () => {
    const request = makeRequest({
      kind: "service",
      clientId: "api-key-fajr",
      organizationId: "org-acme",
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    // Did NOT 403
    expect(status.code).toBeUndefined();
    // DID install the policy filter
    expect(request._policyFilters).toEqual({ organizationId: "org-acme" });
  });

  it("preserves existing _policyFilters when adding the tenant filter", async () => {
    const request = makeRequest({
      kind: "service",
      clientId: "api-key-fajr",
      organizationId: "org-acme",
    });
    request._policyFilters = { existingField: "preserved" };
    const { reply } = makeReply();

    await run(listMiddleware, request, reply);

    expect(request._policyFilters).toEqual({
      existingField: "preserved",
      organizationId: "org-acme",
    });
  });

  it("still applies tenant filter for member scope (no regression)", async () => {
    const request = makeRequest({
      kind: "member",
      userId: "user-1",
      userRoles: [],
      organizationId: "org-acme",
      orgRoles: ["member"],
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toEqual({ organizationId: "org-acme" });
  });

  it("still skips filter for elevated-without-org (cross-org admin)", async () => {
    const request = makeRequest({
      kind: "elevated",
      userId: "admin-1",
      elevatedBy: "x-arc-scope",
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toBeUndefined();
  });

  it("still 401s for public scopes (no auth)", async () => {
    const request = makeRequest({ kind: "public" });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBe(401);
    expect(request._policyFilters).toBeUndefined();
  });

  it("still 403s for authenticated-without-org users", async () => {
    const request = makeRequest({ kind: "authenticated", userId: "user-1" });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBe(403);
    expect(request._policyFilters).toBeUndefined();
  });
});

// ============================================================================
// Tenant injection (create) — service scope behavior
// ============================================================================

describe("multiTenantPreset injection (create) — service scope (Gap 1c)", () => {
  const preset = multiTenantPreset({ tenantField: "organizationId" });
  const createMiddleware = preset.middlewares?.create?.[0] as RouteHandler;

  it("injects organizationId into the body for service scopes", async () => {
    const request = makeRequest(
      {
        kind: "service",
        clientId: "api-key-fajr",
        organizationId: "org-acme",
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
    });
  });

  it("still injects for member scopes (no regression)", async () => {
    const request = makeRequest(
      {
        kind: "member",
        userId: "user-1",
        userRoles: [],
        organizationId: "org-acme",
        orgRoles: ["member"],
      },
      { name: "Job 1" },
    );
    const { reply } = makeReply();

    await run(createMiddleware, request, reply);

    expect(request.body).toEqual({ name: "Job 1", organizationId: "org-acme" });
  });

  it("still skips injection for elevated-without-org (cross-org admin)", async () => {
    const request = makeRequest(
      {
        kind: "elevated",
        userId: "admin-1",
        elevatedBy: "x-arc-scope",
      },
      { name: "Job 1" },
    );
    const { reply, status } = makeReply();

    await run(createMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    // Body unchanged — admin is not bound to a specific tenant on create
    expect(request.body).toEqual({ name: "Job 1" });
  });

  it("still 403s when no org context exists at all", async () => {
    const request = makeRequest({ kind: "authenticated", userId: "user-1" }, { name: "Job 1" });
    const { reply, status } = makeReply();

    await run(createMiddleware, request, reply);

    expect(status.code).toBe(403);
  });
});

// ============================================================================
// Custom tenantField — verify it's threaded through to service scope path too
// ============================================================================

describe("multiTenantPreset filter — custom tenantField with service scope", () => {
  const preset = multiTenantPreset({ tenantField: "tenantId" });
  const listMiddleware = preset.middlewares?.list?.[0] as RouteHandler;

  it("uses the configured field name for service scopes too", async () => {
    const request = makeRequest({
      kind: "service",
      clientId: "api-key-test",
      organizationId: "org-acme",
    });
    const { reply } = makeReply();

    await run(listMiddleware, request, reply);

    // Filter uses 'tenantId', not 'organizationId'
    expect(request._policyFilters).toEqual({ tenantId: "org-acme" });
  });
});

// ============================================================================
// Flexible filter (allowPublic) — service scope still gets isolation
// ============================================================================

describe("multiTenantPreset filter (flexible/allowPublic) — service scope", () => {
  const preset = multiTenantPreset({ allowPublic: ["list"], tenantField: "organizationId" });
  const listMiddleware = preset.middlewares?.list?.[0] as RouteHandler;

  it("applies tenant filter for service scopes even on allowPublic routes", async () => {
    // Critical: API key callers should NEVER see other tenants' data,
    // even on routes that are also public for unauthenticated visitors.
    const request = makeRequest({
      kind: "service",
      clientId: "api-key-fajr",
      organizationId: "org-acme",
    });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toEqual({ organizationId: "org-acme" });
  });

  it("allows public/unauthenticated requests through without filtering", async () => {
    const request = makeRequest({ kind: "public" });
    const { reply, status } = makeReply();

    await run(listMiddleware, request, reply);

    // Public is allowed (no 401), no filter installed
    expect(status.code).toBeUndefined();
    expect(request._policyFilters).toBeUndefined();
  });
});
