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
