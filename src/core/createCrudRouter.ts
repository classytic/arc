/**
 * CRUD Router Factory — standard REST routes plus custom routes.
 *
 * Cross-cutting concerns (auth, permission, pipeline, preHandler composition)
 * live in `routerShared` so `createActionRouter` wires the same ingredients.
 */

import type { FastifyInstance, FastifyReply, FastifySchema, RouteHandlerMethod } from "fastify";

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
  ResourceExtensions,
  RouteDefinition,
} from "../types/index.js";
import { getDefaultCrudSchemas } from "../utils/responseSchemas.js";
import { convertRouteSchema } from "../utils/schemaConverter.js";
import { isReadableStream, pipeUIMessageStreamToReply } from "../utils/streaming.js";
import { createCrudHandlers, createFastifyHandler } from "./fastifyAdapter.js";
import {
  buildArcDecorator,
  buildAuthMiddleware,
  buildCrudPermissionMw,
  buildFieldWritePreHandler,
  buildPipelineHandler,
  buildRateLimitConfig,
  buildRouteConfig,
  buildRouteHooks,
  methodCarriesBody,
  type PreHandlerHook,
  type RouteRateLimitConfig,
  type RouterPluginMw,
  resolvePipelineSteps,
  resolveRoutePreHandlers,
  resolveRouterPluginMw,
  routeHookOptions,
  selectPluginMw,
  tryRegisterRoute,
} from "./routerShared.js";

// ============================================================================
// Custom route registration
// ============================================================================

/**
 * Fold a route's host-supplied `config` together with arc's derived one into the
 * SINGLE `config` key Fastify reads. Returns arc's object untouched when the host
 * supplied none, so the route options stay literally what was declared.
 */
function mergeRouteConfig(
  hostConfig: Record<string, unknown> | undefined,
  arcConfig: { config?: Record<string, unknown> },
): { config?: Record<string, unknown> } {
  if (!hostConfig) return arcConfig;
  // Arc's keys last — see the call site for why they win a collision.
  return { config: { ...hostConfig, ...(arcConfig.config ?? {}) } };
}

/**
 * Wrap a raw handler so one that called `reply.send()` and resolved `undefined` returns the
 * reply: otherwise, while an async `preSerialization` hook (idempotency, encryption) is pending,
 * Fastify re-sends the `undefined` and the client gets an empty body.
 * Pinned by `tests/idempotency/raw-route-keyed-body.test.ts`.
 */
function keepRawReply(raw: RouteHandlerMethod): RouteHandlerMethod {
  return async function rawRoute(this: FastifyInstance, request, reply) {
    let sendCalled = false;
    const send = reply.send;
    reply.send = function trackedSend(this: FastifyReply, payload?: unknown): FastifyReply {
      sendCalled = true;
      return send.call(this, payload);
    };
    try {
      const result = await raw.call(this, request, reply);
      return result === undefined && (sendCalled || reply.sent) ? reply : result;
    } finally {
      reply.send = send;
    }
  };
}

/** Mount custom routes (from presets or user-defined `routes`) on Fastify. */
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
    /** Multi-tenant preset's `tenantScope` slot; `undefined` when no such preset is wired. */
    tenantScopeMw?: readonly RouteHandlerMethod[];
    /** Resource-level field permissions (`defineResource({ fields })`). */
    fieldPermissions?: import("../permissions/fields.js").FieldPermissionMap;
    /** Resource-level `onFieldWriteDenied` policy (default: 'reject'). */
    onFieldWriteDenied?: "reject" | "strip";
    /** Stamped onto each route's `config.arcExtensions` for request-time plugins. */
    extensions?: ResourceExtensions;
  },
): void {
  const {
    tag,
    resourceName,
    arcDecorator,
    rateLimitConfig,
    pluginMw,
    pipeline,
    routeGuards,
    tenantScopeMw,
    fieldPermissions,
    onFieldWriteDenied,
    extensions,
  } = options;

  for (const route of routes) {
    // Fatal, not ignored: a leftover `raw` flag (e.g. from a dependency's stale dist, which
    // TypeScript won't catch) would silently pipeline-wrap a Fastify-native handler.
    if ("raw" in route) {
      throw new Error(
        `Route ${route.method} ${route.path}: \`raw\` was removed in arc 2.31 — the FIELD now carries the intent. ` +
          "Move the function to `rawHandler` (Fastify-native `(request, reply)`) or leave it in `handler` " +
          "(arc pipeline, `(ctx)`), and delete the flag. If this route comes from a dependency, that package " +
          "needs a release built against arc >=2.31.",
      );
    }
    // Resolve `handler` / `rawHandler` / `controllerMethod` into ONE dispatch target first.
    const routeWithRefs = route as typeof route & {
      controllerMethod?: (controller: unknown) => unknown;
    };
    const hasHandler = route.handler !== undefined || route.rawHandler !== undefined;
    const hasControllerMethod = typeof routeWithRefs.controllerMethod === "function";
    if (hasHandler && hasControllerMethod) {
      throw new Error(
        `Route ${route.method} ${route.path}: pass either \`handler\` or \`controllerMethod\`, not both. ` +
          "Prefer `controllerMethod: (c: MyController) => c.method` for typed handler refs (TS catches typos).",
      );
    }
    if (!hasHandler && !hasControllerMethod) {
      throw new Error(
        `Route ${route.method} ${route.path}: must declare one of \`handler\` (arc pipeline), ` +
          "`rawHandler` (Fastify-native), or `controllerMethod: (c) => c.method` (typed function-ref form).",
      );
    }

    let resolvedHandler: RouteDefinition["handler"] | RouteHandlerMethod;
    if (hasControllerMethod) {
      if (!controller) {
        throw new Error(
          `Route ${route.method} ${route.path}: \`controllerMethod\` requires a controller. ` +
            "Provide one via `defineResource({ controller, … })`, or use `defineResource` with an `adapter` " +
            "so arc auto-creates a BaseController.",
        );
      }
      const referenced = routeWithRefs.controllerMethod?.(controller);
      if (typeof referenced !== "function") {
        throw new Error(
          `Route ${route.method} ${route.path}: \`controllerMethod\` did not return a function. ` +
            "Return the method itself: `controllerMethod: (c) => c.myMethod`.",
        );
      }
      resolvedHandler = (referenced as (...args: unknown[]) => unknown).bind(controller) as
        | ControllerHandler
        | RouteHandlerMethod;
    } else {
      // The field IS the declaration of which execution model this route uses.
      if (route.rawHandler && route.handler) {
        throw new Error(
          `Route ${route.method} ${route.path}: set either \`handler\` (arc pipeline) ` +
            "or `rawHandler` (Fastify-native), not both.",
        );
      }
      resolvedHandler = route.rawHandler ?? route.handler;
    }

    // Operation name for pipeline keys and permission actions:
    // explicit operation > string handler name > method+path slug.
    const opName =
      route.operation ??
      (typeof resolvedHandler === "string"
        ? resolvedHandler
        : `${route.method.toLowerCase()}${route.path.replace(/[/:]/g, "_")}`);

    // `controllerMethod` keeps the pipeline; only `rawHandler` opts out.
    const isRaw = route.rawHandler !== undefined;
    const wrapHandler = !isRaw;

    let handler: RouteHandlerMethod;

    if (typeof resolvedHandler === "string") {
      if (!controller) {
        throw new Error(
          `Route ${route.method} ${route.path}: string handler '${resolvedHandler}' requires a controller. ` +
            "Either provide a controller or use a function handler instead.",
        );
      }
      const ctrl = controller as unknown as Record<string, unknown>;
      const method = ctrl[resolvedHandler];
      if (typeof method !== "function") {
        throw new Error(`Handler '${resolvedHandler}' not found on controller`);
      }
      const boundMethod = (method as (...args: unknown[]) => unknown).bind(controller);

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
        handler = keepRawReply(boundMethod as RouteHandlerMethod);
      }
    } else {
      // Function handler (inline OR resolved-from-controllerMethod)
      if (wrapHandler) {
        const steps = resolvePipelineSteps(pipeline, opName);
        handler =
          steps.length > 0
            ? buildPipelineHandler(
                resolvedHandler as (ctx: IRequestContext) => Promise<IControllerResponse<unknown>>,
                steps,
                opName,
                resourceName,
              )
            : createFastifyHandler(resolvedHandler as ControllerHandler);
      } else {
        handler = keepRawReply(resolvedHandler as RouteHandlerMethod);
      }
    }

    // Zod schemas are auto-converted; JSON Schema passes through.
    const routeTags = route.tags ?? (tag ? [tag] : undefined);
    const convertedSchema = route.schema ? convertRouteSchema(route.schema) : undefined;
    const schema = {
      ...(routeTags ? { tags: routeTags } : {}),
      ...(route.summary ? { summary: route.summary } : {}),
      ...(route.description ? { description: route.description } : {}),
      ...(convertedSchema ?? {}),
    } as Record<string, unknown>;

    // Array OR `(fastify) => array`; a bare handler (e.g. `multipartBody()`) throws
    // an actionable error instead of running with `fastify` in the request slot.
    const customPreHandlers = resolveRoutePreHandlers(
      route.preHandler,
      fastify,
      `${route.method} ${route.path}`,
    );

    // Prepend the preset's tenant filter + injection. Fail-fast without a preset:
    // the route would otherwise silently return all-org data.
    if (route.tenantScope === true) {
      if (!tenantScopeMw || tenantScopeMw.length === 0) {
        throw new Error(
          `Route ${route.method} ${route.path}: \`tenantScope: true\` requires a multi-tenant preset. ` +
            `Add \`multiTenantPreset()\` to the resource's \`presets\`, ` +
            `or remove the \`tenantScope\` flag from this route.`,
        );
      }
      customPreHandlers.unshift(...(tenantScopeMw as RouteHandlerMethod[]));
    }

    // Field-write permissions on body-bearing custom routes (auto-CRUD gets this via
    // `BodySanitizer`); without it custom routes accept restricted fields.
    // Opt-outs: `rawHandler`, `fieldWrite: false`.
    const shouldApplyFieldWrite =
      !isRaw &&
      (route as { fieldWrite?: boolean }).fieldWrite !== false &&
      methodCarriesBody(route.method);
    if (shouldApplyFieldWrite) {
      const fieldWriteMw = buildFieldWritePreHandler(fieldPermissions, onFieldWriteDenied);
      if (fieldWriteMw) customPreHandlers.push(fieldWriteMw);
    }

    // preAuth runs BEFORE auth — for token promotion (e.g., EventSource ?token= → Authorization)
    const preAuthHandlers = (route as { preAuth?: PreHandlerHook[] }).preAuth ?? [];

    const hooks = buildRouteHooks({
      preAuth: preAuthHandlers,
      arcDecorator,
      authMw: buildAuthMiddleware(fastify, route.permissions),
      permissionMw: buildCrudPermissionMw(route.permissions, resourceName, opName),
      pluginMw: selectPluginMw(route.method, pluginMw),
      routeGuards,
      customMws: customPreHandlers,
    });

    // streamResponse: true → SSE. The handler either writes to `reply.raw` itself,
    // or RETURNS a Web `ReadableStream` that arc pipes via `pipeUIMessageStreamToReply()`
    // (Fastify cannot serialise structured chunks).
    const isStream = (route as { streamResponse?: boolean }).streamResponse === true;

    tryRegisterRoute(
      fastify,
      {
        method: route.method,
        url: route.path,
        schema: schema as FastifySchema,
        ...routeHookOptions(hooks),
        handler: isStream
          ? async function streamRoute(this: FastifyInstance, request, reply) {
              // Pre-set on `reply.raw` for handlers that write there directly.
              reply.raw.setHeader("Content-Type", "text/event-stream");
              reply.raw.setHeader("Cache-Control", "no-cache");
              reply.raw.setHeader("Connection", "keep-alive");
              // `.call(this, …)` preserves Fastify's `this` binding so `this.myDecorator`
              // works the same with `streamResponse` on as off.
              const result = await (
                handler as (this: unknown, req: unknown, rep: unknown) => unknown
              ).call(this, request, reply);
              if (isReadableStream(result)) {
                await pipeUIMessageStreamToReply(reply, result);
                // Return `reply`, not `result`: the helper already sent, and returning
                // the stream makes Fastify send again (ERR_HTTP_HEADERS_SENT).
                return reply;
              }
              return result;
            }
          : handler,
        // ONE merged `config`: Fastify reads a single `opts.config`, so two spreads
        // writing `config` silently drop the host's. Arc's derived keys (rate limit,
        // cors, `arcExtensions`) win on collision — they come from declared fields.
        ...mergeRouteConfig(
          route.config,
          buildRouteConfig(
            route.rateLimit !== undefined ? buildRateLimitConfig(route.rateLimit) : rateLimitConfig,
            extensions,
            route.cors,
          ),
        ),
      },
      {
        resourceName,
        op: opName,
        ...(route.rateLimit && typeof route.rateLimit === "object"
          ? { rateLimitBucket: `route:${route.method}:${route.path}` }
          : {}),
      },
    );
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
    onFieldWriteDenied,
    updateMethod = DEFAULT_UPDATE_METHOD,
    // Surfaces on `req.arc.idField` (read by `getEntityQuery(req)`).
    idField,
    extensions,
    idempotency,
  } = options;

  // A fence on a route that is not mounted protects nothing — refuse it at boot.
  const idempotentOps = new Set<string>(idempotency?.required ?? []);
  for (const op of idempotentOps) {
    if (disableDefaultRoutes || disabledRoutes.includes(op as (typeof disabledRoutes)[number])) {
      throw new Error(
        `[arc] Resource "${resourceName}" declares idempotency.required '${op}', but that ` +
          "built-in route is not mounted — drop it from idempotency.required.",
      );
    }
  }

  const rateLimitConfig = buildRateLimitConfig(rateLimit);

  // Skip the HTTP response-cache when controller-level QueryCache is active (double-caching).
  const resourceHasQueryCache =
    fastify.hasDecorator("queryCache") &&
    controller &&
    typeof (controller as unknown as Record<string, unknown>)._cacheConfig !== "undefined" &&
    (controller as unknown as Record<string, unknown>)._cacheConfig !== undefined;
  const pluginMw = resolveRouterPluginMw(fastify, Boolean(resourceHasQueryCache));

  // Stamps `req.arc` with resource-scoped wiring.
  const arcDecorator = buildArcDecorator({
    resourceName,
    schemaOptions,
    permissions,
    hooks: fastify.arc?.hooks,
    events: fastify.events,
    fields: fieldPermissions,
    idField,
  });

  const mw = {
    list: (middlewares.list ?? []) as RouteHandlerMethod[],
    get: (middlewares.get ?? []) as RouteHandlerMethod[],
    create: (middlewares.create ?? []) as RouteHandlerMethod[],
    update: (middlewares.update ?? []) as RouteHandlerMethod[],
    delete: (middlewares.delete ?? []) as RouteHandlerMethod[],
  };

  // Emitted by `multiTenantPreset` for custom routes with `tenantScope: true`.
  const tenantScopeMw = middlewares.tenantScope as RouteHandlerMethod[] | undefined;

  const idParamsSchema = {
    type: "object" as const,
    properties: { id: { type: "string" as const } },
    required: ["id" as const],
  };

  // Default response/querystring schemas for fast-json-stringify serialization
  const defaultSchemas = getDefaultCrudSchemas();

  // Later wins: defaults → base (tags/summary) → user schema.
  const buildSchema = (
    base: Record<string, unknown>,
    defaults: Record<string, unknown> | undefined,
    userSchema?: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...defaults,
    ...base,
    ...(userSchema ?? {}),
  });

  // Default CRUD routes — table-driven so a cross-cutting concern touches one block.
  // Chain: arc decorator → auth → permission → (cache | idempotency) → guards → per-op mw.
  if (!disableDefaultRoutes) {
    if (!controller) {
      throw new Error(
        "Controller is required when disableDefaultRoutes is not true. " +
          "Provide a controller or use defineResource which auto-creates BaseController.",
      );
    }

    const ctrl = controller as IController<TDoc>;

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

      const hooks = buildRouteHooks({
        arcDecorator,
        authMw: buildAuthMiddleware(fastify, permission),
        permissionMw: buildCrudPermissionMw(permission, resourceName, spec.op),
        pluginMw: selectPluginMw(spec.method, pluginMw),
        routeGuards,
        customMws: mw[spec.op],
      });

      // `update` may register PUT, PATCH, or both.
      const methodsToRegister: HttpMethod[] =
        spec.op === "update"
          ? updateMethod === "both"
            ? ["PUT", "PATCH"]
            : [updateMethod]
          : [spec.method];

      for (const method of methodsToRegister) {
        const summary =
          spec.op === "update" ? `${method === "PUT" ? "Replace" : "Update"} ${tag}` : spec.summary;

        tryRegisterRoute(
          fastify,
          {
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
            ) as FastifySchema,
            ...routeHookOptions(hooks),
            handler: handlers[spec.op],
            ...buildRouteConfig(
              rateLimitConfig,
              extensions,
              undefined,
              idempotentOps.has(spec.op) ? { required: true } : undefined,
            ),
          },
          { resourceName, op: spec.op },
        );
      }
    }
  }

  // Custom routes work independently of CRUD (`disableDefaultRoutes: true` + `routes`).
  if (customRoutes.length > 0) {
    createCustomRoutes(fastify, customRoutes, controller, {
      tag,
      resourceName,
      arcDecorator,
      rateLimitConfig,
      pluginMw,
      pipeline,
      routeGuards,
      tenantScopeMw,
      fieldPermissions,
      onFieldWriteDenied,
      extensions,
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
// Public helper
// ============================================================================

/**
 * Build a permission middleware from a PermissionCheck, for host routes
 * registered outside the resource system.
 */
export function createPermissionMiddleware(
  permission: PermissionCheck,
  resourceName: string,
  action: string,
): RouteHandlerMethod | null {
  return buildCrudPermissionMw(permission, resourceName, action);
}
