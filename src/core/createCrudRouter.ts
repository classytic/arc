/**
 * CRUD Router Factory
 *
 * Creates standard REST routes with permission-based access control.
 * Delegates all cross-cutting concerns (auth, permission, pipeline,
 * preHandler composition, response shaping) to `routerShared` so the
 * action router (`createActionRouter`) wires the exact same ingredients.
 *
 * Features:
 * - Permission-based access control via PermissionCheck functions
 * - Multi-tenant scoping via multiTenant preset
 * - Consistent route patterns
 * - Framework-agnostic controllers via adapter pattern
 */

import type { RouteHandlerMethod } from "fastify";

import { CRUD_OPERATIONS, DEFAULT_UPDATE_METHOD } from "../constants.js";
import type { PermissionCheck } from "../permissions/types.js";
import type { PipelineConfig } from "../pipeline/types.js";
import type { ControllerHandler } from "../types/handlers.js";
import type {
  CrudController,
  CrudRouterOptions,
  FastifyWithDecorators,
  IController,
  IControllerResponse,
  IRequestContext,
  RouteDefinition,
} from "../types/index.js";
import { getDefaultCrudSchemas } from "../utils/responseSchemas.js";
import { convertRouteSchema } from "../utils/schemaConverter.js";
import { createCrudHandlers, createFastifyHandler } from "./fastifyAdapter.js";
import {
  buildArcDecorator,
  buildAuthMiddleware,
  buildCrudPermissionMw,
  buildPipelineHandler,
  buildPreHandlerChain,
  buildRateLimitConfig,
  type PreHandlerHook,
  type RouteRateLimitConfig,
  type RouterPluginMw,
  resolvePipelineSteps,
  resolveRoutePreHandlers,
  resolveRouterPluginMw,
  selectPluginMw,
} from "./routerShared.js";

// ============================================================================
// Custom route registration
// ============================================================================

/**
 * Mount custom routes (from presets or user-defined `routes`) on Fastify.
 * `wrapHandler` is derived inline from `!route.raw`.
 */
function createCustomRoutes<TDoc = unknown>(
  fastify: FastifyWithDecorators,
  routes: readonly RouteDefinition[],
  controller: CrudController<TDoc> | undefined,
  options: {
    tag: string;
    resourceName: string;
    arcDecorator: RouteHandlerMethod;
    rateLimitConfig?: RouteRateLimitConfig;
    pluginMw: RouterPluginMw;
    pipeline?: PipelineConfig;
    routeGuards: RouteHandlerMethod[];
  },
): void {
  const { tag, resourceName, arcDecorator, rateLimitConfig, pluginMw, pipeline, routeGuards } =
    options;

  for (const route of routes) {
    // Derive logical operation name for pipeline keys and permission actions.
    // Priority: explicit operation > handler name (string) > method+path slug
    const opName =
      route.operation ??
      (typeof route.handler === "string"
        ? route.handler
        : `${route.method.toLowerCase()}${route.path.replace(/[/:]/g, "_")}`);

    // Derive pipeline wrapping from `raw`: `raw: true` → no wrap;
    // anything else (default) → arc pipeline wraps the handler.
    const wrapHandler = !route.raw;

    let handler: RouteHandlerMethod;

    if (typeof route.handler === "string") {
      // String handlers require a controller
      if (!controller) {
        throw new Error(
          `Route ${route.method} ${route.path}: string handler '${route.handler}' requires a controller. ` +
            "Either provide a controller or use a function handler instead.",
        );
      }
      const ctrl = controller as unknown as Record<string, unknown>;
      const method = ctrl[route.handler];
      if (typeof method !== "function") {
        throw new Error(`Handler '${route.handler}' not found on controller`);
      }
      const boundMethod = (method as Function).bind(controller);

      if (wrapHandler) {
        const steps = resolvePipelineSteps(pipeline, opName);
        handler =
          steps.length > 0
            ? buildPipelineHandler(
                boundMethod as (ctx: IRequestContext) => Promise<IControllerResponse<unknown>>,
                steps,
                opName,
                resourceName,
              )
            : createFastifyHandler(boundMethod as ControllerHandler);
      } else {
        handler = boundMethod as RouteHandlerMethod;
      }
    } else {
      // Function handler
      if (wrapHandler) {
        const steps = resolvePipelineSteps(pipeline, opName);
        handler =
          steps.length > 0
            ? buildPipelineHandler(
                route.handler as (ctx: IRequestContext) => Promise<IControllerResponse<unknown>>,
                steps,
                opName,
                resourceName,
              )
            : createFastifyHandler(route.handler as ControllerHandler);
      } else {
        handler = route.handler as RouteHandlerMethod;
      }
    }

    // Build schema with tags (auto-convert Zod schemas, no-op for JSON Schema)
    const routeTags = route.tags ?? (tag ? [tag] : undefined);
    const convertedSchema = route.schema ? convertRouteSchema(route.schema) : undefined;
    const schema = {
      ...(routeTags ? { tags: routeTags } : {}),
      ...(route.summary ? { summary: route.summary } : {}),
      ...(route.description ? { description: route.description } : {}),
      ...(convertedSchema ?? {}),
    } as Record<string, unknown>;

    // Resolve preHandler — accepts an array OR a `(fastify) => array` factory.
    // The shared resolver (a) discriminates the two valid shapes by `typeof`,
    // (b) validates a factory's RETURN is actually an array, and (c) throws an
    // actionable error pointing at the route + the canonical fix when a single
    // `RouteHandlerMethod` (e.g. `multipartBody({...})`) was passed where an
    // array was expected. Pre-2.11.3 the bare-handler mistake produced a
    // cryptic `Cannot read properties of undefined (reading 'content-type')`
    // because the handler ran with `fastify` in the request slot.
    const customPreHandlers = resolveRoutePreHandlers(
      route.preHandler,
      fastify,
      `${route.method} ${route.path}`,
    );

    // preAuth runs BEFORE auth — for token promotion (e.g., EventSource ?token= → Authorization)
    const preAuthHandlers = (route as { preAuth?: PreHandlerHook[] }).preAuth ?? [];

    const preHandler = buildPreHandlerChain({
      preAuth: preAuthHandlers,
      arcDecorator,
      authMw: buildAuthMiddleware(fastify, route.permissions),
      permissionMw: buildCrudPermissionMw(route.permissions, resourceName, opName),
      pluginMw: selectPluginMw(route.method, pluginMw),
      routeGuards,
      customMws: customPreHandlers,
    });

    // streamResponse: true → SSE headers + bypass Arc response wrapper
    const isStream = (route as { streamResponse?: boolean }).streamResponse === true;

    fastify.route({
      method: route.method,
      url: route.path,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schema: schema as Record<string, any>, // Fastify RouteOptions.schema requires this shape
      preHandler: preHandler.length > 0 ? (preHandler as any) : undefined,
      handler: isStream
        ? async (request, reply) => {
            reply.raw.setHeader("Content-Type", "text/event-stream");
            reply.raw.setHeader("Cache-Control", "no-cache");
            reply.raw.setHeader("Connection", "keep-alive");
            return (handler as (req: unknown, rep: unknown) => unknown)(request, reply);
          }
        : handler,
      ...(rateLimitConfig ? { config: rateLimitConfig } : {}),
    });
  }
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Create CRUD routes for a controller.
 *
 * @param fastify    - Fastify instance with Arc decorators
 * @param controller - CRUD controller with handler methods (optional when
 *                     `disableDefaultRoutes: true` and only custom `routes`
 *                     are being registered)
 * @param options    - Router configuration
 */
export function createCrudRouter<TDoc = unknown>(
  fastify: FastifyWithDecorators,
  controller: CrudController<TDoc> | undefined,
  options: CrudRouterOptions = {},
): void {
  const {
    tag = "Resource",
    schemas = {},
    permissions = {},
    middlewares = {},
    routeGuards = [],
    routes: customRoutes = [],
    disableDefaultRoutes = false,
    disabledRoutes = [],
    resourceName = "unknown",
    schemaOptions,
    rateLimit,
    pipe: pipeline,
    fields: fieldPermissions,
    updateMethod = DEFAULT_UPDATE_METHOD,
    // Surfaces on `req.arc.idField` for every CRUD route — handlers
    // and downstream middleware compose `findOne` filters via
    // `getEntityQuery(req)` without re-reading resource config.
    idField,
  } = options;

  const rateLimitConfig = buildRateLimitConfig(rateLimit);

  // Resolve cache/idempotency plugin middlewares once.
  // Skip response-cache when the resource has QueryCache active — QueryCache
  // handles caching at the controller level with SWR; a second HTTP-level
  // cache would double-cache.
  const resourceHasQueryCache =
    fastify.hasDecorator("queryCache") &&
    controller &&
    typeof (controller as unknown as Record<string, unknown>)._cacheConfig !== "undefined" &&
    (controller as unknown as Record<string, unknown>)._cacheConfig !== undefined;
  const pluginMw = resolveRouterPluginMw(fastify, Boolean(resourceHasQueryCache));

  // Arc metadata decorator — stamps `req.arc` with resource-scoped wiring.
  const arcDecorator = buildArcDecorator({
    resourceName,
    schemaOptions,
    permissions,
    hooks: fastify.arc?.hooks,
    events: fastify.events,
    fields: fieldPermissions,
    idField,
  });

  // Per-op middlewares (user-declared route guards for individual CRUD ops)
  const mw = {
    list: (middlewares.list ?? []) as RouteHandlerMethod[],
    get: (middlewares.get ?? []) as RouteHandlerMethod[],
    create: (middlewares.create ?? []) as RouteHandlerMethod[],
    update: (middlewares.update ?? []) as RouteHandlerMethod[],
    delete: (middlewares.delete ?? []) as RouteHandlerMethod[],
  };

  // ID params schema
  const idParamsSchema = {
    type: "object" as const,
    properties: { id: { type: "string" as const } },
    required: ["id" as const],
  };

  // Default response/querystring schemas for fast-json-stringify serialization
  const defaultSchemas = getDefaultCrudSchemas();

  /**
   * Merge: base (tags/summary) → defaults (response/querystring) → user overrides.
   * User-provided schemas always win; defaults enable fast-json-stringify when
   * no user schema is set.
   */
  const buildSchema = (
    base: Record<string, unknown>,
    defaults: Record<string, unknown> | undefined,
    userSchema?: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...defaults,
    ...base,
    ...(userSchema ?? {}),
  });

  // Default CRUD routes
  //
  // Every CRUD route shares the same shape: disabled check → arc decorator →
  // auth → permission → (cache | idempotency) → route guards → per-op
  // middlewares → handler, with rate-limit config applied uniformly. Only a
  // handful of fields differ per op (HTTP method, URL, summary, id params,
  // which cross-cutting middlewares apply). The table below drives
  // registration from those fields so any future cross-cutting concern
  // touches ONE block instead of five.
  if (!disableDefaultRoutes) {
    // Controller is required when default CRUD routes are enabled. When only
    // custom routes are declared, hosts pass `disableDefaultRoutes: true`.
    if (!controller) {
      throw new Error(
        "Controller is required when disableDefaultRoutes is not true. " +
          "Provide a controller or use defineResource which auto-creates BaseController.",
      );
    }

    const ctrl = controller as IController<TDoc>;

    // Wrap handlers with pipeline execution when configured.
    const handlers = buildCrudHandlers(ctrl, pipeline, resourceName);

    type CrudOp = "list" | "get" | "create" | "update" | "delete";
    type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    interface CrudRouteSpec {
      op: CrudOp;
      method: HttpMethod;
      url: "/" | "/:id";
      summary: string;
      hasIdParams: boolean;
    }

    const crudTable: readonly CrudRouteSpec[] = [
      { op: "list", method: "GET", url: "/", summary: `List ${tag}`, hasIdParams: false },
      { op: "get", method: "GET", url: "/:id", summary: `Get ${tag} by ID`, hasIdParams: true },
      { op: "create", method: "POST", url: "/", summary: `Create ${tag}`, hasIdParams: false },
      {
        op: "update",
        method: "PATCH", // overridden below per updateMethod config
        url: "/:id",
        summary: `Update ${tag}`,
        hasIdParams: true,
      },
      {
        op: "delete",
        method: "DELETE",
        url: "/:id",
        summary: `Delete ${tag}`,
        hasIdParams: true,
      },
    ];

    for (const spec of crudTable) {
      if (disabledRoutes.includes(spec.op)) continue;

      const permission = permissions[spec.op];

      const preHandler = buildPreHandlerChain({
        arcDecorator,
        authMw: buildAuthMiddleware(fastify, permission),
        permissionMw: buildCrudPermissionMw(permission, resourceName, spec.op),
        pluginMw: selectPluginMw(spec.method, pluginMw),
        routeGuards,
        customMws: mw[spec.op],
      });

      // `update` is the only op that registers multiple methods: PUT
      // (replace semantics), PATCH (partial update), or both. Every other
      // op is a single-method registration.
      const methodsToRegister: HttpMethod[] =
        spec.op === "update"
          ? updateMethod === "both"
            ? ["PUT", "PATCH"]
            : [updateMethod]
          : [spec.method];

      for (const method of methodsToRegister) {
        const summary =
          spec.op === "update" ? `${method === "PUT" ? "Replace" : "Update"} ${tag}` : spec.summary;

        fastify.route({
          method,
          url: spec.url,
          schema: buildSchema(
            {
              tags: [tag],
              summary,
              ...(spec.hasIdParams ? { params: idParamsSchema } : {}),
            },
            defaultSchemas[spec.op],
            schemas[spec.op] as Record<string, unknown> | undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ) as Record<string, any>,
          preHandler: preHandler.length > 0 ? (preHandler as any) : undefined,
          handler: handlers[spec.op],
          ...(rateLimitConfig ? { config: rateLimitConfig } : {}),
        });
      }
    }
  }

  // Custom routes (presets and user-declared). These work independently of
  // CRUD — `disableDefaultRoutes: true` with `routes: [...]` is the
  // first-class "custom routes only" configuration for resources that need
  // action endpoints, stats/aggregates, or operations that don't fit CRUD.
  if (customRoutes.length > 0) {
    createCustomRoutes(fastify, customRoutes, controller, {
      tag,
      resourceName,
      arcDecorator,
      rateLimitConfig,
      pluginMw,
      pipeline,
      routeGuards,
    });
  }
}

// ============================================================================
// Internal — CRUD handler wiring with optional pipeline
// ============================================================================

function buildCrudHandlers<TDoc>(
  ctrl: IController<TDoc>,
  pipeline: PipelineConfig | undefined,
  resourceName: string,
): ReturnType<typeof createCrudHandlers<TDoc>> {
  const standardHandlers = createCrudHandlers(ctrl);
  if (!pipeline) return standardHandlers;

  const wrapped = { ...standardHandlers } as Record<string, RouteHandlerMethod>;
  for (const op of CRUD_OPERATIONS) {
    const steps = resolvePipelineSteps(pipeline, op);
    if (steps.length === 0) continue;
    const method = ctrl[op].bind(ctrl) as (
      ctx: IRequestContext,
    ) => Promise<IControllerResponse<unknown>>;
    wrapped[op] = buildPipelineHandler(method, steps, op, resourceName);
  }
  return wrapped as ReturnType<typeof createCrudHandlers<TDoc>>;
}

// ============================================================================
// Public helper re-export (kept for host-level custom route registration)
// ============================================================================

/**
 * Build a permission middleware from a PermissionCheck — useful when hosts
 * register their own routes outside the resource system but still want to
 * evaluate permissions through the shared applicator.
 */
export function createPermissionMiddleware(
  permission: PermissionCheck,
  resourceName: string,
  action: string,
): RouteHandlerMethod | null {
  return buildCrudPermissionMw(permission, resourceName, action);
}
