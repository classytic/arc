/**
 * `resolveTenancy` — the one rule every read-scoping layer switches on.
 *
 * Before it, `QueryResolver`, `AccessControl.buildIdFilter`,
 * `AccessControl.checkOrgScope` and `buildTenantRepoOptions` each re-derived
 * the decision from the scope with their own condition. `crossTenant` was
 * taught to three of them; `buildIdFilter` kept pinning the caller's org into
 * single-row lookups, so `crossTenant: ['get']` did nothing for any signed-in
 * member. The table below is the rule — change it here, and the layers follow.
 */

import { describe, expect, it } from "vitest";
import { buildTenantRepoOptions } from "../../src/core/crud/requestPipeline.js";
import { eventAudienceOf, isEventVisible, resolveTenancy } from "../../src/core/tenancy.js";
import type { RequestScope } from "../../src/scope/types.js";
import type { ArcInternalMetadata, IRequestContext } from "../../src/types/index.js";

const member: RequestScope = {
  kind: "member",
  userId: "u1",
  userRoles: [],
  organizationId: "org-1",
  orgRoles: [],
} as unknown as RequestScope;
const elevatedNoOrg = { kind: "elevated", elevatedBy: "admin" } as unknown as RequestScope;
const elevatedWithOrg = {
  kind: "elevated",
  elevatedBy: "admin",
  organizationId: "org-9",
} as unknown as RequestScope;
const authenticatedNoOrg = { kind: "authenticated", userId: "u2" } as unknown as RequestScope;
const anonymous = { kind: "public" } as unknown as RequestScope;

describe("resolveTenancy — the rule", () => {
  it.each([
    ["member with an org", member, false, { mode: "scoped", field: "organizationId", orgId: "org-1" }],
    [
      "elevated admin impersonating an org",
      elevatedWithOrg,
      false,
      { mode: "scoped", field: "organizationId", orgId: "org-9" },
    ],
    ["elevated admin with no org → platform view", elevatedNoOrg, false, { mode: "unscoped", reason: "platform" }],
    ["signed in, no org selected", authenticatedNoOrg, false, { mode: "unscoped", reason: "no-org" }],
    ["anonymous", anonymous, false, { mode: "unscoped", reason: "no-org" }],
    ["member on a DECLARED cross-tenant read", member, true, { mode: "unscoped", reason: "cross-tenant" }],
  ])("%s", (_label, scope, crossTenant, expected) => {
    expect(
      resolveTenancy({ _scope: scope, _crossTenantRead: crossTenant }, "organizationId"),
    ).toEqual(expected);
  });

  it("an untenanted resource is never scoped, whoever calls", () => {
    for (const scope of [member, elevatedWithOrg, anonymous]) {
      expect(resolveTenancy({ _scope: scope }, false)).toEqual({
        mode: "unscoped",
        reason: "untenanted-resource",
      });
    }
  });

  it("cross-tenant outranks the caller's own org — that is the whole option", () => {
    // The bug `crossTenant` shipped with: a signed-in member always HAS an org,
    // so any layer that consulted the org first put the tenant filter back.
    expect(resolveTenancy({ _scope: member, _crossTenantRead: true }, "organizationId").mode).toBe(
      "unscoped",
    );
  });

  it("honours a custom tenant field name", () => {
    expect(resolveTenancy({ _scope: member }, "tenantId")).toEqual({
      mode: "scoped",
      field: "tenantId",
      orgId: "org-1",
    });
  });
});

describe("buildTenantRepoOptions — a cross-tenant read keeps its attribution", () => {
  const req = (arc: Partial<ArcInternalMetadata>): IRequestContext =>
    ({
      id: "req-42",
      user: { id: "u1" },
      traceContext: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
      metadata: arc,
    }) as unknown as IRequestContext;

  it("drops ONLY the tenant — userId, user, requestId and traceId still reach the kit", () => {
    // It used to `return` straight after setting `bypassTenant`, so every
    // cross-tenant read reached the repository with no audit attribution and
    // no trace correlation.
    const arc = { _scope: member, _crossTenantRead: true } as ArcInternalMetadata;
    const out = buildTenantRepoOptions(req(arc), "organizationId", arc);

    expect(out.bypassTenant).toBe(true);
    expect(out.organizationId).toBeUndefined();
    expect(out.userId).toBe("u1");
    expect(out.user).toEqual({ id: "u1" });
    expect(out.requestId).toBe("req-42");
    expect(out.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    // And it is frozen like every other cached bag now.
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("a scoped read forwards the tenant and no bypass", () => {
    const arc = { _scope: member } as ArcInternalMetadata;
    const out = buildTenantRepoOptions(req(arc), "organizationId", arc);
    expect(out.organizationId).toBe("org-1");
    expect(out.bypassTenant).toBeUndefined();
  });

  it("the platform view (elevated, no org) forwards bypassTenant", () => {
    const arc = { _scope: elevatedNoOrg } as ArcInternalMetadata;
    const out = buildTenantRepoOptions(req(arc), "organizationId", arc);
    expect(out.bypassTenant).toBe(true);
  });

  it("a caller with no org gets neither a tenant nor a bypass", () => {
    // Not a bypass: that is the kit's `required: true` guard's call to make.
    const arc = { _scope: authenticatedNoOrg } as ArcInternalMetadata;
    const out = buildTenantRepoOptions(req(arc), "organizationId", arc);
    expect(out.organizationId).toBeUndefined();
    expect(out.bypassTenant).toBeUndefined();
  });
});

describe("eventAudienceOf / isEventVisible — streams follow the read rule", () => {
  it.each([
    ["member, own tenant", member, "org-1", true],
    ["member, other tenant", member, "org-2", false],
    ["elevated, no org → platform view sees all", elevatedNoOrg, "org-2", true],
    ["elevated impersonating org-9 → scoped to it", elevatedWithOrg, "org-2", false],
    ["signed in, no org → tenant events withheld", authenticatedNoOrg, "org-1", false],
    ["anonymous → tenant events withheld", anonymous, "org-1", false],
  ])("%s", (_label, scope, eventOrg, visible) => {
    expect(isEventVisible(eventOrg, eventAudienceOf(scope))).toBe(visible);
  });

  it("an untenanted event reaches everyone", () => {
    for (const scope of [member, anonymous, authenticatedNoOrg]) {
      expect(isEventVisible(undefined, eventAudienceOf(scope))).toBe(true);
    }
  });
});
