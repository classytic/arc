/**
 * `createAggregationRouter` — registers `GET /aggregations/:name`
 * routes for every entry in a resource's `aggregations` map.
 *
 * Each aggregation gets its own Fastify route with its own permission
 * check, rate limit, and cache config — but shares the cross-cutting
 * arc primitives (arc decorator → auth → permission → plugin
 * middleware → route guards) with CRUD and actions. Same wiring,
 * registered through `routerShared` helpers.
 *
 * Registered routes:
 *
 *   - `GET /:resource/aggregations/<name>` per aggregation
 *
 * Response wire shape (`{ rows: [...] }`) matches `AggResult` so
 * frontend code reads dashboards with the same envelope across kits.
 */

import type { FastifyReply, FastifyRequest, FastifySchema, RouteHandlerMethod } from "fastify";
import { evaluateAndApplyPermission } from "../../permissions/authorizationDecision.js";
import type { FieldPermissionMap } from "../../permissions/fields.js";
import type { PermissionCheck, PermissionContext } from "../../permissions/types.js";
import { getRequestScope } from "../../scope/types.js";
import type { FastifyWithDecorators } from "../../types/fastify.js";
import type { AnyRecord, RouteSchemaOptions, UserBase } from "../../types/index.js";
import { createError } from "../../utils/errors.js";
import {
  buildArcDecorator,
  buildAuthMiddleware,
  buildRateLimitConfig,
  buildRouteHooks,
  resolveRouterPluginMw,
  routeHookOptions,
  selectPluginMw,
} from "../routerShared.js";
import { buildAggregationHandler } from "./buildHandler.js";
import type { AggregationsMap } from "./types.js";
import { type NormalizedAggregation, validateAggregations } from "./validate.js";

export interface AggregationRouterConfig {
  /** OpenAPI tag for the resource. */
  tag?: string;
  /** Resource name — used for arc decorator + audit logs. */
  resourceName: string;
  /** Map of name → declaration. */
  aggregations: AggregationsMap;
  /**
   * Resource-level field permission map. Threaded through the arc
   * decorator so field masking applies to aggregation results too —
   * hidden fields don't leak via measure values.
   */
  fields?: FieldPermissionMap;
  /** Resource schema options (used by validation + arc decorator). */
  schemaOptions?: RouteSchemaOptions;
  /** Resource-level CRUD permissions (NOT used for aggregation auth). */
  permissions?: Record<string, PermissionCheck>;
  /** Resource-level route guards. */
  routeGuards?: ReadonlyArray<RouteHandlerMethod | null | undefined>;
  /**
   * Repository instance — must implement `aggregate?()` per
   * `StandardRepo`. Adapter feature-detect runs at request time;
   * missing `aggregate` returns 501.
   */
  repository: unknown;
  /**
   * Tenant + audit options builder. Same one BaseCrudController
   * uses, exposed via the controller. Threads orgId / userId / user /
   * requestId into every kit call.
   */
  buildOptions: (req: FastifyRequest) => AnyRecord;
  /**
   * Resource-level middlewares for the aggregation slot. Pre-2.15.3
   * the aggregation router never received resource middlewares — the
   * `multiTenantPreset` correctly emitted `list/get/create/update/delete`
   * tenant filters but had no `aggregations` slot, so its preHandler
   * never ran on aggregation routes and `req._tenantFields` was empty.
   * `tenantRepoOptions`'s path-2 fallback then didn't populate
   * `organizationId` for callers whose `scope.kind !== 'member'`,
   * leaking aggregated rows across orgs. 2.15.3 wires the slot.
   *
   * Applied as `customMws` in the preHandler chain — runs AFTER auth
   * + permission (so the tenant filter sees an authenticated scope),
   * BEFORE the aggregation handler.
   */
  middlewares?: ReadonlyArray<RouteHandlerMethod | null | undefined>;
}

/**
 * Register one Fastify route per aggregation. No-op when the map is
 * empty — same convention `createActionRouter` follows.
 */
export function createAggregationRouter(
  fastify: FastifyWithDecorators,
  config: AggregationRouterConfig,
): void {
  const {
    tag,
    resourceName,
    aggregations,
    fields: fieldPermissions,
    schemaOptions,
    permissions: resourcePermissions,
    routeGuards = [],
    repository,
    buildOptions,
    middlewares = [],
  } = config;

  if (!aggregations || Object.keys(aggregations).length === 0) {
    return;
  }

  // Boot-time validation — throws on misconfig with the offending
  // aggregation name. Caller (defineResource) catches and re-throws
  // with resource context.
  const normalized = validateAggregations(resourceName, aggregations, schemaOptions);

  // Shared arc decorator — same wiring CRUD + actions use, so field
  // masking and audit attribution flow through identically.
  const arcDecorator = buildArcDecorator({
    resourceName,
    schemaOptions,
    permissions: resourcePermissions,
    hooks: fastify.arc?.hooks,
    events: fastify.events,
    fields: fieldPermissions,
  });

  for (const aggregation of normalized) {
    registerOne(fastify, aggregation, {
      tag,
      arcDecorator,
      routeGuards,
      repository,
      buildOptions,
      middlewares,
    });
  }

  fastify.log?.debug?.(
    {
      aggregations: normalized.map((a) => a.name),
      resourceName,
    },
    `[createAggregationRouter] registered ${normalized.length} aggregation route(s)`,
  );
}

// ──────────────────────────────────────────────────────────────────────
// Internal — single-route registration
// ──────────────────────────────────────────────────────────────────────

interface RegisterOneCtx {
  tag: string | undefined;
  arcDecorator: RouteHandlerMethod;
  routeGuards: ReadonlyArray<RouteHandlerMethod | null | undefined>;
  repository: unknown;
  buildOptions: (req: FastifyRequest) => AnyRecord;
  /** Preset-emitted preHandlers for the aggregation slot (2.15.3). */
  middlewares: ReadonlyArray<RouteHandlerMethod | null | undefined>;
}

function registerOne(
  fastify: FastifyWithDecorators,
  normalized: NormalizedAggregation,
  ctx: RegisterOneCtx,
): void {
  const { tag, arcDecorator, routeGuards, repository, buildOptions, middlewares } = ctx;
  const { name } = normalized;
  const config = normalized.base;

  // Per-aggregation auth — derived from the declaration's permissions.
  const authMw = buildAuthMiddleware(fastify, config.permissions);

  // Per-aggregation permission gate. Aggregations have no `op`, so the gate
  // is the declaration's own `permissions` check applied to the request scope.
  // It runs through the SAME evaluation + enforcement seam as CRUD/actions:
  // normalize to an AuthorizationDecision, fail closed on deny, and on allow
  // apply the decision's `scope` + `policy` onto the request via
  // `applyAuthorizationDecision` — so a permission that restricts CRUD reads
  // restricts aggregation queries identically (the handler threads
  // `request._policyFilters` into the aggregation filter).
  const permissionFn = config.permissions;
  const permissionMw: RouteHandlerMethod = async (req, reply): Promise<void> => {
    const ctx = buildPermissionContextLite(req, normalized.name);
    // Delegate to the ONE shared evaluator (identical to CRUD + actions): it
    // normalizes the decision, maps thrown ArcErrors to structured responses and
    // any other throw to a fail-closed 403 (never a 500), clamps the denial
    // reason, and on allow installs the decision's scope + policy. On deny it
    // sends the reply, which short-circuits the Fastify route — the aggregation
    // handler never runs. No per-surface evaluation logic to drift.
    await evaluateAndApplyPermission(permissionFn, ctx, req, reply, {
      defaultDenialMessage: (user) =>
        user
          ? "You do not have permission to access this aggregation."
          : "Authentication required to access this aggregation.",
    });
  };

  // Cache / idempotency middleware — read paths only. Aggregations are
  // GET-shape so we pull just the cache middleware via selectPluginMw.
  const pluginMwAll = resolveRouterPluginMw(fastify, /* resourceHasQueryCache */ false);
  const pluginMw = selectPluginMw("GET", pluginMwAll);

  // Auth runs at onRequest (2.22 — before query/body validation cost for
  // anonymous callers); permission + tenant middlewares stay at preHandler.
  const hooks = buildRouteHooks({
    arcDecorator,
    authMw,
    permissionMw,
    pluginMw,
    routeGuards,
    // Preset-emitted middlewares (e.g. multiTenantPreset's tenant filter
    // for the aggregation slot). Run AFTER auth + permission so the
    // filter sees an authenticated scope, BEFORE the aggregation handler
    // so `_tenantFields` / `_policyFilters` are populated when
    // `tenantRepoOptions` reads them. (2.15.3)
    customMws: middlewares,
  });

  const rateLimitConfig = buildRateLimitConfig(
    config.rateLimit
      ? { max: config.rateLimit.max, timeWindow: `${config.rateLimit.windowMs}ms` }
      : undefined,
  );

  const handler = buildAggregationHandler(normalized, {
    repo: repository,
    buildOptions,
  });

  const routeSchema = {
    tags: tag ? [tag] : undefined,
    summary: config.summary ?? `Aggregation: ${name}`,
    description:
      config.description ??
      `Portable aggregation generated by arc. Filters from query string ` +
        `compose with the declaration's base filter + tenant scope.`,
  };

  fastify.route({
    method: "GET",
    url: `/aggregations/${name}`,
    schema: routeSchema as FastifySchema,
    ...routeHookOptions(hooks),
    ...(rateLimitConfig ? { config: rateLimitConfig } : {}),
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(req, reply);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        req.log.error({ err, aggregation: name }, "Aggregation handler error");
        throw createError(500, `Aggregation "${name}" failed: ${message}`);
      }
    },
  });
}

/**
 * Minimal `PermissionContext` for aggregation routes. Aggregations are
 * read-shape so the action is `'list'` and `data` / `resourceId` stay
 * undefined unless the URL includes them (none do today — `:name` is
 * the only path param).
 */
function buildPermissionContextLite(
  req: FastifyRequest,
  aggregationName: string,
): PermissionContext {
  const reqWithExtras = req as unknown as {
    user?: UserBase | null;
    arc?: { resource?: string };
  };
  return {
    user: reqWithExtras.user ?? null,
    scope: getRequestScope(req),
    request: req,
    resource: reqWithExtras.arc?.resource ?? "aggregation",
    action: `aggregation:${aggregationName}`,
  };
}
