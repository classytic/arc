/**
 * A cross-tenant read has to be honoured by every layer that scopes a read, not just the route.
 *
 * Tenancy is applied in four places, and three of them derive the organization from the request
 * scope independently of the preset that owns the decision:
 *
 *   1. the preset's route middleware   → `_policyFilters`      (tested in tests/presets)
 *   2. `QueryResolver.resolve`         → the outgoing `list` filter
 *   3. `buildTenantRepoOptions`        → the repository's tenant context
 *   4. `AccessControl.checkOrgScope`   → post-fetch re-check on `get`
 *
 * That redundancy is deliberate defence in depth, and it is also why removing the filter at (1)
 * changed nothing observable: (2) put it straight back one layer down, where nothing in the route
 * configuration showed it. These tests pin the other three, each with the scoped case alongside so
 * a change that simply stopped filtering everything fails here rather than passing quietly.
 */

import { describe, expect, it } from "vitest";
import { AccessControl } from "../../src/core/AccessControl.js";
import { buildTenantRepoOptions } from "../../src/core/crud/requestPipeline.js";
import { QueryResolver } from "../../src/core/QueryResolver.js";
import type { RequestScope } from "../../src/scope/types.js";
import type {
  ArcInternalMetadata,
  IRequestContext,
  QueryParserInterface,
} from "../../src/types/index.js";

const MEMBER: RequestScope = {
  kind: "member",
  userId: "u-1",
  userRoles: ["user"],
  organizationId: "org-acme",
  orgRoles: ["owner"],
};

function passthroughParser(): QueryParserInterface {
  return {
    parse(query: Record<string, unknown> = {}) {
      const { page: _p, limit: _l, ...filters } = query ?? {};
      return { filters, page: 1, limit: 20 };
    },
  } as unknown as QueryParserInterface;
}

function createReq(overrides: Partial<IRequestContext> = {}): IRequestContext {
  return { params: {}, query: {}, body: {}, user: null, headers: {}, ...overrides } as IRequestContext;
}

const meta = (extra: Record<string, unknown> = {}): ArcInternalMetadata =>
  ({ _scope: MEMBER, _policyFilters: {}, ...extra }) as unknown as ArcInternalMetadata;

describe("cross-tenant reads — layer 2: QueryResolver", () => {
  const resolver = () =>
    new QueryResolver({ queryParser: passthroughParser(), tenantField: "organizationId" });

  it("CONTROL: a scoped read still gets the tenant filter from the scope", () => {
    const resolved = resolver().resolve(createReq(), meta());
    expect(JSON.stringify(resolved.filters)).toContain("org-acme");
  });

  it("a cross-tenant read does not", () => {
    const resolved = resolver().resolve(createReq(), meta({ _crossTenantRead: true }));
    expect(JSON.stringify(resolved.filters)).not.toContain("org-acme");
  });

  it("the resource's own row policy still applies — unscoped is not unfiltered", () => {
    // The whole safety argument for `crossTenant` is that the resource states what a stranger may
    // see. If the policy were dropped alongside the tenant filter, the option would publish every
    // draft in every tenant.
    const resolved = resolver().resolve(
      createReq(),
      meta({ _crossTenantRead: true, _policyFilters: { status: "active" } }),
    );
    expect(JSON.stringify(resolved.filters)).toContain("active");
  });
});

describe("cross-tenant reads — layer 3: buildTenantRepoOptions", () => {
  it("CONTROL: a scoped read forwards the tenant to the repository", () => {
    const out = buildTenantRepoOptions(createReq(), "organizationId", meta());
    expect(out.organizationId).toBe("org-acme");
    expect(out.bypassTenant).toBeUndefined();
  });

  it("a cross-tenant read forwards no tenant, and says bypass explicitly", () => {
    // Explicit because a kit wired `multiTenantPlugin({ required: true })` rejects a call with no
    // tenant context rather than treating silence as permission.
    const out = buildTenantRepoOptions(createReq(), "organizationId", meta({ _crossTenantRead: true }));
    expect(out.organizationId).toBeUndefined();
    expect(out.bypassTenant).toBe(true);
  });
});

describe("cross-tenant reads — layer 4: post-fetch org check", () => {
  const control = new AccessControl({ tenantField: "organizationId", idField: "_id" });
  const otherTenantRow = { _id: "p1", organizationId: "org-other", status: "active" };

  it("CONTROL: a scoped read refuses another tenant's row post-fetch", () => {
    expect(control.checkOrgScope(otherTenantRow, meta())).toBe(false);
  });

  it("a cross-tenant read allows it, which is the point of the option", () => {
    expect(control.checkOrgScope(otherTenantRow, meta({ _crossTenantRead: true }))).toBe(true);
  });
});
