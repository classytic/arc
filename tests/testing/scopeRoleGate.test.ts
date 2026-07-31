/**
 * `scopeRoleGate` — the shared test role gate.
 *
 * Its own file, not appended to another suite, because the function it covers lives in
 * its own module for the same reason: this repo has concurrent editors, and an appended
 * block is the first thing a stale editor buffer erases. (It already happened once —
 * both the function and its tests vanished from files that had passed minutes earlier.)
 *
 * The gate DELEGATES to `requireOrgRole`, so these cases double as a statement of what a
 * test actor must carry to satisfy production's org-role semantics: a `member` scope AND
 * an authenticated user — exactly what `bootModuleApp`'s authenticator establishes. The
 * contexts below therefore model a real request rather than a scope in isolation; the
 * earlier shape (scope only, no user) could satisfy a hand-rolled gate that production
 * would have refused.
 */
import { describe, expect, it } from "vitest";
import { normalizeToDecision } from "../../src/permissions/authorizationDecision.js";
import type { PermissionContext } from "../../src/permissions/types.js";
import { scopeRoleGate } from "../../src/testing/scopeRoleGate.js";
import { scopeFromTestActor } from "../../src/testing/testActor.js";

/** A realistic permission context: verified scope + the user arc's auth phase requires. */
const ctx = (scope?: unknown): PermissionContext =>
  ({
    request: { scope },
    scope,
    user: scope ? { id: "u1", role: [] } : null,
    resource: "thing",
    action: "read",
  }) as unknown as PermissionContext;

const member = (roles: string[], org = "org-1") =>
  scopeFromTestActor({ organizationId: org, roles });

/** Run the gate and reduce its decision to allow/deny. */
const granted = (gate: ReturnType<typeof scopeRoleGate>, c: PermissionContext): boolean =>
  normalizeToDecision(gate(c) as never).effect === "allow";

describe("scopeRoleGate", () => {
  it("grants an org member holding the role", () => {
    expect(granted(scopeRoleGate("manager"), ctx(member(["manager"])))).toBe(true);
  });

  it("refuses a role it does not list", () => {
    expect(granted(scopeRoleGate("manager"), ctx(member(["cashier"])))).toBe(false);
  });

  it("grants on ANY of the allowed roles", () => {
    expect(granted(scopeRoleGate("manager", "admin"), ctx(member(["admin"])))).toBe(true);
  });

  it("refuses when there is NO scope at all", () => {
    expect(granted(scopeRoleGate("manager"), ctx(undefined))).toBe(false);
  });

  it("refuses a scope with no organization rather than defaulting", () => {
    // Arc's auto-CRUD filters by tenant. A gate that waves through a tenant-less request
    // is how a passing test reads another org's rows.
    expect(granted(scopeRoleGate("manager"), ctx(scopeFromTestActor({ roles: ["manager"] })))).toBe(
      false,
    );
  });

  it("refuses a scope carrying no roles", () => {
    expect(granted(scopeRoleGate("manager"), ctx(member([])))).toBe(false);
  });

  it("reads ORG roles, agreeing with requireOrgRole rather than global roles", () => {
    // The divergence this delegation removes: reading `userRoles` while requiring an
    // organization made the gate disagree with production whenever the two dimensions
    // differ. The old tests could not see it because `scopeFromTestActor` defaults
    // `orgRoles` to `roles`, so both dimensions matched for every actor they built.
    const split = scopeFromTestActor({
      organizationId: "org-1",
      roles: ["employee"],
      orgRoles: ["manager"],
    });
    expect(granted(scopeRoleGate("manager"), ctx(split))).toBe(true);
    expect(granted(scopeRoleGate("employee"), ctx(split))).toBe(false);
  });

  it("grants an elevated (platform-admin) scope", () => {
    // Inherited from requireOrgRole — a hand-rolled org check kept missing it.
    expect(granted(scopeRoleGate("manager"), ctx(scopeFromTestActor({ elevated: true })))).toBe(
      true,
    );
  });
});
