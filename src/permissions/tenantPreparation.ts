/** Tenant preparation shared by HTTP middleware and direct transport invocation. */
import { conjoinPolicyFilters } from "../permissions/filter-merge.js";
import type { RequestScope } from "../scope/types.js";
import { getOrgId, getScopeContext, getTeamId, hasOrgAccess, isElevated } from "../scope/types.js";
import type { ArcInternalMetadata, IRequestContext } from "../types/index.js";
import { createDomainError } from "../utils/errors.js";

export type TenantFieldSpec =
  | { field: string; type: "org" }
  | { field: string; type: "team" }
  | { field: string; contextKey: string };
export type TenantPreparationMode = "strict" | "flexible" | "inject" | "crossTenant";
export interface TenantPreparation {
  readonly specs: readonly TenantFieldSpec[];
  readonly mode: TenantPreparationMode;
}
const PREPARATION = Symbol.for("arc.tenantPreparation");

export function tagTenantPreparation<T extends object>(
  middleware: T,
  preparation: TenantPreparation,
): T {
  Object.defineProperty(middleware, PREPARATION, { value: preparation });
  return middleware;
}

export function isTenantPreparation(middleware: unknown): boolean {
  return (
    typeof middleware === "function" &&
    (middleware as unknown as Record<symbol, unknown>)[PREPARATION] !== undefined
  );
}

export function prepareTenancy(
  scope: RequestScope,
  preparation: TenantPreparation,
): {
  fields?: Record<string, string>;
  policy?: Record<string, string>;
  inject?: boolean;
  crossTenant?: boolean;
} {
  if (preparation.mode === "crossTenant") return { crossTenant: true };
  const elevated = isElevated(scope);
  if (preparation.mode === "inject" && elevated && !getOrgId(scope)) return {};
  if (preparation.mode !== "inject" && !elevated && !hasOrgAccess(scope)) {
    if (preparation.mode === "flexible") return {};
    throw createDomainError(
      scope.kind === "public" ? "arc.unauthorized" : "arc.forbidden",
      scope.kind === "public"
        ? "Authentication required for multi-tenant resources"
        : "Organization context required for this operation",
      scope.kind === "public" ? 401 : 403,
    );
  }
  const fields: Record<string, string> = {};
  const missing: string[] = [];
  for (const spec of preparation.specs) {
    const value =
      "contextKey" in spec
        ? getScopeContext(scope, spec.contextKey)
        : spec.type === "org"
          ? getOrgId(scope)
          : getTeamId(scope);
    if (value === undefined) missing.push(spec.field);
    else fields[spec.field] = value;
  }
  if (missing.length && (preparation.mode === "inject" || !elevated)) {
    throw createDomainError(
      "arc.forbidden",
      `Tenant context incomplete — missing: ${missing.join(", ")}`,
      403,
    );
  }
  return { fields, ...(preparation.mode === "inject" ? { inject: true } : { policy: fields }) };
}

export function applyTenantPreparation(
  target: Pick<ArcInternalMetadata, "_policyFilters" | "_tenantFields" | "_crossTenantRead">,
  body: unknown,
  scope: RequestScope,
  preparation: TenantPreparation,
): void {
  const result = prepareTenancy(scope, preparation);
  if (result.crossTenant) target._crossTenantRead = true;
  if (result.policy && Object.keys(result.policy).length)
    target._policyFilters = conjoinPolicyFilters(target._policyFilters, result.policy);
  if (result.fields && Object.keys(result.fields).length)
    target._tenantFields = { ...target._tenantFields, ...result.fields };
  if (result.inject && body && typeof body === "object") Object.assign(body, result.fields);
}

export function prepareTenantContext(
  ctx: IRequestContext,
  middlewares: readonly unknown[] | undefined,
): void {
  const meta = ctx.metadata as ArcInternalMetadata;
  for (const middleware of middlewares ?? []) {
    if (typeof middleware !== "function") continue;
    const preparation = (middleware as unknown as Record<symbol, TenantPreparation | undefined>)[
      PREPARATION
    ];
    if (preparation)
      applyTenantPreparation(meta, ctx.body, meta._scope ?? { kind: "public" }, preparation);
    if (meta._tenantFields)
      (ctx as IRequestContext & { _tenantFields?: Record<string, unknown> })._tenantFields =
        meta._tenantFields;
  }
}
