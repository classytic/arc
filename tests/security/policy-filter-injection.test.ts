/**
 * Security Tests: Policy Filter Injection Prevention
 *
 * Validates that user-supplied _policyFilters in query strings are NOT trusted.
 * Only middleware-set _policyFilters (via req._policyFilters) should be used.
 *
 * Regression test for: fastifyAdapter.ts previously merged query._policyFilters
 * into metadata._policyFilters, allowing attackers to inject tenant/owner filters.
 */

import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../../src/core/fastifyAdapter.js";

/**
 * Create a mock Fastify request with configurable query, _policyFilters, and context
 */
function mockRequest(overrides: {
  query?: Record<string, unknown>;
  _policyFilters?: Record<string, unknown>;
  context?: Record<string, unknown>;
  user?: Record<string, unknown>;
}): FastifyRequest {
  return {
    query: overrides.query ?? {},
    body: {},
    params: {},
    headers: {},
    user: overrides.user ?? null,
    context: overrides.context ?? {},
    _policyFilters: overrides._policyFilters,
    log: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
  } as unknown as FastifyRequest;
}

describe("Security: Policy Filter Injection Prevention", () => {
  it("should NOT include user-supplied _policyFilters from query string", () => {
    const req = mockRequest({
      query: {
        _policyFilters: { tenantId: "attacker-tenant" },
        name: "legit-query",
      },
    });

    const ctx = createRequestContext(req);

    // Attacker's _policyFilters must NOT appear in metadata
    expect(ctx.metadata?._policyFilters).toEqual({});
    // Normal query params should still pass through
    expect(ctx.query.name).toBe("legit-query");
  });

  it("should include middleware-set _policyFilters from req._policyFilters", () => {
    const req = mockRequest({
      _policyFilters: { tenantId: "trusted-tenant" },
    });

    const ctx = createRequestContext(req);

    expect(ctx.metadata?._policyFilters).toEqual({ tenantId: "trusted-tenant" });
  });

  it("should NOT allow query _policyFilters to override middleware _policyFilters", () => {
    const req = mockRequest({
      query: {
        _policyFilters: { tenantId: "attacker-tenant", ownerId: "attacker-user" },
      },
      _policyFilters: { tenantId: "real-tenant" },
    });

    const ctx = createRequestContext(req);

    // Only trusted middleware filters should be present
    expect(ctx.metadata?._policyFilters).toEqual({ tenantId: "real-tenant" });
    // Attacker's ownerId must NOT leak through
    expect((ctx.metadata?._policyFilters as Record<string, unknown>)?.ownerId).toBeUndefined();
  });

  it("should handle missing _policyFilters gracefully", () => {
    const req = mockRequest({});

    const ctx = createRequestContext(req);

    expect(ctx.metadata?._policyFilters).toEqual({});
  });

  it("should handle nested _policyFilters injection attempt in query", () => {
    const req = mockRequest({
      query: {
        "_policyFilters[organizationId]": "injected-org",
        "_policyFilters[$or]": [{ tenantId: "a" }],
      },
    });

    const ctx = createRequestContext(req);

    // None of the injected fields should appear
    expect(ctx.metadata?._policyFilters).toEqual({});
  });
});
