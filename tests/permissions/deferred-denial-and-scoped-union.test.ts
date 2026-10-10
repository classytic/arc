/**
 * Introspection must tell the truth about two gates hosts compose every day: a union of
 * head-office gates (`anyOf` of scoped branches) and a deployment-tier gate decided at boot
 * (`_deniedWhen`), including through `allOf` / `anyOf`.
 */
import { describe, expect, it } from "vitest";
import {
  allOf,
  anyOf,
  describePermission,
  explainAccess,
  requireOrgRole,
  requireRoles,
  requireScopeContext,
} from "../../src/permissions/index.js";
import type { PermissionCheck } from "../../src/permissions/types.js";

const hq = (...roles: string[]): PermissionCheck =>
  allOf(requireRoles(...roles), requireScopeContext("branchRole", "head_office"));

function tierGate(state: { met: boolean }): PermissionCheck {
  const check: PermissionCheck = () => state.met;
  check._deniedWhen = () => !state.met;
  return check;
}

describe("anyOf keeps a scope every branch demands", () => {
  it("anyOf(hq admin, hq auditor) is scoped to head office with the union of roles", () => {
    const req = describePermission(anyOf(hq("admin"), hq("auditor")));
    expect(req.kind).toBe("scoped");
    expect(req.kind === "scoped" ? req.scope : {}).toEqual({ branchRole: "head_office" });
    expect(req.kind === "scoped" ? [...(req.roles ?? [])].sort() : []).toEqual(["admin", "auditor"]);
    const atBranch = explainAccess(anyOf(hq("admin"), hq("auditor")), {
      roles: ["auditor"],
      scope: { branchRole: "branch" },
    });
    expect(atBranch.decision).toBe("deny");
  });

  it("a union of a scoped and an unscoped branch is conditional, never a definitive allow", () => {
    const check = anyOf(hq("admin"), requireOrgRole("auditor"));
    const req = describePermission(check);
    expect(req.kind).toBe("roles");
    expect(req.kind === "roles" ? req.conditional : undefined).toBe(true);
    expect(explainAccess(check, { roles: ["admin"] }).decision).toBe("conditional");
  });
});

describe("_deniedWhen — a deployment-static closed door, evaluated lazily", () => {
  it("describes as denied only while the condition holds, read at describe time", () => {
    const state = { met: true };
    const gate = allOf(tierGate(state), requireRoles("manager"));
    expect(describePermission(gate)).toEqual({ kind: "roles", roles: ["manager"] });
    state.met = false;
    expect(describePermission(gate)).toEqual({ kind: "denied" });
    expect(explainAccess(gate, { roles: ["manager"] }).decision).toBe("deny");
  });

  it("does not taint allOf as conditional", () => {
    const req = describePermission(allOf(tierGate({ met: true }), requireRoles("manager")));
    expect(req.kind === "roles" ? req.conditional : "x").toBeUndefined();
  });

  it("anyOf is closed only when every branch is", () => {
    const a = { met: false };
    const b = { met: true };
    const union = anyOf(tierGate(a), tierGate(b));
    expect(describePermission(union).kind).not.toBe("denied");
    b.met = false;
    expect(describePermission(union)).toEqual({ kind: "denied" });
  });
});

describe("published requirement shape", () => {
  it("omits `conditional` unless it is true", () => {
    expect(Object.keys(describePermission(requireRoles("a")))).toEqual(["kind", "roles"]);
    expect(Object.keys(describePermission(hq("admin")))).toEqual(["kind", "scope", "roles"]);
  });
});
