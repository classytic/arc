/**
 * The test-actor seam.
 *
 * These tests exist because the seam's whole value is that nine packages stop
 * hand-rolling identity. If the scope it produces is subtly wrong, the packages that
 * trust it get authorization results that look right and are not — the failure mode
 * the seam was built to end.
 */
import { describe, expect, it } from "vitest";
import { getOrgId, getUserId, getUserRoles, isElevated, isMember } from "../../src/scope/types.js";
import { scopeRoleGate } from "../../src/testing/scopeRoleGate.js";
import {
  scopeFromTestActor,
  TEST_ACTOR_HEADER,
  testActorHeaders,
} from "../../src/testing/testActor.js";

describe("scopeFromTestActor", () => {
  it("an org makes a MEMBER scope — what org-scoped resources actually require", () => {
    const scope = scopeFromTestActor({ organizationId: "org-1", roles: ["manager"] });
    expect(isMember(scope)).toBe(true);
    expect(getOrgId(scope)).toBe("org-1");
    expect(getUserRoles(scope)).toEqual(["manager"]);
  });

  it("no org makes an AUTHENTICATED scope — not a member of nothing", () => {
    // The distinction matters: a `member` scope with an empty organizationId would
    // pass tenant checks against the empty string and silently read another org's data.
    const scope = scopeFromTestActor({ roles: ["admin"] });
    expect(scope.kind).toBe("authenticated");
    expect(getOrgId(scope)).toBeUndefined();
  });

  it("orgRoles DEFAULT to roles", () => {
    // A test that says "manager" means it at both levels. Requiring the caller to
    // repeat itself only produces tests that clear a global gate and fail an org one
    // for reasons that have nothing to do with the code under test.
    const scope = scopeFromTestActor({ organizationId: "org-1", roles: ["manager"] });
    expect(isMember(scope) && scope.orgRoles).toEqual(["manager"]);
  });

  it("orgRoles can DIFFER from roles when a test means them to", () => {
    const scope = scopeFromTestActor({
      organizationId: "org-1",
      roles: ["staff"],
      orgRoles: ["branch_manager"],
    });
    expect(isMember(scope) && scope.orgRoles).toEqual(["branch_manager"]);
    expect(getUserRoles(scope)).toEqual(["staff"]);
  });

  it("elevated records WHO elevated — arc requires it, a boolean cannot answer it", () => {
    const scope = scopeFromTestActor({ elevated: "platform-support" });
    expect(isElevated(scope)).toBe(true);
    expect(isElevated(scope) && scope.elevatedBy).toBe("platform-support");
  });

  it("elevated: true is shorthand, not a missing field", () => {
    const scope = scopeFromTestActor({ elevated: true });
    expect(isElevated(scope) && scope.elevatedBy).toBe("test");
  });

  it("elevated: false is NOT elevation", () => {
    // Guards the obvious refactor slip — `if (spec.elevated)` vs `!== undefined`.
    const scope = scopeFromTestActor({ elevated: false, organizationId: "org-1" });
    expect(isElevated(scope)).toBe(false);
    expect(isMember(scope)).toBe(true);
  });

  it("carries userId and scope context through", () => {
    const scope = scopeFromTestActor({
      userId: "u-1",
      organizationId: "org-1",
      roles: ["cashier"],
      context: { branchId: "b-9" },
    });
    expect(getUserId(scope)).toBe("u-1");
    expect(isMember(scope) && scope.context?.branchId).toBe("b-9");
  });

  it("freezes context — the scope contract says immutable", () => {
    const scope = scopeFromTestActor({ organizationId: "o", context: { branchId: "b" } });
    const ctx = isMember(scope) ? scope.context : undefined;
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});

describe("testActorHeaders", () => {
  it("a string is shorthand for one role", () => {
    const headers = testActorHeaders("manager", "org-1");
    expect(JSON.parse(headers[TEST_ACTOR_HEADER]!)).toEqual({
      roles: ["manager"],
      organizationId: "org-1",
    });
  });

  it("null means STAY PUBLIC — so a test can prove anonymous reachability", () => {
    // Not the same as omitting the header, which inherits the boot-level default actor.
    expect(testActorHeaders(null)).toEqual({});
  });

  it("the positional org overrides the spec's, so one helper can retarget a tenant", () => {
    const headers = testActorHeaders({ roles: ["admin"], organizationId: "org-1" }, "org-2");
    expect(JSON.parse(headers[TEST_ACTOR_HEADER]!).organizationId).toBe("org-2");
  });

  it("round-trips through the header into the intended scope", () => {
    // The property that actually matters end to end: what a test asks for is what the
    // route sees.
    const headers = testActorHeaders({
      userId: "u-1",
      roles: ["cashier"],
      organizationId: "org-7",
    });
    const scope = scopeFromTestActor(JSON.parse(headers[TEST_ACTOR_HEADER]!));
    expect(getUserId(scope)).toBe("u-1");
    expect(getOrgId(scope)).toBe("org-7");
    expect(getUserRoles(scope)).toEqual(["cashier"]);
  });
});
