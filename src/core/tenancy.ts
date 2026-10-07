/**
 * The tenancy decision for one read, stated ONCE.
 *
 * Four layers scope a CRUD read by tenant — `QueryResolver` (list filter),
 * `AccessControl.buildIdFilter` (single-row lookup), `AccessControl.checkOrgScope`
 * (post-fetch check) and `buildTenantRepoOptions` (what the kit is told). Each
 * used to re-derive the answer from the request scope with its own condition,
 * so a new way of scoping a read had to be taught to all four by hand. That is
 * not hypothetical: `crossTenant` (2.41.1) was taught to three, the fourth
 * (`buildIdFilter`) kept pinning the caller's organization into single-row
 * lookups, and `crossTenant: ['get']` silently did nothing for every signed-in
 * member while working for anonymous readers.
 *
 * So the rule lives here and the layers switch on the result. The union is
 * exhaustive on purpose: a new mode added below becomes a compile error in
 * every consumer that has not decided what to do with it — the guarantee the
 * hand-copied conditions could not give.
 */

import type { RequestScope } from "../scope/types.js";
import { getOrgId, isElevated } from "../scope/types.js";

/**
 * - `scoped`: filter by `field = orgId`.
 * - `unscoped`: do not filter by tenant, for one of:
 *   - `untenanted-resource`: the resource has no tenant field (`tenantField: false`);
 *   - `cross-tenant`: the route declared a deliberately cross-tenant read
 *     (`multiTenantPreset({ crossTenant })`); the resource's row policy still applies;
 *   - `platform`: an elevated admin with no active organization;
 *   - `no-org`: any other caller without an organization (public/anonymous,
 *     or signed in with none selected). Routes that REQUIRE one refuse such
 *     callers earlier, in the preset's middleware — this layer only filters.
 */
export type TenancyDecision =
  | { readonly mode: "scoped"; readonly field: string; readonly orgId: string }
  | {
      readonly mode: "unscoped";
      readonly reason: "untenanted-resource" | "cross-tenant" | "platform" | "no-org";
    };

/** What the decision reads off the request — nothing else may influence it. */
export interface TenancyInput {
  readonly _scope?: RequestScope;
  readonly _crossTenantRead?: boolean;
}

/**
 * Who a streamed event may reach — derived from the same `resolveTenancy`
 * rule, so a stream agrees with a read about the same caller.
 *
 * It did not: SSE and the `realtime` plugin each carried their own tenant
 * guard, and they disagreed on the ELEVATED admin with no active org. A read
 * gives that admin the platform view (every tenant); `realtime` dropped every
 * tenant's events for them, so the admin could `list` a resource across
 * tenants and never see a change to the rows that list returned.
 */
export interface EventAudience {
  /** The subscriber's organization, when they have one. */
  readonly orgId?: string;
  /** An elevated admin with no active org — sees every tenant, as reads do. */
  readonly platformView: boolean;
}

export function eventAudienceOf(scope: RequestScope | undefined): EventAudience {
  // Events carry tenancy on `meta.organizationId`, so the field is fixed here.
  const tenancy = resolveTenancy({ _scope: scope }, "organizationId");
  return tenancy.mode === "scoped"
    ? { orgId: tenancy.orgId, platformView: false }
    : { platformView: tenancy.reason === "platform" };
}

/**
 * Whether an event tagged `eventOrgId` may reach `audience`. Untenanted events
 * reach everyone; a tenant's event reaches that tenant and the platform view,
 * and nobody else — including a caller with no org at all (fail-closed).
 */
export function isEventVisible(eventOrgId: unknown, audience: EventAudience): boolean {
  if (eventOrgId === undefined || eventOrgId === null || eventOrgId === "") return true;
  if (audience.platformView) return true;
  return audience.orgId !== undefined && String(eventOrgId) === audience.orgId;
}

export function resolveTenancy(
  input: TenancyInput | undefined,
  tenantField: string | false | undefined,
): TenancyDecision {
  if (!tenantField) return { mode: "unscoped", reason: "untenanted-resource" };
  if (input?._crossTenantRead === true) return { mode: "unscoped", reason: "cross-tenant" };

  const scope = input?._scope;
  const orgId = scope ? getOrgId(scope) : undefined;
  if (orgId) return { mode: "scoped", field: tenantField, orgId };

  return { mode: "unscoped", reason: scope && isElevated(scope) ? "platform" : "no-org" };
}
