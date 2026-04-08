/**
 * `requireScopeContext` + `getScopeContext` tests — 2.7.1 Gap 2
 *
 * Validates the new app-defined scope dimensions (`scope.context`) plus the
 * permission helper that gates routes by them. Designed to support real-world
 * tenancy patterns beyond org-only:
 *
 *   - Single org with multiple branches      (filter by org + branchId)
 *   - Multi-team within an org                (filter by org + teamId)
 *   - Multi-project within a team             (filter by org + teamId + projectId)
 *   - Multi-region with sticky data residency (filter by org + region)
 *   - Multi-workspace per user                (Postman model — workspaceId)
 *
 * Arc takes no position on the dimension names — your auth function populates
 * `scope.context` from headers / JWT claims / BA session fields, and the
 * permission helper + multiTenantPreset read it back.
 */

import { describe, expect, it } from "vitest";
import { requireScopeContext } from "../../src/permissions/index.js";
import { getScopeContext, getScopeContextMap, type RequestScope } from "../../src/scope/types.js";
import {
  makeAuthenticatedCtx,
  makeElevatedCtx,
  makeMemberCtx,
  makePublicCtx,
  makeServiceCtx,
} from "../_helpers/scope-factories.js";

// ============================================================================
// Scope accessors — getScopeContext + getScopeContextMap
// ============================================================================

describe("getScopeContext / getScopeContextMap", () => {
  it("returns context value from member scope", () => {
    const scope: RequestScope = {
      kind: "member",
      userId: "u1",
      userRoles: [],
      organizationId: "org-1",
      orgRoles: [],
      context: { branchId: "eng-paris", projectId: "p-1" },
    };
    expect(getScopeContext(scope, "branchId")).toBe("eng-paris");
    expect(getScopeContext(scope, "projectId")).toBe("p-1");
    expect(getScopeContext(scope, "missing")).toBeUndefined();
    expect(getScopeContextMap(scope)).toEqual({ branchId: "eng-paris", projectId: "p-1" });
  });

  it("returns context value from service scope", () => {
    const scope: RequestScope = {
      kind: "service",
      clientId: "c1",
      organizationId: "org-1",
      context: { workspaceId: "ws-42" },
    };
    expect(getScopeContext(scope, "workspaceId")).toBe("ws-42");
    expect(getScopeContextMap(scope)).toEqual({ workspaceId: "ws-42" });
  });

  it("returns context value from elevated scope", () => {
    const scope: RequestScope = {
      kind: "elevated",
      userId: "admin-1",
      elevatedBy: "x-arc-scope",
      context: { region: "eu" },
    };
    expect(getScopeContext(scope, "region")).toBe("eu");
  });

  it("returns undefined for scope kinds without context support", () => {
    expect(getScopeContext({ kind: "public" }, "branchId")).toBeUndefined();
    expect(getScopeContext({ kind: "authenticated", userId: "u1" }, "branchId")).toBeUndefined();
    expect(getScopeContextMap({ kind: "public" })).toBeUndefined();
    expect(getScopeContextMap({ kind: "authenticated", userId: "u1" })).toBeUndefined();
  });

  it("returns undefined when context is not set on a supported scope kind", () => {
    const scope: RequestScope = {
      kind: "member",
      userId: "u1",
      userRoles: [],
      organizationId: "org-1",
      orgRoles: [],
      // no context
    };
    expect(getScopeContext(scope, "branchId")).toBeUndefined();
    expect(getScopeContextMap(scope)).toBeUndefined();
  });
});

// ============================================================================
// requireScopeContext — call shape 1: presence-only
// ============================================================================

describe("requireScopeContext('key') — presence check", () => {
  const check = requireScopeContext("branchId");

  it("grants when key is present (member)", () => {
    expect(check(makeMemberCtx({ context: { branchId: "eng-paris" } }))).toBe(true);
  });

  it("grants when key is present (service)", () => {
    expect(check(makeServiceCtx({ context: { branchId: "eng-paris" } }))).toBe(true);
  });

  it("grants regardless of value (any non-empty string)", () => {
    expect(check(makeMemberCtx({ context: { branchId: "x" } }))).toBe(true);
    expect(check(makeMemberCtx({ context: { branchId: "anything-else" } }))).toBe(true);
  });

  it("denies when key is missing", () => {
    const result = check(makeMemberCtx({ context: { otherKey: "x" } }));
    expect(result).toMatchObject({ granted: false });
    expect((result as { reason: string }).reason).toContain("branchId");
  });

  it("denies when context is undefined entirely", () => {
    const result = check(makeMemberCtx({}));
    expect(result).toMatchObject({ granted: false });
    expect((result as { reason: string }).reason).toContain("Scope context required");
  });

  it("denies for public scope", () => {
    expect(check(makePublicCtx())).toMatchObject({ granted: false });
  });

  it("denies for authenticated-without-context scope", () => {
    expect(check(makeAuthenticatedCtx({ userId: "u1" }))).toMatchObject({ granted: false });
  });
});

// ============================================================================
// requireScopeContext — call shape 2: value match
// ============================================================================

describe("requireScopeContext('key', 'value') — exact value match", () => {
  const check = requireScopeContext("region", "eu");

  it("grants when value matches exactly", () => {
    expect(check(makeMemberCtx({ context: { region: "eu" } }))).toBe(true);
  });

  it("denies when value mismatches", () => {
    const result = check(makeMemberCtx({ context: { region: "us" } }));
    expect(result).toMatchObject({ granted: false });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("region");
    expect(reason).toContain("eu");
    expect(reason).toContain("us");
  });

  it("denies when key is missing", () => {
    const result = check(makeMemberCtx({ context: { otherKey: "x" } }));
    expect(result).toMatchObject({ granted: false });
  });
});

// ============================================================================
// requireScopeContext — call shape 3: object form (multi-key AND)
// ============================================================================

describe("requireScopeContext({ ... }) — object form, AND semantics", () => {
  it("grants when ALL keys match", () => {
    const check = requireScopeContext({ branchId: "eng-paris", projectId: "p-1" });
    expect(check(makeMemberCtx({ context: { branchId: "eng-paris", projectId: "p-1" } }))).toBe(
      true,
    );
  });

  it("denies when ONE of multiple keys mismatches", () => {
    const check = requireScopeContext({ branchId: "eng-paris", projectId: "p-1" });
    const result = check(
      makeMemberCtx({ context: { branchId: "eng-paris", projectId: "p-WRONG" } }),
    );
    expect(result).toMatchObject({ granted: false });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("projectId");
  });

  it("denies when ONE of multiple keys is missing", () => {
    const check = requireScopeContext({ branchId: "eng-paris", projectId: "p-1" });
    const result = check(makeMemberCtx({ context: { branchId: "eng-paris" } }));
    expect(result).toMatchObject({ granted: false });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("projectId");
    expect(reason).toContain("missing");
  });

  it("supports mixed presence-only and value-match in the same object", () => {
    // `branchId: undefined` = "must be present, any value"
    // `region: 'eu'`         = "must equal 'eu'"
    const check = requireScopeContext({
      branchId: undefined as unknown as string,
      region: "eu",
    });
    expect(check(makeMemberCtx({ context: { branchId: "anything", region: "eu" } }))).toBe(true);
    expect(check(makeMemberCtx({ context: { branchId: "anything", region: "us" } }))).toMatchObject(
      { granted: false },
    );
    expect(check(makeMemberCtx({ context: { region: "eu" } }))).toMatchObject({
      granted: false,
    });
  });
});

// ============================================================================
// Elevated bypass — requireScopeContext always grants for platform admins
// ============================================================================

describe("requireScopeContext — elevated bypass", () => {
  it("grants for elevated scope WITH the key set", () => {
    const check = requireScopeContext("branchId");
    expect(check(makeElevatedCtx({ context: { branchId: "eng-paris" } }))).toBe(true);
  });

  it("grants for elevated scope WITHOUT the key set (platform bypass)", () => {
    // Platform admins act cross-context — they should not be blocked by
    // missing branch/project/region dimensions.
    const check = requireScopeContext("branchId");
    expect(check(makeElevatedCtx({}))).toBe(true);
  });

  it("grants for elevated scope on value-match form too", () => {
    const check = requireScopeContext("region", "eu");
    expect(check(makeElevatedCtx({ context: { region: "us" } }))).toBe(true);
    expect(check(makeElevatedCtx({}))).toBe(true);
  });

  it("grants for elevated scope on object form too", () => {
    const check = requireScopeContext({ branchId: "eng-paris", projectId: "p-1" });
    expect(check(makeElevatedCtx({}))).toBe(true);
  });
});

// ============================================================================
// Construction errors
// ============================================================================

describe("requireScopeContext — construction errors", () => {
  it("throws on empty object", () => {
    expect(() => requireScopeContext({})).toThrow(/at least one key/);
  });

  it("throws on null/undefined input", () => {
    // @ts-expect-error — runtime validation for the JS-call edge case
    expect(() => requireScopeContext(null)).toThrow();
    // @ts-expect-error
    expect(() => requireScopeContext(undefined)).toThrow();
  });
});

// ============================================================================
// Real-world scenario walkthroughs (the point of the whole thing)
// ============================================================================

describe("real-world scenarios — Postman-style fan-out + per-team projects", () => {
  it("workspace member with active workspace + team + project", () => {
    // User is in Workspace A, switched to Team Backend, currently working on Project X.
    // BA bridge populated org + team; the app's auth function added projectId via
    // an x-project-id header read in a custom auth bridge.
    const ctx = makeMemberCtx({
      organizationId: "workspace-A",
      context: { teamId: "team-backend", projectId: "project-X" },
    });

    // Three independent gates that the same route can stack
    expect(requireScopeContext("teamId")(ctx)).toBe(true);
    expect(requireScopeContext("projectId")(ctx)).toBe(true);
    expect(requireScopeContext({ teamId: "team-backend", projectId: "project-X" })(ctx)).toBe(true);
  });

  it("API key bound to a specific branch (data residency)", () => {
    // Acme has an API key issued for the EU branch only. The auth function
    // adds region+branchId to the service scope's context.
    const ctx = makeServiceCtx({
      organizationId: "acme",
      context: { region: "eu", branchId: "acme-paris" },
    });

    expect(requireScopeContext({ region: "eu", branchId: "acme-paris" })(ctx)).toBe(true);
    expect(requireScopeContext("region", "us")(ctx)).toMatchObject({ granted: false });
  });

  it("user without project context can't access project-scoped routes", () => {
    // User is in Workspace A but hasn't selected an active project — the
    // route correctly denies until the client picks one.
    const ctx = makeMemberCtx({
      organizationId: "workspace-A",
      context: { teamId: "team-backend" }, // no projectId
    });
    expect(requireScopeContext("projectId")(ctx)).toMatchObject({ granted: false });
  });
});
