/**
 * Service Scope (API Key) Permission Tests — 2.7.0 gap fixes
 *
 * Covers the three helpers that were changed in 2.7.0 to recognize the
 * `service` scope kind, plus the new `requireServiceScope` helper:
 *
 *   - `requireOrgMembership()` — now grants service scopes (Gap 1a)
 *   - `requireOrgRole()` — now explicitly denies service scopes with a
 *     guidance reason pointing at requireServiceScope (Gap 1b)
 *   - `requireServiceScope(...)` — new helper for OAuth-style scope checks
 *     on service identities (Gap 3)
 *   - `multiTenantPreset` — exercised in tests/presets/multi-tenant-service-scope.test.ts
 *
 * Why this matters: pre-2.7.0, the `service` scope variant existed in the
 * RequestScope union but no built-in helper recognized it for org isolation.
 * The documented `allOf(requireApiKey(), requireOrgMembership())` pattern
 * silently denied API key calls. These tests lock in the fix.
 */

import { describe, expect, it } from "vitest";
import {
  anyOf,
  type PermissionContext,
  requireOrgMembership,
  requireOrgRole,
  requireServiceScope,
} from "../../src/permissions/index.js";
import {
  makeAuthenticatedCtx,
  makeElevatedCtx,
  makeMemberCtx,
  makePublicCtx,
  makeServiceCtx,
} from "../_helpers/scope-factories.js";

// ============================================================================
// Gap 1a — requireOrgMembership accepts service scopes
// ============================================================================

describe("requireOrgMembership() — service scope (Gap 1a)", () => {
  const check = requireOrgMembership();

  it("grants a service scope bound to an organization", () => {
    // Pre-2.7.0 this returned { granted: false, reason: "Organization membership required" }
    // because the helper checked `isMember || isElevated` and ignored isService.
    const result = check(makeServiceCtx({ organizationId: "org-acme" }));
    expect(result).toBe(true);
  });

  it("grants a service scope even without ctx.user (services have no user)", () => {
    const ctx = makeServiceCtx({ organizationId: "org-acme" });
    expect(ctx.user).toBeNull();
    expect(check(ctx)).toBe(true);
  });

  it("still grants member scopes (no regression)", () => {
    const result = check(makeMemberCtx({ organizationId: "org-acme" }));
    expect(result).toBe(true);
  });

  it("still grants elevated-without-org (no regression for cross-org admins)", () => {
    expect(check(makeElevatedCtx())).toBe(true);
  });

  it("still denies unauthenticated requests", () => {
    expect(check(makePublicCtx())).toEqual({
      granted: false,
      reason: "Authentication required",
    });
  });

  it("still denies authenticated-without-org users", () => {
    expect(check(makeAuthenticatedCtx({ userId: "u1" }))).toEqual({
      granted: false,
      reason: "Organization membership required",
    });
  });
});

// ============================================================================
// Gap 1b — requireOrgRole explicitly denies service scopes
// ============================================================================

describe("requireOrgRole() — service scope policy (Gap 1b)", () => {
  const check = requireOrgRole("admin");

  it("denies a service scope with a clear guidance reason", () => {
    // The reason must point at requireServiceScope so users know how to fix it.
    const result = check(makeServiceCtx({ organizationId: "org-acme" }));
    expect(result).toMatchObject({ granted: false });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("Service scopes");
    expect(reason).toContain("requireServiceScope");
    expect(reason).toContain("anyOf");
  });

  it("denies a service scope even when org matches and 'admin' is a service scope string", () => {
    // Critical: don't accidentally grant just because the scopes array
    // happens to contain a string that matches a role name.
    const result = check(
      makeServiceCtx({
        organizationId: "org-acme",
        scopes: ["admin"], // intentionally confusing
      }),
    );
    expect(result).toMatchObject({ granted: false });
  });

  it("still grants elevated bypass", () => {
    expect(check(makeElevatedCtx({ organizationId: "org-acme" }))).toBe(true);
  });

  it("still grants matching member roles (no regression)", () => {
    const result = check(makeMemberCtx({ orgRoles: ["admin"] }));
    expect(result).toBe(true);
  });

  it("still denies non-matching member roles (no regression)", () => {
    const result = check(makeMemberCtx({ orgRoles: ["viewer"] }));
    expect(result).toMatchObject({ granted: false });
  });
});

// ============================================================================
// Gap 1b composition — anyOf(requireOrgRole, requireServiceScope) for mixed routes
// ============================================================================

describe("anyOf(requireOrgRole, requireServiceScope) — documented mixed-route pattern", () => {
  const check = anyOf(requireOrgRole("admin"), requireServiceScope("jobs:write"));

  // Helper: anyOf is async, and the granted form may be either `true` (when
  // a child returns boolean true) or `{ granted: true, ... }` (when a child
  // returns a PermissionResult). Normalize both into a boolean for assertions.
  const isGranted = async (ctx: PermissionContext): Promise<boolean> => {
    const result = await check(ctx);
    if (result === true) return true;
    if (typeof result === "object" && result !== null) {
      return (result as { granted?: boolean }).granted === true;
    }
    return false;
  };

  it("grants a human admin", async () => {
    expect(await isGranted(makeMemberCtx({ orgRoles: ["admin"] }))).toBe(true);
  });

  it("grants a service scope with the right OAuth scope", async () => {
    expect(await isGranted(makeServiceCtx({ scopes: ["jobs:write"] }))).toBe(true);
  });

  it("denies a service scope without the right OAuth scope", async () => {
    const result = await check(makeServiceCtx({ scopes: ["jobs:read"] }));
    expect(result).toMatchObject({ granted: false });
  });

  it("denies a member without the required role and no service scope", async () => {
    const result = await check(makeMemberCtx({ orgRoles: ["viewer"] }));
    expect(result).toMatchObject({ granted: false });
  });
});

// ============================================================================
// Gap 3 — requireServiceScope helper
// ============================================================================

describe("requireServiceScope() — new helper (Gap 3)", () => {
  it("grants when service scope contains the required scope (variadic single)", () => {
    const check = requireServiceScope("jobs:write");
    expect(check(makeServiceCtx({ scopes: ["jobs:write"] }))).toBe(true);
  });

  it("grants when service scope contains ANY of the required scopes (variadic multiple)", () => {
    const check = requireServiceScope("jobs:read", "jobs:write");
    expect(check(makeServiceCtx({ scopes: ["jobs:read"] }))).toBe(true);
    expect(check(makeServiceCtx({ scopes: ["jobs:write"] }))).toBe(true);
    expect(check(makeServiceCtx({ scopes: ["jobs:read", "jobs:write"] }))).toBe(true);
  });

  it("grants with the array form too", () => {
    const check = requireServiceScope(["jobs:read", "jobs:write"]);
    expect(check(makeServiceCtx({ scopes: ["jobs:write"] }))).toBe(true);
  });

  it("denies when service scope is missing the required scope", () => {
    const check = requireServiceScope("jobs:write");
    const result = check(makeServiceCtx({ scopes: ["jobs:read"] }));
    expect(result).toMatchObject({ granted: false });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("jobs:write");
    expect(reason).toContain("jobs:read"); // shows what was actually granted
  });

  it("denies when service scope has no scopes at all", () => {
    const check = requireServiceScope("jobs:write");
    const result = check(makeServiceCtx({ scopes: undefined }));
    expect(result).toMatchObject({ granted: false });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("none");
  });

  it("denies when scope is member (humans use requireOrgRole, not requireServiceScope)", () => {
    const check = requireServiceScope("jobs:write");
    const result = check(makeMemberCtx({ orgRoles: ["admin"] }));
    expect(result).toMatchObject({ granted: false });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("Service identity required");
    expect(reason).toContain("requireOrgRole");
  });

  it("denies when scope is authenticated (no service identity)", () => {
    const check = requireServiceScope("jobs:write");
    expect(check(makeAuthenticatedCtx({ userId: "u1" }))).toMatchObject({ granted: false });
  });

  it("denies when scope is public", () => {
    const check = requireServiceScope("jobs:write");
    expect(check(makePublicCtx())).toMatchObject({ granted: false });
  });

  it("grants elevated scope as a bypass (platform admin acts regardless)", () => {
    const check = requireServiceScope("jobs:write");
    expect(check(makeElevatedCtx({ organizationId: "org-acme" }))).toBe(true);
  });

  it("throws at construction if no scopes are provided (developer error)", () => {
    expect(() => requireServiceScope()).toThrow(/at least one scope string/);
    expect(() => requireServiceScope([])).toThrow(/at least one scope string/);
  });
});

// ============================================================================
// Gap 1 + Gap 3 integration — the fajr-style "API key with org isolation" path
// ============================================================================

describe("integration — API key with org isolation (the original motivating case)", () => {
  it("a service scope that has an org AND the right service scope passes both checks", () => {
    // This is the canonical pattern arc was designed for but couldn't express:
    //   1. requireOrgMembership() — gates "this caller has org context"
    //   2. requireServiceScope('jobs:read') — gates "this caller has the right OAuth scope"
    const membershipCheck = requireOrgMembership();
    const scopeCheck = requireServiceScope("jobs:read");

    const ctx = makeServiceCtx({
      clientId: "api-key-fajr",
      organizationId: "org-acme",
      scopes: ["jobs:read", "jobs:write"],
    });

    expect(membershipCheck(ctx)).toBe(true);
    expect(scopeCheck(ctx)).toBe(true);
  });

  it("a service scope without the right OAuth scope still passes membership but fails scope check", () => {
    const membershipCheck = requireOrgMembership();
    const scopeCheck = requireServiceScope("jobs:write");

    const ctx = makeServiceCtx({
      clientId: "api-key-readonly",
      organizationId: "org-acme",
      scopes: ["jobs:read"], // read-only API key
    });

    expect(membershipCheck(ctx)).toBe(true);
    expect(scopeCheck(ctx)).toMatchObject({ granted: false });
  });
});
