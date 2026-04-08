/**
 * allOf() scope chaining — regression suite for the custom-auth composition bug.
 *
 * Bug (pre-2.7.1): allOf() evaluated each child against the original
 * PermissionContext. A child returning `{ granted: true, scope: ... }` had its
 * scope silently dropped, AND the next child still saw the original
 * (typically public) scope. This broke documented patterns like
 *
 *     allOf(requireApiKey(), requireOrgMembership())
 *
 * because requireOrgMembership() couldn't see the service scope installed by
 * requireApiKey().
 *
 * Fix: allOf() now installs each granted child's scope on `request.scope`
 * before invoking the next child, merges filters in real time, returns the
 * accumulated scope on the final result, AND restores the request state on
 * denial so partial runs don't leak side effects.
 */

import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { allOf, allowPublic } from "../../src/permissions/index.js";
import type { PermissionCheck, PermissionResult } from "../../src/permissions/types.js";
import { isService, type RequestScope } from "../../src/scope/types.js";

// ============================================================================
// Test fixtures
// ============================================================================

/**
 * Build a fake permission context with mutable request.scope so we can verify
 * scope plumbing the same way Arc's middleware does at runtime.
 */
function makeCtx(initial?: { scope?: RequestScope; user?: Record<string, unknown> }) {
  const request = {
    scope: initial?.scope,
    headers: { "x-api-key": "test-key" },
    _policyFilters: undefined as Record<string, unknown> | undefined,
  } as unknown as FastifyRequest & {
    scope?: RequestScope;
    _policyFilters?: Record<string, unknown>;
  };

  return {
    request,
    user: initial?.user ?? null,
    resource: "test",
    action: "list",
  } as unknown as Parameters<PermissionCheck>[0];
}

/** Stand-in for a custom requireApiKey() — installs service scope. */
const requireApiKey =
  (): PermissionCheck =>
  async ({ request }) => {
    const key = (request.headers as Record<string, string | undefined>)["x-api-key"];
    if (key !== "test-key") return { granted: false, reason: "Invalid API key" };
    return {
      granted: true,
      scope: {
        kind: "service",
        clientId: "client-1",
        organizationId: "org-acme",
        scopes: ["read"],
      } as RequestScope,
    };
  };

/** Stand-in for a custom requireUser() — installs member scope + user. */
const requireUserAuth =
  (): PermissionCheck =>
  async ({ request }) => {
    return {
      granted: true,
      scope: {
        kind: "member",
        userId: "user-1",
        organizationId: "org-acme",
        orgRoles: ["admin"],
      } as RequestScope,
      filters: { tenantTag: "alpha" },
    } as PermissionResult;
  };

// ============================================================================
// Tests
// ============================================================================

describe("allOf() — scope chaining between children (regression for 2.7.1)", () => {
  it("requireApiKey + downstream check: second child sees scope from first", async () => {
    // Pre-fix bug: a downstream check that read `request.scope` saw `undefined`
    // (or `public`) because requireApiKey()'s service scope was silently dropped
    // by allOf() before the next child ran.
    //
    // We use a small inline check that asserts the scope is service-kind with
    // the expected org id. Pre-fix this returned { granted: false }; post-fix
    // it sees the installed service scope and grants.
    const requireServiceScopeForOrg =
      (orgId: string): PermissionCheck =>
      async ({ request }) => {
        const scope = (request as { scope?: RequestScope }).scope;
        if (!scope || !isService(scope)) {
          return { granted: false, reason: "Service scope required" };
        }
        if (scope.organizationId !== orgId) {
          return { granted: false, reason: "Wrong org" };
        }
        return { granted: true };
      };

    const check = allOf(requireApiKey(), requireServiceScopeForOrg("org-acme"));
    const ctx = makeCtx();

    const result = await check(ctx);
    expect(result).toMatchObject({ granted: true });
  });

  it("returns the merged scope on the final result so outer middleware sees it", async () => {
    const check = allOf(requireApiKey());
    const ctx = makeCtx();

    const result = (await check(ctx)) as PermissionResult;

    expect(result.granted).toBe(true);
    expect(result.scope).toMatchObject({
      kind: "service",
      clientId: "client-1",
      organizationId: "org-acme",
    });
  });

  it("merges filters from sequential children into the final result", async () => {
    const ownsTag: PermissionCheck = async () => ({
      granted: true,
      filters: { tag: "alpha" },
    });
    const ownsRegion: PermissionCheck = async () => ({
      granted: true,
      filters: { region: "us-east" },
    });

    const check = allOf(ownsTag, ownsRegion);
    const result = (await check(makeCtx())) as PermissionResult;

    expect(result.granted).toBe(true);
    expect(result.filters).toEqual({ tag: "alpha", region: "us-east" });
  });

  it("applies filters between children so later children see accumulated _policyFilters", async () => {
    let observed: Record<string, unknown> | undefined;

    const first: PermissionCheck = async () => ({
      granted: true,
      filters: { region: "us-east" },
    });
    const second: PermissionCheck = async ({ request }) => {
      observed = (request as { _policyFilters?: Record<string, unknown> })._policyFilters;
      return { granted: true };
    };

    const check = allOf(first, second);
    await check(makeCtx());

    expect(observed).toEqual({ region: "us-east" });
  });

  it("does NOT downgrade an already-installed authoritative scope (member > service)", async () => {
    // The request already has a member scope (e.g. set by Better Auth).
    // The first allOf() child returns a service scope. allOf() must NOT
    // overwrite the member scope with the service scope (mirrors
    // applyPermissionResult's "no downgrade" rule).
    const ctx = makeCtx({
      scope: {
        kind: "member",
        userId: "u1",
        organizationId: "org-acme",
        orgRoles: ["admin"],
      } as RequestScope,
    });

    const check = allOf(requireApiKey());
    await check(ctx);

    // Original member scope is preserved on the request
    expect((ctx.request as { scope?: RequestScope }).scope?.kind).toBe("member");
  });

  it("on denial: restores request state — no leaked filters or scope from earlier children", async () => {
    const granting: PermissionCheck = async () => ({
      granted: true,
      filters: { region: "us-east" },
      scope: {
        kind: "service",
        clientId: "c1",
        organizationId: "org-x",
        scopes: [],
      } as RequestScope,
    });
    const denying: PermissionCheck = async () => ({
      granted: false,
      reason: "Nope",
    });

    const ctx = makeCtx();
    const check = allOf(granting, denying);
    const result = await check(ctx);

    expect(result).toMatchObject({ granted: false, reason: "Nope" });

    // Crucial: even though `granting` ran successfully, the request must be
    // back to its original state — no leaked filters or scope.
    const sink = ctx.request as { _policyFilters?: unknown; scope?: unknown };
    expect(sink._policyFilters).toBeUndefined();
    expect(sink.scope).toBeUndefined();
  });

  it("on thrown error in a child: restores request state", async () => {
    const granting: PermissionCheck = async () => ({
      granted: true,
      filters: { tag: "alpha" },
      scope: {
        kind: "service",
        clientId: "c1",
        organizationId: "org-x",
        scopes: [],
      } as RequestScope,
    });
    const throwing: PermissionCheck = async () => {
      throw new Error("boom");
    };

    const ctx = makeCtx();
    const check = allOf(granting, throwing);

    await expect(check(ctx)).rejects.toThrow("boom");

    const sink = ctx.request as { _policyFilters?: unknown; scope?: unknown };
    expect(sink._policyFilters).toBeUndefined();
    expect(sink.scope).toBeUndefined();
  });

  it("preserves the public-scope short-circuit (allowPublic + something) still works", async () => {
    const check = allOf(allowPublic(), allowPublic());
    const result = await check(makeCtx());
    expect(result).toMatchObject({ granted: true });
  });

  it("two service-scope children: first wins (no downgrade between siblings)", async () => {
    const auth1: PermissionCheck = async () => ({
      granted: true,
      scope: {
        kind: "service",
        clientId: "c1",
        organizationId: "org-1",
        scopes: ["read"],
      } as RequestScope,
    });
    const auth2: PermissionCheck = async () => ({
      granted: true,
      scope: {
        kind: "service",
        clientId: "c2",
        organizationId: "org-2",
        scopes: ["write"],
      } as RequestScope,
    });

    const ctx = makeCtx();
    await allOf(auth1, auth2)(ctx);

    // First scope wins because installed scope (kind=service) is not "public",
    // so the second child's scope is NOT installed onto the request.
    const installed = (ctx.request as { scope?: RequestScope }).scope;
    expect(installed?.kind).toBe("service");
    if (installed?.kind === "service") {
      expect(installed.clientId).toBe("c1");
    }
  });
});
