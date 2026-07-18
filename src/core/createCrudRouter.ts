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

import type { FastifySchema, RouteHandlerMethod } from "fastify";

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
    /**
     * Tenant-scope middleware list emitted by `multiTenantPreset` (and
     * compatible presets) on the `tenantScope` slot. Applied to any
     * custom route that opts in via `RouteDefinition.tenantScope: true`.
     * `undefined` when the resource has no multiTenant preset wired —
     * in that case `tenantScope: true` is a config bug and we throw.
     */
    tenantScopeMw?: readonly RouteHandlerMethod[];
    /**
     * Resource-level field permissions (`defineResource({ fields })`).
     * When set + the route is body-bearing + `route.raw !== true` +
     * `route.fieldWrite !== false`, a field-write preHandler is appended
     * to the route's chain so custom routes match auto-CRUD's enforcement.
     */
    fieldPermissions?: import("../permissions/fields.js").FieldPermissionMap;
    /** Resource-level `onFieldWriteDenied` policy (default: 'reject'). */
    onFieldWriteDenied?: "reject" | "strip";
    /**
     * Resource-level plugin extensions (`defineResource({ extensions })`).
     * Stamped onto each custom route's `config.arcExtensions` so plugins
     * (encryption, …) read their typed slice at request time.
     */
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
    // 2.16 — `controllerMethod` (typed function-ref) is mutually exclusive
    // with `handler`. Resolve one of the two into a single dispatch target
    // BEFORE the rest of the per-route wiring, so the downstream code
    // sees a uniform "have a function or have a string" decision.
    const routeWithRefs = route as typeof route & {
      controllerMethod?: (controller: unknown) => unknown;
    };
    const hasHandler = route.handler !== undefined;
    const hasControllerMethod = typeof routeWithRefs.controllerMethod === "function";
    if (hasHandler && hasControllerMethod) {
      throw new Error(
        `Route ${route.method} ${route.path}: pass either \`handler\` or \`controllerMethod\`, not both. ` +
          "Prefer `controllerMethod: (c: MyController) => c.method` for typed handler refs (TS catches typos).",
      );
    }
    if (!hasHandler && !hasControllerMethod) {
      throw new Error(
        `Route ${route.method} ${route.path}: must declare either \`handler\` (string / function) or ` +
          "`controllerMethod: (c) => c.method` (typed function-ref form).",
      );
    }

    // Resolve `controllerMethod` against the live controller — this is
    // the typed counterpart of the string-handler lookup. Throws if no
    // controller is available, or if the function returns a non-function
    // (defensive — TS catches this normally, but a host might still
    // forget to return the method).
    let resolvedHandler: RouteDefinition["handler"];
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
      resolvedHandler = route.handler;
    }

    // Derive logical operation name for pipeline keys and permission actions.
    // Priority: explicit operation > handler name (string) > method+path slug
    const opName =
      route.operation ??
      (typeof resolvedHandler === "string"
        ? resolvedHandler
        : `${route.method.toLowerCase()}${route.path.replace(/[/:]/g, "_")}`);

    // Derive pipeline wrapping from `raw`: `raw: true` → no wrap;
    // anything else (default) → arc pipeline wraps the handler.
    const wrapHandler = !route.raw;

    let handler: RouteHandlerMethod;

    if (typeof resolvedHandler === "string") {
      // String handlers require a controller
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
        handler = boundMethod as RouteHandlerMethod;
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
        handler = resolvedHandler as RouteHandlerMethod;
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

    // tenantScope: true → prepend the multiTenant preset's filter +
    // injection middlewares so this custom route sees the same tenant
    // wiring auto-CRUD does. Fail-fast on misconfig: if the flag is set
    // but no preset emitted the `tenantScope` slot, the route would be
    // silently insecure for read paths (returns all-org data) — reject
    // at registration time with an actionable message.
    if (route.tenantScope === true) {
      if (!tenantScopeMw || tenantScopeMw.length === 0) {
        throw new Error(
          `Route ${route.method} ${route.path}: \`tenantScope: true\` requires a multi-tenant preset. ` +
            `Add \`multiTenantPreset()\` (or \`flexibleMultiTenantPreset()\`) to the resource's \`presets\`, ` +
            `or remove the \`tenantScope\` flag from this route.`,
        );
      }
      customPreHandlers.unshift(...(tenantScopeMw as RouteHandlerMethod[]));
    }

    // Auto-apply resource-level field-write permissions on body-bearing
    // custom routes. Auto-CRUD gets this for free via `BodySanitizer` inside
    // `BaseController`; without this step a custom `POST /users/promote`
    // bypassed `writableBy(['admin'])` rules and silently accepted
    // restricted fields. `raw: true` opts out of the pipeline entirely;
    // `fieldWrite: false` is the per-route escape hatch.
    const shouldApplyFieldWrite =
      route.raw !== true &&
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

    // streamResponse: true → SSE-style raw pipe. Two contracts:
    //   1) Handler writes to `reply.raw` directly (NDJSON, custom SSE) —
    //      arc just pre-sets SSE headers and gets out of the way. This is
    //      the historical contract.
    //   2) Handler RETURNS a Web `ReadableStream` (Vercel AI SDK's
    //      `result.toUIMessageStream()`, raw `fetch().body`, etc.). Pre-2.17.1
    //      this crashed with `chunk must be a string or Buffer` because
    //      Fastify can't serialise structured chunks. arc now auto-detects
    //      the stream and routes it through `pipeUIMessageStreamToReply()`,
    //      which JSON-encodes each chunk into an SSE `data:` frame and
    //      wires client-disconnect → stream.cancel(). Hosts get the
    //      one-liner the framework should have shipped all along.
    const isStream = (route as { streamResponse?: boolean }).streamResponse === true;

    tryRegisterRoute(
      fastify,
      {
        method: route.method,
        url: route.path,
        schema: schema as FastifySchema,
        ...routeHookOptions(hooks),
        handler: isStream
          ? async (request, reply) => {
              // Pre-set SSE headers via `reply.raw` so handlers that write
              // to `reply.raw` directly (the legacy pattern) keep working.
              // `pipeUIMessageStreamToReply` re-applies them via
              // `reply.header()` for the auto-pipe branch — Fastify dedupes.
              reply.raw.setHeader("Content-Type", "text/event-stream");
              reply.raw.setHeader("Cache-Control", "no-cache");
              reply.raw.setHeader("Connection", "keep-alive");
              const result = await (handler as (req: unknown, rep: unknown) => unknown)(
                request,
                reply,
              );
              // Auto-pipe a returned ReadableStream so AI-SDK callers don't
              // hand-roll `JsonToSseTransformStream`. Handlers that already
              // wrote to `reply.raw` return undefined / a value that isn't a
              // stream — those keep working unchanged.
              if (isReadableStream(result)) {
                await pipeUIMessageStreamToReply(reply, result);
                // Return `reply` (not `result`) — the helper already called
                // `reply.send()`, so propagating the original ReadableStream
                // would make Fastify try to send it a SECOND time and crash
                // with ERR_HTTP_HEADERS_SENT. Returning `reply` signals
                // "response is owned; do not touch."
                return reply;
              }
              return result;
            }
          : handler,
        // Per-route rate limit overrides the resource default for THIS
        // endpoint (custom routes are individual Fastify routes). `undefined`
        // inherits the resource-level config; `false` disables; object applies.
        ...buildRouteConfig(
          route.rateLimit !== undefined ? buildRateLimitConfig(route.rateLimit) : rateLimitConfig,
          extensions,
        ),
      },
      { resourceName, op: opName },
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
    // Surfaces on `req.arc.idField` for every CRUD route — handlers
    // and downstream middleware compose `findOne` filters via
    // `getEntityQuery(req)` without re-reading resource config.
    idField,
    // Plugin extensions stamped onto every route's `config.arcExtensions`
    // so request-time plugins (encryption, …) read their typed slice.
    extensions,
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

  // Tenant-scope middleware slot — emitted by `multiTenantPreset` so custom
  // routes can opt in via `RouteDefinition.tenantScope: true`. The slot rides
  // on the same `MiddlewareConfig` map the CRUD slots use (its string index
  // signature accepts arbitrary keys); we read it here and forward it to
  // `createCustomRoutes` instead of having that function reach back through
  // the options bag. Stays `undefined` when no multi-tenant preset is wired
  // — `createCustomRoutes` then throws when a route tries to opt in.
  const tenantScopeMw = middlewares.tenantScope as RouteHandlerMethod[] | undefined;

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

      const hooks = buildRouteHooks({
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
            ...buildRouteConfig(rateLimitConfig, extensions),
          },
          { resourceName, op: spec.op },
        );
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
