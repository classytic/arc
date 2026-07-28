/**
 * allOf() scope chaining — regression suite for the custom-auth composition bug.
 *
 * Bug (pre-2.7.1): allOf() evaluated each child against the original
 * PermissionContext. A child returning `{ effect: "allow", scope: ... }` had its
 * scope silently dropped, AND the next child still saw the original
 * (typically public) scope. This broke documented patterns like
 *
 *     allOf(requireApiKey(), requireOrgMembership())
 *
 * because requireOrgMembership() couldn't see the service scope installed by
 * requireApiKey().
 *
 * Fix (arc 2.31, PURE evaluation): allOf() threads each granted child's scope to
 * the NEXT child through a fresh child context (`scopeOf(ctx)`), never mutating
 * the request. It returns the accumulated scope + conjoined policy on the final
 * decision; the enforcement point applies it once. No request mutation → no
 * rollback needed, and `not(allOf(...))` / parallel evaluation are sound.
 */

import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { allOf, allowPublic, scopeOf } from "../../src/permissions/index.js";
import type { AuthorizationDecision, PermissionCheck } from "../../src/permissions/types.js";
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
    if (key !== "test-key") return { effect: "deny", reason: "Invalid API key" };
    return {
      effect: "allow",
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
      effect: "allow",
      scope: {
        kind: "member",
        userId: "user-1",
        organizationId: "org-acme",
        orgRoles: ["admin"],
      } as RequestScope,
      policy: { tenantTag: "alpha" },
    } as AuthorizationDecision;
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
    // the expected org id. Pre-fix this returned { effect: "deny" }; post-fix
    // it sees the installed service scope and grants.
    const requireServiceScopeForOrg =
      (orgId: string): PermissionCheck =>
      async (ctx) => {
        // Reads the threaded scope from the CONTEXT (pure) — not the request.
        const scope = scopeOf(ctx);
        if (!scope || !isService(scope)) {
          return { effect: "deny", reason: "Service scope required" };
        }
        if (scope.organizationId !== orgId) {
          return { effect: "deny", reason: "Wrong org" };
        }
        return { effect: "allow" };
      };

    const check = allOf(requireApiKey(), requireServiceScopeForOrg("org-acme"));
    const ctx = makeCtx();

    const result = await check(ctx);
    expect(result).toMatchObject({ effect: "allow" });
  });

  it("returns the merged scope on the final result so outer middleware sees it", async () => {
    const check = allOf(requireApiKey());
    const ctx = makeCtx();

    const result = (await check(ctx)) as AuthorizationDecision;

    expect(result.effect).toBe("allow");
    expect(result.scope).toMatchObject({
      kind: "service",
      clientId: "client-1",
      organizationId: "org-acme",
    });
  });

  it("merges filters from sequential children into the final result", async () => {
    const ownsTag: PermissionCheck = async () => ({
      effect: "allow",
      policy: { tag: "alpha" },
    });
    const ownsRegion: PermissionCheck = async () => ({
      effect: "allow",
      policy: { region: "us-east" },
    });

    const check = allOf(ownsTag, ownsRegion);
    const result = (await check(makeCtx())) as AuthorizationDecision;

    expect(result.effect).toBe("allow");
    expect(result.policy).toEqual({ tag: "alpha", region: "us-east" });
  });

  it("CONJOINS conflicting same-key filters across children (AND, never last-writer-wins)", async () => {
    // Two branches restrict the SAME key differently. allOf is logical AND, so
    // BOTH restrictions must survive — a bare overwrite would let the second
    // branch silently widen past the first. Regression guard for the row-level
    // security composition fix.
    const branchA: PermissionCheck = async () => ({
      effect: "allow",
      policy: { organizationId: "org-a" },
    });
    const branchB: PermissionCheck = async () => ({
      effect: "allow",
      policy: { organizationId: "org-b" },
    });

    const check = allOf(branchA, branchB);
    const result = (await check(makeCtx())) as AuthorizationDecision;

    expect(result.effect).toBe("allow");
    expect(result.policy).toEqual({
      $and: [{ organizationId: "org-a" }, { organizationId: "org-b" }],
    });
  });

  it("threads an earlier child's SCOPE to a later child via context (identity chaining)", async () => {
    // Pure model: identity (scope) threads to later siblings through the context;
    // row policy is a RESULT concern (composed on the decision), NOT leaked to a
    // sibling's request. This asserts the identity-chaining contract that real
    // custom-auth patterns (`allOf(requireApiKey(), requireServiceScope(...))`)
    // depend on — the second child observes the first child's installed scope.
    let observedKind: string | undefined;

    const first: PermissionCheck = async () => ({
      effect: "allow",
      scope: { kind: "service", clientId: "c1", organizationId: "o1", scopes: [] } as RequestScope,
    });
    const second: PermissionCheck = async (ctx) => {
      observedKind = scopeOf(ctx).kind;
      return { effect: "allow" };
    };

    await allOf(first, second)(makeCtx());
    expect(observedKind).toBe("service");
  });

  it("does NOT downgrade an already-installed authoritative scope (member > service)", async () => {
    // The request already has a member scope (e.g. set by Better Auth).
    // The first allOf() child returns a service scope. allOf() must NOT
    // overwrite the member scope with the service scope (mirrors
    // applyAuthorizationDecision's "no downgrade" rule).
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
      effect: "allow",
      policy: { region: "us-east" },
      scope: {
        kind: "service",
        clientId: "c1",
        organizationId: "org-x",
        scopes: [],
      } as RequestScope,
    });
    const denying: PermissionCheck = async () => ({
      effect: "deny",
      reason: "Nope",
    });

    const ctx = makeCtx();
    const check = allOf(granting, denying);
    const result = await check(ctx);

    expect(result).toMatchObject({ effect: "deny", reason: "Nope" });

    // Crucial: even though `granting` ran successfully, the request must be
    // back to its original state — no leaked filters or scope.
    const sink = ctx.request as { _policyFilters?: unknown; scope?: unknown };
    expect(sink._policyFilters).toBeUndefined();
    expect(sink.scope).toBeUndefined();
  });

  it("on thrown error in a child: restores request state", async () => {
    const granting: PermissionCheck = async () => ({
      effect: "allow",
      policy: { tag: "alpha" },
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
    expect(result).toMatchObject({ effect: "allow" });
  });

  it("two service-scope children: first wins (no downgrade between siblings)", async () => {
    const auth1: PermissionCheck = async () => ({
      effect: "allow",
      scope: {
        kind: "service",
        clientId: "c1",
        organizationId: "org-1",
        scopes: ["read"],
      } as RequestScope,
    });
    const auth2: PermissionCheck = async () => ({
      effect: "allow",
      scope: {
        kind: "service",
        clientId: "c2",
        organizationId: "org-2",
        scopes: ["write"],
      } as RequestScope,
    });

    const result = (await allOf(auth1, auth2)(makeCtx())) as AuthorizationDecision;

    // First scope wins (non-downgrade): once a non-public scope is installed, a
    // later sibling's scope does not override it. The composed decision carries
    // the FIRST child's scope.
    const installed = result.scope;
    expect(installed?.kind).toBe("service");
    if (installed?.kind === "service") {
      expect(installed.clientId).toBe("c1");
    }
  });
});
