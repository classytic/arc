/**
 * Multi-Tenant Preset
 *
 * Adds tenant (organization) filtering and injection middlewares.
 *
 * Supports two configurations:
 *
 * **Single-field (default, backwards compatible)** — filter by one tenant
 * dimension, typically `organizationId`:
 *
 * ```typescript
 * multiTenantPreset({ tenantField: 'organizationId' })
 * ```
 *
 * **Multi-field (2.7.1+)** — filter by multiple dimensions in lockstep
 * (org + branch, org + project, org + team + workspace, etc.). Each entry
 * declares what scope source to read from:
 *
 * ```typescript
 * multiTenantPreset({
 *   tenantFields: [
 *     { field: 'organizationId', type: 'org' },              // → getOrgId(scope)
 *     { field: 'teamId',         type: 'team' },             // → getTeamId(scope)
 *     { field: 'branchId',       contextKey: 'branchId' },   // → getScopeContext(scope, 'branchId')
 *     { field: 'projectId',      contextKey: 'projectId' },
 *   ],
 * })
 * ```
 *
 * Multi-field uses fail-closed semantics: if any required dimension is
 * missing from the caller's scope, list/get/update/delete return 403 and
 * create is rejected. Elevated scopes apply whatever dimensions resolve
 * and skip the rest (cross-context admin bypass).
 */

import type { FastifyReply } from "fastify";
import { DEFAULT_TENANT_FIELD } from "../constants.js";
import type { RequestScope } from "../scope/types.js";
import {
  getOrgId,
  getRequestScope as getScope,
  getScopeContext,
  getTeamId,
  hasOrgAccess,
  isElevated,
} from "../scope/types.js";
import type {
  AnyRecord,
  CrudRouteKey,
  MiddlewareConfig,
  PresetResult,
  RequestWithExtras,
  RouteHandler,
} from "../types/index.js";

/**
 * One tenant dimension for multi-field filtering. Discriminated by source:
 * - `type: 'org'`  → reads `getOrgId(scope)`
 * - `type: 'team'` → reads `getTeamId(scope)`
 * - `contextKey`   → reads `getScopeContext(scope, contextKey)` (any custom dimension)
 */
export type TenantFieldSpec =
  | { field: string; type: "org" }
  | { field: string; type: "team" }
  | { field: string; contextKey: string };

export interface MultiTenantOptions {
  /**
   * Single-field form: name of the database field to filter by.
   * Reads `getOrgId(scope)` as the value source.
   *
   * Mutually exclusive with `tenantFields` — pass one or the other, not both.
   *
   * @default 'organizationId'
   */
  tenantField?: string;

  /**
   * Multi-field form (2.7.1+): list of tenant dimensions to filter by in
   * lockstep. Use this when a resource is scoped by more than just
   * organization — e.g. organization + branch, organization + project,
   * or organization + team + workspace.
   *
   * Each entry is a discriminated `TenantFieldSpec` declaring where the
   * value comes from. Use `type: 'org'` / `type: 'team'` for built-in scope
   * fields, or `contextKey: '...'` to read from `scope.context` (set by
   * your auth function).
   *
   * Fail-closed: if any required dimension is missing, the request is
   * rejected. Elevated scopes apply whatever resolves and skip the rest.
   *
   * Mutually exclusive with `tenantField`.
   *
   * @example
   * ```typescript
   * multiTenantPreset({
   *   tenantFields: [
   *     { field: 'organizationId', type: 'org' },
   *     { field: 'branchId',       contextKey: 'branchId' },
   *   ],
   * })
   * ```
   */
  tenantFields?: readonly TenantFieldSpec[];

  /**
   * Routes that allow public access (no auth required)
   * When a route is in this array:
   * - If no org context: allow through without filtering (public data)
   * - If org context present: require auth and apply filter
   *
   * @default [] (strict mode - all routes require auth)
   * @example
   * multiTenantPreset({ allowPublic: ['list', 'get'] })
   */
  allowPublic?: CrudRouteKey[];
}

/**
 * Resolve a single TenantFieldSpec against the current scope.
 * Returns `undefined` if the source value isn't present on the scope.
 */
function resolveSpec(scope: RequestScope, spec: TenantFieldSpec): string | undefined {
  if ("contextKey" in spec) return getScopeContext(scope, spec.contextKey);
  if (spec.type === "org") return getOrgId(scope);
  if (spec.type === "team") return getTeamId(scope);
  return undefined;
}

/**
 * Stash the resolved tenant field map on the request so `BaseController`
 * can forward it to the repository layer as top-level options. Needed by
 * plugin-scoped repos (mongokit's `multiTenantPlugin`) that read tenant
 * from `context.<field>` rather than from filter/query/data stamping.
 */
function stashTenantFields(request: RequestWithExtras, resolved: Record<string, string>): void {
  if (Object.keys(resolved).length === 0) return;
  const target = request as RequestWithExtras & { _tenantFields?: AnyRecord };
  target._tenantFields = { ...(target._tenantFields ?? {}), ...resolved };
}

/** Resolve every spec — returns the partial map of fields that have a value. */
function resolveAll(
  scope: RequestScope,
  specs: readonly TenantFieldSpec[],
): { resolved: Record<string, string>; missing: string[] } {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const spec of specs) {
    const value = resolveSpec(scope, spec);
    if (value !== undefined) {
      resolved[spec.field] = value;
    } else {
      missing.push(spec.field);
    }
  }
  return { resolved, missing };
}

/**
 * Create tenant filter middleware (strict).
 * Walks the configured tenant fields and applies all of them in lockstep.
 * Fails closed if any non-elevated caller is missing a required dimension.
 */
function createTenantFilter(specs: readonly TenantFieldSpec[]): RouteHandler {
  return async (request: RequestWithExtras, reply: FastifyReply): Promise<void> => {
    const scope = getScope(request);

    // Elevated bypass — apply whatever resolves, skip whatever doesn't.
    // Lets a platform admin act in a partial context (e.g. org-only without
    // a specific branch) without being blocked by the multi-field policy.
    if (isElevated(scope)) {
      const { resolved } = resolveAll(scope, specs);
      if (Object.keys(resolved).length > 0) {
        request._policyFilters = { ...(request._policyFilters ?? {}), ...resolved };
        stashTenantFields(request, resolved);
      }
      return;
    }

    // Member or service (API key) bound to a tenant → must satisfy ALL
    // configured dimensions. Fail closed on any missing dimension.
    if (hasOrgAccess(scope)) {
      const { resolved, missing } = resolveAll(scope, specs);
      if (missing.length === 0) {
        request._policyFilters = { ...(request._policyFilters ?? {}), ...resolved };
        stashTenantFields(request, resolved);
        return;
      }
      // Some dimensions present, others missing → 403 with the specific
      // missing field name(s) so the developer can fix the auth bridge.
      reply.code(403).send({
        success: false,
        error: "Forbidden",
        message: `Tenant context incomplete — missing: ${missing.join(", ")}`,
      });
      return;
    }

    // authenticated / public → 401/403 (multi-tenant requires org context)
    if (scope.kind === "public") {
      reply.code(401).send({
        success: false,
        error: "Unauthorized",
        message: "Authentication required for multi-tenant resources",
      });
      return;
    }

    // authenticated but no org → 403
    reply.code(403).send({
      success: false,
      error: "Forbidden",
      message: "Organization context required for this operation",
    });
  };
}

/**
 * Create flexible tenant filter middleware (allowPublic).
 * Same policy as the strict variant for authenticated callers, but
 * allows public/unauthenticated requests through without filtering.
 */
function createFlexibleTenantFilter(specs: readonly TenantFieldSpec[]): RouteHandler {
  return async (request: RequestWithExtras, reply: FastifyReply): Promise<void> => {
    const scope = getScope(request);

    if (isElevated(scope)) {
      const { resolved } = resolveAll(scope, specs);
      if (Object.keys(resolved).length > 0) {
        request._policyFilters = { ...(request._policyFilters ?? {}), ...resolved };
        stashTenantFields(request, resolved);
      }
      return;
    }

    // Authenticated tenant caller — apply all dimensions or fail closed.
    // We don't silently skip missing dimensions here because that would
    // let an API key with partial context see data it shouldn't.
    if (hasOrgAccess(scope)) {
      const { resolved, missing } = resolveAll(scope, specs);
      if (missing.length === 0) {
        request._policyFilters = { ...(request._policyFilters ?? {}), ...resolved };
        stashTenantFields(request, resolved);
        return;
      }
      reply.code(403).send({
        success: false,
        error: "Forbidden",
        message: `Tenant context incomplete — missing: ${missing.join(", ")}`,
      });
      return;
    }

    // authenticated / public with no tenant context → allow through (public data)
    return;
  };
}

/**
 * Create tenant injection middleware.
 * Walks the configured tenant fields and writes each into the request body.
 * Fails closed if any required dimension is missing for non-elevated callers.
 *
 * Also stashes the resolved fields on `request._tenantFields` so
 * `BaseController.tenantRepoOptions()` can forward them to the repo layer
 * as top-level options — needed by plugin-scoped repos like mongokit's
 * `multiTenantPlugin`, which reads tenant from `context.<field>` rather
 * than from `data.<field>`. Without this forwarding, multi-field preset
 * writes (update/delete) work only when the plugin's `allowDataInjection`
 * fallback covers the operation's policy key, which is write-only.
 */
function createTenantInjection(specs: readonly TenantFieldSpec[]): RouteHandler {
  return async (request: RequestWithExtras, reply: FastifyReply): Promise<void> => {
    const scope = getScope(request);

    // Elevated without org → skip injection (admin cross-tenant operation).
    // We use `getOrgId` here as the canonical "is this elevated admin scoped
    // to an org" check, mirroring the original single-field behavior.
    if (isElevated(scope) && !getOrgId(scope)) {
      return;
    }

    const { resolved, missing } = resolveAll(scope, specs);

    // Fail-closed: every configured field must resolve. Prevents orphaned
    // data and prevents partial-context API keys from creating cross-tenant rows.
    if (missing.length > 0) {
      reply.code(403).send({
        success: false,
        error: "Forbidden",
        message: `Tenant context incomplete — missing: ${missing.join(", ")}`,
      });
      return;
    }

    if (request.body) {
      Object.assign(request.body as AnyRecord, resolved);
    }

    // Forward to BaseController so reads/updates/deletes get tenant at the
    // top of the repo context, not just on the create payload.
    (request as RequestWithExtras & { _tenantFields?: AnyRecord })._tenantFields = {
      ...((request as RequestWithExtras & { _tenantFields?: AnyRecord })._tenantFields ?? {}),
      ...resolved,
    };
  };
}

export function multiTenantPreset(options: MultiTenantOptions = {}): PresetResult {
  const { tenantField, tenantFields, allowPublic = [] } = options;

  // Mutual exclusion — passing both is almost certainly a config bug
  if (tenantField !== undefined && tenantFields !== undefined) {
    throw new Error(
      "multiTenantPreset: pass either `tenantField` (single-field) or `tenantFields` (multi-field), not both",
    );
  }

  // Normalize both forms into a single TenantFieldSpec[] internally
  const specs: readonly TenantFieldSpec[] = tenantFields ?? [
    { field: tenantField ?? DEFAULT_TENANT_FIELD, type: "org" },
  ];

  // Validate the resolved spec list
  if (specs.length === 0) {
    throw new Error("multiTenantPreset: `tenantFields` must contain at least one entry");
  }

  // Create middleware variants
  const strictTenantFilter = createTenantFilter(specs);
  const flexibleTenantFilter = createFlexibleTenantFilter(specs);
  const tenantInjection = createTenantInjection(specs);

  // Helper to select appropriate filter based on allowPublic
  const getFilter = (route: CrudRouteKey): RouteHandler =>
    allowPublic.includes(route) ? flexibleTenantFilter : strictTenantFilter;

  return {
    name: "multiTenant",
    middlewares: {
      list: [getFilter("list")],
      get: [getFilter("get")],
      create: [tenantInjection],
      // UPDATE runs BOTH: filter pins the lookup to the caller's tenant,
      // and injection overwrites any attacker-supplied `organizationId` in
      // the body. Without injection on update a member can hop their own
      // document to another tenant by sending `{ organizationId: <other> }`.
      update: [getFilter("update"), tenantInjection],
      delete: [getFilter("delete")],
    } as MiddlewareConfig,
  };
}
