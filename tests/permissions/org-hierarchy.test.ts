/**
 * Org Hierarchy (Gap 4) — TDD specification.
 *
 * Defines `ancestorOrgIds` on member/service/elevated scope variants for
 * app-level parent-child org relationships (holding company → subsidiary →
 * branch). Three primitives:
 *
 *   1. `getAncestorOrgIds(scope)` — read accessor (always returns an array)
 *   2. `isOrgInScope(scope, targetOrgId)` — pure predicate (current org OR ancestors)
 *   3. `requireOrgInScope(target | (ctx) => target)` — permission helper
 *
 * Design decisions locked in by these tests:
 *   - Arc takes no position on the parent-child source — apps populate
 *     `ancestorOrgIds` from their own DB during auth.
 *   - Ordering convention: closest ancestor first, root last (purely
 *     informational; the predicate doesn't care about order).
 *   - **No automatic inheritance**. Every route opts into ancestor checks
 *     explicitly via `requireOrgInScope`. `multiTenantPreset` does NOT
 *     auto-include ancestor data — that would be a footgun.
 *   - Elevated scope still bypasses the permission helper (cross-org admin),
 *     but the pure predicate does NOT — it's a data query, not a permission.
 *   - Helper accepts either a static org id OR a function pulling the target
 *     from request params / body / headers (most real routes are dynamic).
 */

import { describe, expect, it } from "vitest";
import { requireOrgInScope } from "../../src/permissions/index.js";
import { getAncestorOrgIds, isOrgInScope, type RequestScope } from "../../src/scope/types.js";
import {
  makeElevatedCtx,
  makeMemberCtx,
  makePublicCtx,
  makeServiceCtx,
} from "../_helpers/scope-factories.js";

// ============================================================================
// getAncestorOrgIds — read accessor
// ============================================================================

describe("getAncestorOrgIds", () => {
  it("returns the ancestors array from a member scope", () => {
    expect(
      getAncestorOrgIds({
        kind: "member",
        userId: "u1",
        userRoles: [],
        organizationId: "org-paris",
        orgRoles: [],
        ancestorOrgIds: ["org-eu", "org-holding"],
      }),
    ).toEqual(["org-eu", "org-holding"]);
  });

  it("returns the ancestors array from a service scope", () => {
    expect(
      getAncestorOrgIds({
        kind: "service",
        clientId: "c1",
        organizationId: "org-paris",
        ancestorOrgIds: ["org-holding"],
      }),
    ).toEqual(["org-holding"]);
  });

  it("returns the ancestors array from an elevated scope", () => {
    expect(
      getAncestorOrgIds({
        kind: "elevated",
        userId: "admin-1",
        elevatedBy: "x-arc-scope",
        ancestorOrgIds: ["org-holding"],
      }),
    ).toEqual(["org-holding"]);
  });

  it("returns an empty array when ancestorOrgIds is not set", () => {
    expect(
      getAncestorOrgIds({
        kind: "member",
        userId: "u1",
        userRoles: [],
        organizationId: "org-paris",
        orgRoles: [],
      }),
    ).toEqual([]);
  });

  it("returns an empty array for scope kinds without org context", () => {
    expect(getAncestorOrgIds({ kind: "public" })).toEqual([]);
    expect(getAncestorOrgIds({ kind: "authenticated", userId: "u1" })).toEqual([]);
  });
});

// ============================================================================
// isOrgInScope — pure predicate (no permission semantics, no elevated bypass)
// ============================================================================

describe("isOrgInScope", () => {
  const scope: RequestScope = {
    kind: "member",
    userId: "u1",
    userRoles: [],
    organizationId: "org-paris",
    orgRoles: [],
    ancestorOrgIds: ["org-eu", "org-holding"],
  };

  it("returns true when target equals the current organizationId", () => {
    expect(isOrgInScope(scope, "org-paris")).toBe(true);
  });

  it("returns true when target appears in ancestorOrgIds (immediate parent)", () => {
    expect(isOrgInScope(scope, "org-eu")).toBe(true);
  });

  it("returns true when target appears in ancestorOrgIds (root)", () => {
    expect(isOrgInScope(scope, "org-holding")).toBe(true);
  });

  it("returns false when target is unrelated to the scope", () => {
    expect(isOrgInScope(scope, "org-amazon")).toBe(false);
  });

  it("returns false when ancestors are absent and target is not the current org", () => {
    expect(
      isOrgInScope(
        {
          kind: "member",
          userId: "u1",
          userRoles: [],
          organizationId: "org-paris",
          orgRoles: [],
        },
        "org-eu",
      ),
    ).toBe(false);
  });

  it("works for service scopes", () => {
    expect(
      isOrgInScope(
        {
          kind: "service",
          clientId: "c1",
          organizationId: "org-paris",
          ancestorOrgIds: ["org-holding"],
        },
        "org-holding",
      ),
    ).toBe(true);
  });

  it("works for elevated scopes (no automatic bypass at the predicate level)", () => {
    // Predicate is a pure data query — no permission semantics. Elevated
    // bypass lives in the permission helper, not here.
    expect(
      isOrgInScope({ kind: "elevated", userId: "admin", elevatedBy: "header" }, "org-anywhere"),
    ).toBe(false);
  });

  it("returns false for scope kinds without org context", () => {
    expect(isOrgInScope({ kind: "public" }, "org-anything")).toBe(false);
    expect(isOrgInScope({ kind: "authenticated", userId: "u1" }, "org-anything")).toBe(false);
  });

  it("returns false when target is undefined", () => {
    expect(isOrgInScope(scope, undefined as unknown as string)).toBe(false);
  });
});

// ============================================================================
// requireOrgInScope — permission helper, static target
// ============================================================================

describe("requireOrgInScope(staticTarget)", () => {
  it("grants when current org matches the static target", () => {
    const check = requireOrgInScope("org-paris");
    expect(check(makeMemberCtx({ organizationId: "org-paris" }))).toBe(true);
  });

  it("grants when an ancestor matches the static target", () => {
    const check = requireOrgInScope("org-holding");
    expect(
      check(
        makeMemberCtx({
          organizationId: "org-paris",
          ancestorOrgIds: ["org-eu", "org-holding"],
        }),
      ),
    ).toBe(true);
  });

  it("denies when target is unrelated", () => {
    const check = requireOrgInScope("org-amazon");
    const result = check(
      makeMemberCtx({
        organizationId: "org-paris",
        ancestorOrgIds: ["org-eu"],
      }),
    );
    expect(result).toMatchObject({ granted: false });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("org-amazon");
  });

  it("denies for public scope", () => {
    const check = requireOrgInScope("org-paris");
    expect(check(makePublicCtx())).toMatchObject({ granted: false });
  });

  it("grants service scopes when target matches current or ancestor", () => {
    const check = requireOrgInScope("org-holding");
    expect(
      check(
        makeServiceCtx({
          organizationId: "org-paris",
          ancestorOrgIds: ["org-holding"],
        }),
      ),
    ).toBe(true);
  });

  it("grants elevated scopes unconditionally (platform admin bypass)", () => {
    // Elevated is the documented cross-org admin bypass — they can act on
    // any org regardless of their scope's ancestors.
    const check = requireOrgInScope("org-completely-unrelated");
    expect(check(makeElevatedCtx({}))).toBe(true);
    expect(check(makeElevatedCtx({ organizationId: "org-different" }))).toBe(true);
  });
});

// ============================================================================
// requireOrgInScope — dynamic target via function
// ============================================================================

describe("requireOrgInScope(extractor)", () => {
  it("reads target from request.params via extractor function", () => {
    // /orgs/:orgId/jobs — caller asking to act on org-eu
    const check = requireOrgInScope(
      (ctx) => (ctx.request as { params?: { orgId?: string } }).params?.orgId,
    );

    // Caller is in org-paris with ancestor org-eu — should pass on /orgs/org-eu
    expect(
      check(
        makeMemberCtx({
          organizationId: "org-paris",
          ancestorOrgIds: ["org-eu", "org-holding"],
          params: { orgId: "org-eu" },
        }),
      ),
    ).toBe(true);
  });

  it("denies when extractor returns an org id outside the scope's chain", () => {
    const check = requireOrgInScope(
      (ctx) => (ctx.request as { params?: { orgId?: string } }).params?.orgId,
    );

    const result = check(
      makeMemberCtx({
        organizationId: "org-paris",
        ancestorOrgIds: ["org-eu"],
        params: { orgId: "org-amazon" },
      }),
    );
    expect(result).toMatchObject({ granted: false });
  });

  it("denies when extractor returns undefined (target unresolvable)", () => {
    const check = requireOrgInScope(
      (ctx) => (ctx.request as { params?: { orgId?: string } }).params?.orgId,
    );

    const result = check(
      makeMemberCtx({
        organizationId: "org-paris",
        // no params override — extractor returns undefined
      }),
    );
    expect(result).toMatchObject({ granted: false });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("target");
  });

  it("reads target from request.body via extractor function", () => {
    // POST /jobs with { organizationId: 'org-eu' } in body
    const check = requireOrgInScope(
      (ctx) => (ctx.request as { body?: { organizationId?: string } }).body?.organizationId,
    );

    expect(
      check(
        makeMemberCtx({
          organizationId: "org-paris",
          ancestorOrgIds: ["org-eu"],
          body: { organizationId: "org-eu" },
        }),
      ),
    ).toBe(true);
  });

  it("grants elevated regardless of what the extractor returns", () => {
    const check = requireOrgInScope(
      (ctx) => (ctx.request as { params?: { orgId?: string } }).params?.orgId,
    );
    expect(check(makeElevatedCtx({}))).toBe(true);
  });
});

// ============================================================================
// Real-world scenario walkthroughs
// ============================================================================

describe("real-world: holding company → subsidiary → branch", () => {
  it("Acme Holding admin can act on any org in their hierarchy via explicit checks", () => {
    // The auth function has loaded the user's full ancestry from the
    // company's own org table — arc just stores and reads it.
    const ctx = makeMemberCtx({
      organizationId: "org-acme-paris",
      ancestorOrgIds: ["org-acme-eu", "org-acme-holding"],
    });

    // All three explicit checks pass
    expect(requireOrgInScope("org-acme-paris")(ctx)).toBe(true);
    expect(requireOrgInScope("org-acme-eu")(ctx)).toBe(true);
    expect(requireOrgInScope("org-acme-holding")(ctx)).toBe(true);

    // A sibling subsidiary is NOT in the chain — must be denied
    expect(requireOrgInScope("org-acme-asia")(ctx)).toMatchObject({
      granted: false,
    });
  });

  it("MSP managing 50 customer tenants — admin can act on customer X via dynamic target", () => {
    // The MSP admin's ancestorOrgIds list contains all 50 tenant ids loaded
    // from the MSP's own management DB during auth.
    const tenantList = Array.from({ length: 50 }, (_, i) => `tenant-${i}`);
    const ctx = makeMemberCtx({
      organizationId: "msp-control",
      ancestorOrgIds: tenantList,
      params: { orgId: "tenant-37" },
    });

    const check = requireOrgInScope(
      (c) => (c.request as { params?: { orgId?: string } }).params?.orgId,
    );
    expect(check(ctx)).toBe(true);

    // A tenant not on the MSP's list is denied
    const ctxOutsider = makeMemberCtx({
      organizationId: "msp-control",
      ancestorOrgIds: tenantList,
      params: { orgId: "tenant-not-managed" },
    });
    expect(check(ctxOutsider)).toMatchObject({ granted: false });
  });
});
