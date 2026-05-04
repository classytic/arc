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

import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import type { FieldPermissionMap } from "../../permissions/fields.js";
import type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
} from "../../permissions/types.js";
import type { FastifyWithDecorators } from "../../types/fastify.js";
import type { AnyRecord, RouteSchemaOptions, UserBase } from "../../types/index.js";
import { createError, ForbiddenError, UnauthorizedError } from "../../utils/errors.js";
import {
  buildArcDecorator,
  buildAuthMiddleware,
  buildPreHandlerChain,
  buildRateLimitConfig,
  resolveRouterPluginMw,
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
}

function registerOne(
  fastify: FastifyWithDecorators,
  normalized: NormalizedAggregation,
  ctx: RegisterOneCtx,
): void {
  const { tag, arcDecorator, routeGuards, repository, buildOptions } = ctx;
  const { name } = normalized;
  const config = normalized.base;

  // Per-aggregation auth — derived from the declaration's permissions.
  const authMw = buildAuthMiddleware(fastify, config.permissions);

  // Per-aggregation permission gate. Aggregations don't use the CRUD
  // permission helper because there's no `op` concept here — the check
  // is the declaration's own `permissions` function applied to the
  // request scope. Returns can be `boolean` (legacy) or
  // `PermissionResult` (with `reason`/`filters`/`scope`); both shapes
  // normalize through `normalizePermissionResult`.
  const permissionFn = config.permissions;
  const permissionMw: RouteHandlerMethod = async (req, _reply): Promise<void> => {
    const ctx = buildPermissionContextLite(req, normalized.name);
    const raw = await permissionFn(ctx);
    const granted = normalizePermissionGranted(raw);
    if (!granted) {
      const status = (req as { user?: unknown }).user ? 403 : 401;
      const reason = normalizePermissionReason(raw);
      if (status === 401) {
        throw new UnauthorizedError(
          reason ?? "Authentication required to access this aggregation.",
        );
      }
      throw new ForbiddenError(reason ?? "You do not have permission to access this aggregation.");
    }
  };

  // Cache / idempotency middleware — read paths only. Aggregations are
  // GET-shape so we pull just the cache middleware via selectPluginMw.
  const pluginMwAll = resolveRouterPluginMw(fastify, /* resourceHasQueryCache */ false);
  const pluginMw = selectPluginMw("GET", pluginMwAll);

  const preHandler = buildPreHandlerChain({
    arcDecorator,
    authMw,
    permissionMw,
    pluginMw,
    routeGuards,
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
    // biome-ignore lint/suspicious/noExplicitAny: Fastify schema type
    schema: routeSchema as any,
    // biome-ignore lint/suspicious/noExplicitAny: Fastify preHandler type
    preHandler: preHandler.length > 0 ? (preHandler as any) : undefined,
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
    request: req,
    resource: reqWithExtras.arc?.resource ?? "aggregation",
    action: `aggregation:${aggregationName}`,
  };
}

/** PermissionCheck returns `boolean | PermissionResult`. Pull `granted`. */
function normalizePermissionGranted(raw: boolean | PermissionResult): boolean {
  if (typeof raw === "boolean") return raw;
  return raw.granted;
}

/** Pull `reason` when the check returned a structured `PermissionResult`. */
function normalizePermissionReason(raw: boolean | PermissionResult): string | undefined {
  if (typeof raw === "boolean") return undefined;
  return raw.reason;
}
