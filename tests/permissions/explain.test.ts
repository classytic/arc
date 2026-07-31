/**
 * Static authorization analysis (arc 2.31) — describePermission / explainAccess /
 * describePermissionMap / collectPublicSurface. Answers "who can do X, and why"
 * from PermissionCheckMeta WITHOUT running a request.
 */

import { describe, expect, it } from "vitest";
import {
  allOf,
  allowPublic,
  anyOf,
  collectPublicSurface,
  describePermission,
  describePermissionMap,
  explainAccess,
  requireAuth,
  requireOrgRole,
  requireOwnership,
  requireRoles,
  requireScopeContext,
} from "../../src/permissions/index.js";

describe("describePermission", () => {
  it("reports public / roles / authenticated from meta", () => {
    expect(describePermission(allowPublic())).toEqual({ kind: "public" });
    expect(describePermission(requireRoles("admin", "editor"))).toEqual({
      kind: "roles",
      roles: ["admin", "editor"],
    });
    expect(describePermission(requireAuth())).toEqual({ kind: "authenticated" });
    // ownership reads request-time facts → not statically decidable
    expect(describePermission(requireOwnership("ownerId"))).toEqual({ kind: "authenticated" });
  });

  it("unions roles across combinators (anyOf) and reads through allOf", () => {
    // anyOf(a|b) → union of both branches' roles.
    expect(describePermission(anyOf(requireRoles("admin"), requireOrgRole("owner")))).toEqual({
      kind: "roles",
      roles: ["admin", "owner"],
    });
    // allOf(auth, roles) → the single role branch's roles.
    expect(describePermission(allOf(requireAuth(), requireRoles("admin")))).toEqual({
      kind: "roles",
      roles: ["admin"],
    });
  });
});

describe("explainAccess", () => {
  it("public → allow for anyone", () => {
    expect(explainAccess(allowPublic()).decision).toBe("allow");
  });

  it("roles → allow/deny against a principal, conditional without one", () => {
    const check = requireRoles("admin", "editor");
    expect(explainAccess(check, { roles: ["editor"] }).decision).toBe("allow");
    expect(explainAccess(check, { roles: ["viewer"] }).decision).toBe("deny");
    expect(explainAccess(check).decision).toBe("conditional");
  });

  it("matches org roles too, and reports the granting role", () => {
    const r = explainAccess(requireOrgRole("owner"), { orgRoles: ["owner"] });
    expect(r.decision).toBe("allow");
    expect(r.reason).toContain("owner");
  });

  it("authenticated/custom → conditional (server decides), never a false deny", () => {
    expect(explainAccess(requireAuth(), { roles: ["admin"] }).decision).toBe("conditional");
    expect(explainAccess(requireOwnership("ownerId"), { roles: ["admin"] }).decision).toBe(
      "conditional",
    );
  });
});

describe("scoped requirement (scope-context gate, arc 2.31)", () => {
  const hqOnly = requireScopeContext("branchRole", "head_office");
  const hqAdmin = allOf(requireRoles("admin"), requireScopeContext("branchRole", "head_office"));

  it("describePermission surfaces the scope dimensions", () => {
    expect(describePermission(hqOnly)).toEqual({
      kind: "scoped",
      scope: { branchRole: "head_office" },
    });
  });

  it("carries the co-required roles when composed with a role gate", () => {
    expect(describePermission(hqAdmin)).toEqual({
      kind: "scoped",
      scope: { branchRole: "head_office" },
      roles: ["admin"],
    });
  });

  it("explainAccess: conditional without the caller's scope, allow/deny with it", () => {
    expect(explainAccess(hqOnly).decision).toBe("conditional");
    expect(explainAccess(hqOnly, { scope: { branchRole: "head_office" } }).decision).toBe("allow");
    expect(explainAccess(hqOnly, { scope: { branchRole: "sub_branch" } }).decision).toBe("deny");
  });

  it("explainAccess: a missing co-required role is a definitive deny even before scope", () => {
    expect(explainAccess(hqAdmin, { roles: ["viewer"] }).decision).toBe("deny");
    expect(
      explainAccess(hqAdmin, { roles: ["admin"], scope: { branchRole: "head_office" } }).decision,
    ).toBe("allow");
    expect(
      explainAccess(hqAdmin, { roles: ["admin"], scope: { branchRole: "sub_branch" } }).decision,
    ).toBe("deny");
  });
});

describe("soundness — composed gates are conditional, never a false allow", () => {
  it("allOf(role, ownership): role is NECESSARY not sufficient — match → conditional, miss → deny", () => {
    const gate = allOf(requireRoles("admin"), requireOwnership("ownerId"));
    // The opaque ownership branch taints the composite.
    expect(describePermission(gate)).toEqual({
      kind: "roles",
      roles: ["admin"],
      conditional: true,
    });
    // Holding admin is NOT a definitive allow — ownership still decides per request.
    expect(explainAccess(gate, { roles: ["admin"] }).decision).toBe("conditional");
    // Lacking admin IS a definitive deny — the conjunction can't pass without it.
    expect(explainAccess(gate, { roles: ["viewer"] }).decision).toBe("deny");
  });

  it("allOf(auth, role): requireAuth is a pure identity gate — does NOT taint, stays definitive", () => {
    const gate = allOf(requireAuth(), requireRoles("admin"));
    expect(describePermission(gate)).toEqual({ kind: "roles", roles: ["admin"] });
    expect(explainAccess(gate, { roles: ["admin"] }).decision).toBe("allow");
  });

  it("allOf(scopeHQ, ownership): scope match is conditional while an opaque branch remains", () => {
    const gate = allOf(
      requireScopeContext("branchRole", "head_office"),
      requireOwnership("ownerId"),
    );
    const req = describePermission(gate);
    expect(req.kind).toBe("scoped");
    expect((req as { conditional?: boolean }).conditional).toBe(true);
    expect(explainAccess(gate, { scope: { branchRole: "head_office" } }).decision).toBe(
      "conditional",
    );
    expect(explainAccess(gate, { scope: { branchRole: "sub_branch" } }).decision).toBe("deny");
  });

  it("NESTED: allOf(conditional-inner, auth) propagates the inner's conditionality", () => {
    const inner = allOf(requireRoles("admin"), requireOwnership("ownerId"));
    const gate = allOf(inner, requireAuth());
    expect((describePermission(gate) as { conditional?: boolean }).conditional).toBe(true);
    // An admin must NOT get a static allow — the nested ownership still decides.
    expect(explainAccess(gate, { roles: ["admin"] }).decision).toBe("conditional");
    expect(explainAccess(gate, { roles: ["viewer"] }).decision).toBe("deny");
  });

  it("NESTED: anyOf of conditional branches is conditional, not a false allow", () => {
    const gate = anyOf(
      allOf(requireRoles("admin"), requireOwnership("ownerId")),
      allOf(requireRoles("editor"), requireOwnership("ownerId")),
    );
    expect((describePermission(gate) as { conditional?: boolean }).conditional).toBe(true);
    // Holding a unioned role is necessary but not sufficient — ownership decides.
    expect(explainAccess(gate, { roles: ["admin"] }).decision).toBe("conditional");
    expect(explainAccess(gate, { roles: ["nobody"] }).decision).toBe("deny");
  });

  it("contradictory scope conjunction never reports a definitive allow", () => {
    const impossible = allOf(
      requireScopeContext("branchRole", "head_office"),
      requireScopeContext("branchRole", "sub_branch"),
    );
    expect((describePermission(impossible) as { conditional?: boolean }).conditional).toBe(true);
    // A caller matching the first value must NOT get a static allow — the second,
    // contradictory constraint means runtime always denies.
    expect(explainAccess(impossible, { scope: { branchRole: "head_office" } }).decision).not.toBe(
      "allow",
    );
  });
});

describe("describePermissionMap + collectPublicSurface", () => {
  const perms = {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles("admin"),
    update: requireAuth(),
    delete: undefined, // public-by-omission
  };

  it("introspects an action→requirement map", () => {
    expect(describePermissionMap(perms)).toEqual({
      list: { kind: "public" },
      get: { kind: "public" },
      create: { kind: "roles", roles: ["admin"] },
      update: { kind: "authenticated" },
      delete: { kind: "public" }, // no gate = public-by-omission, surfaced honestly
    });
  });

  it("collectPublicSurface lists the no-auth actions (incl. public-by-omission)", () => {
    expect(collectPublicSurface(perms).sort()).toEqual(["delete", "get", "list"]);
  });
});
