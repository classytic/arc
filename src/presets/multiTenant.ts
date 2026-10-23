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
import {
  applyTenantPreparation,
  type TenantFieldSpec,
  type TenantPreparationMode,
  tagTenantPreparation,
} from "../permissions/tenantPreparation.js";
import { getRequestScope as getScope } from "../scope/types.js";
import type {
  CrudRouteKey,
  MiddlewareConfig,
  PresetResult,
  RequestWithExtras,
  RouteHandler,
  RouteSchemaOptions,
} from "../types/index.js";
import { ArcError } from "../utils/errors.js";

/**
 * One tenant dimension for multi-field filtering. Discriminated by source:
 * - `type: 'org'`  → reads `getOrgId(scope)`
 * - `type: 'team'` → reads `getTeamId(scope)`
 * - `contextKey`   → reads `getScopeContext(scope, contextKey)` (any custom dimension)
 */
export type { TenantFieldSpec } from "../permissions/tenantPreparation.js";

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

  /**
   * Reads that are NOT scoped to a tenant at all — a marketplace listing.
   *
   * `allowPublic` answers "may an anonymous caller reach this route?". That is a different
   * question from "is this listing scoped to a tenant?", and until this option there was no way
   * to answer the second one with "no". An `allowPublic` route still filters by the caller's
   * organization whenever they have one, and a signed-in user of a multi-org product ALWAYS has
   * one, because choosing an organization writes it onto the session. So a cross-tenant catalog
   * silently became single-tenant the moment one of its own sellers browsed it: the same URL,
   * with no header and no query parameter to explain the difference, returned a different world
   * depending on who was asking.
   *
   * The only escape was to drop this preset from the resource entirely, which also drops tenant
   * INJECTION on create/update — the thing that stops a member moving a document into another
   * organization. Trading a write guarantee for a read behaviour is not a real choice.
   *
   * Listed routes get no tenant middleware: no filter, and nothing stashed for the repo layer.
   * Everything else keeps its filter, so writes are unaffected.
   *
   * READS ONLY, by type. A cross-tenant `create` or `update` is not a listing, it is an escape
   * from tenancy, and it should never be one option away by accident.
   *
   * THIS DOES NOT AUTHORIZE ANYTHING. Removing the tenant filter widens what the query can
   * return, so the resource owes a row-level `policy` from its permission check saying what a
   * stranger may see (`{ status: 'active' }`, `{ visibility: 'public' }`). Declaring this without
   * one publishes every row in every tenant.
   *
   * @default []
   * @example
   * // A public catalog: anyone may browse every seller's LIVE products,
   * // while create/update/delete stay pinned to the caller's own shop.
   * multiTenantPreset({
   *   allowPublic: ['list', 'get'],
   *   crossTenant: ['list', 'get'],
   * })
   */
  crossTenant?: readonly Extract<CrudRouteKey, "list" | "get">[];
}

function createTenantMiddleware(
  specs: readonly TenantFieldSpec[],
  mode: TenantPreparationMode,
): RouteHandler {
  const preparation = { specs, mode };
  const middleware: RouteHandler = async (
    request: RequestWithExtras,
    reply: FastifyReply,
  ): Promise<void | FastifyReply> => {
    try {
      applyTenantPreparation(request, request.body, getScope(request), preparation);
    } catch (error) {
      if (!(error instanceof ArcError)) throw error;
      reply.code(error.status).send({
        success: false,
        error: error.status === 401 ? "Unauthorized" : "Forbidden",
        message: error.message,
      });
      return reply;
    }
  };
  return tagTenantPreparation(middleware, preparation);
}

export function multiTenantPreset(options: MultiTenantOptions = {}): PresetResult {
  const { tenantField, tenantFields, allowPublic = [], crossTenant = [] } = options;

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
  const strictTenantFilter = createTenantMiddleware(specs, "strict");
  const flexibleTenantFilter = createTenantMiddleware(specs, "flexible");
  const tenantInjection = createTenantMiddleware(specs, "inject");

  // Helper to select appropriate filter based on allowPublic
  const getFilter = (route: CrudRouteKey): RouteHandler =>
    allowPublic.includes(route) ? flexibleTenantFilter : strictTenantFilter;

  /**
   * A cross-tenant read MARKS the request rather than simply skipping the filter.
   *
   * Skipping is not enough, because this middleware is only the first of four places that scope a
   * read, and the other three each re-derive the organization from the request scope on their own:
   * `QueryResolver` adds the tenant filter for `list`, `buildTenantRepoOptions` forwards it to the
   * repository as tenant context, and `checkOrgScope` re-checks it post-fetch on `get`. Removing
   * one of four changes nothing observable, which is exactly what made this look unfixable from the
   * preset: the listing stayed single-tenant no matter what the preset decided.
   *
   * So the decision travels on the request instead, and each of those layers honours it. The
   * repository layer needs no change of its own — kits already accept `bypassTenant`, which is the
   * same door elevated cross-tenant reads have always used.
   */
  const markCrossTenantRead = createTenantMiddleware(specs, "crossTenant");
  const readMiddleware = (route: Extract<CrudRouteKey, "list" | "get">): RouteHandler[] =>
    crossTenant.includes(route) ? [markCrossTenantRead] : [getFilter(route)];

  // v2.11.0 — declare `systemManaged: true` on every tenant dimension so
  // the adapter-generated body schema strips them from `required[]` and
  // `BodySanitizer` strips them from inbound member bodies. Closes the
  // `@classytic/primitives` engine-default `required: true` conflict:
  // Fastify preValidation used to reject `POST /pricelists` with
  // `must have required property 'organizationId'` even though the client
  // correctly passed `x-organization-id` and `multiTenantPreset` was
  // about to inject the value. `preserveForElevated: true` keeps the
  // elevated-admin-picks-org-via-body channel open.
  //
  // Hosts that declared `tenantField` at the resource level ALSO get
  // these rules via `autoInjectTenantFieldRules` in `defineResource`;
  // both paths converge on the same `resolvedConfig.schemaOptions.fieldRules`
  // shape — defense in depth.
  // Type mirrors the inline shape on `RouteSchemaOptions.fieldRules` —
  // the exported `FieldRule` type is a leaner variant that doesn't carry
  // `systemManaged` / `preserveForElevated`, so it's not usable here.
  type FieldRuleEntry = NonNullable<RouteSchemaOptions["fieldRules"]>[string];
  const fieldRules: Record<string, FieldRuleEntry> = {};
  for (const spec of specs) {
    fieldRules[spec.field] = {
      systemManaged: true,
      preserveForElevated: true,
    };
  }

  return {
    name: "multiTenant",
    schemaOptions: { fieldRules },
    middlewares: {
      list: readMiddleware("list"),
      get: readMiddleware("get"),
      create: [tenantInjection],
      // UPDATE runs BOTH: filter pins the lookup to the caller's tenant,
      // and injection overwrites any attacker-supplied `organizationId` in
      // the body. Without injection on update a member can hop their own
      // document to another tenant by sending `{ organizationId: <other> }`.
      update: [getFilter("update"), tenantInjection],
      delete: [getFilter("delete")],
      // 2.15.3 — wire `/aggregations/:name` routes to the same strict
      // tenant filter the CRUD list uses. Pre-2.15.3 the preset emitted
      // no `aggregations` slot, so `req._tenantFields` was never set on
      // aggregation routes and `tenantRepoOptions`'s path-2 fallback
      // didn't fire — the AggRequest reached the kit with no orgId
      // and returned every org's rows. Always strict here (no
      // `flexibleTenantFilter` analog) — aggregations have no
      // public-list semantic; if the host wants public aggregation
      // they'd declare a permissions-level `allowPublic` AND not use
      // `multiTenantPreset` for that resource.
      aggregations: [strictTenantFilter],
      // 2.15.5 — opt-in slot for custom routes via `tenantScope: true`
      // on a `RouteDefinition`. Mirrors the `update` slot (filter +
      // injection) so a custom POST/PATCH route gets the same
      // protection as auto-CRUD: filter pins reads/lookups to the
      // caller's tenant, injection stamps the body so a member can't
      // hop their write to another tenant by spoofing the field. The
      // handler reads the resolved tenant via `getOrgId(req.scope)` or
      // `req._tenantFields` without re-implementing the scope-read +
      // header-fallback boilerplate. Always strict — `tenantScope` is
      // an explicit opt-in; if the host wants the route reachable
      // without tenant context they wouldn't set the flag.
      tenantScope: [strictTenantFilter, tenantInjection],
    } as MiddlewareConfig,
  };
}
