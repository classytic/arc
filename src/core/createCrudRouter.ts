/**
 * CRUD Router Factory
 *
 * Creates standard REST routes with permission-based access control.
 * Full TypeScript support with proper Fastify types.
 *
 * Features:
 * - Permission-based access control via PermissionCheck functions
 * - Multi-tenant scoping via multiTenant preset
 * - Consistent route patterns
 * - Framework-agnostic controllers via adapter pattern
 */

import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  RouteHandlerMethod,
} from "fastify";

// Fastify 5.8+ tightened preHandler hook types. RouteHandlerMethod returns `unknown`
// but preHandler expects `void | Promise<unknown>`. This alias bridges the gap safely
// since all Arc middleware conforms at runtime.
type PreHandlerHook = preHandlerHookHandler | RouteHandlerMethod;

import { CRUD_OPERATIONS, DEFAULT_UPDATE_METHOD } from "../constants.js";
import { requestContext } from "../context/requestContext.js";
import type { PermissionCheck, PermissionContext, PermissionResult } from "../permissions/types.js";
import { executePipeline } from "../pipeline/pipe.js";
import type { PipelineConfig, PipelineContext, PipelineStep } from "../pipeline/types.js";
import type { ControllerHandler } from "../types/handlers.js";
import type {
  AdditionalRoute,
  CrudController,
  CrudRouterOptions,
  FastifyWithDecorators,
  IController,
  IControllerResponse,
  IRequestContext,
  RateLimitConfig,
  RequestWithExtras,
  UserLike,
} from "../types/index.js";
import { getDefaultCrudSchemas } from "../utils/responseSchemas.js";
import { convertRouteSchema } from "../utils/schemaConverter.js";
import {
  createCrudHandlers,
  createFastifyHandler,
  createRequestContext,
  sendControllerResponse,
} from "./fastifyAdapter.js";

// ============================================================================
// Rate Limit Helpers
// ============================================================================

/**
 * Route-level config shape for @fastify/rate-limit.
 *
 * When the plugin is registered on the instance, it reads `config.rateLimit`
 * from each route to apply per-route overrides.
 */
interface RouteRateLimitConfig {
  rateLimit: { max: number; timeWindow: string } | false;
}

/**
 * Build per-route rate limit config object.
 *
 * Returns a `config` object suitable for Fastify's `route()` options,
 * or `undefined` if no rate limit is configured for this resource.
 *
 * - `RateLimitConfig` object  -> apply that limit to the route
 * - `false`                   -> explicitly disable rate limiting for the route
 * - `undefined`               -> no override (inherits instance-level config)
 */
function buildRateLimitConfig(
  rateLimit: RateLimitConfig | false | undefined,
): RouteRateLimitConfig | undefined {
  if (rateLimit === undefined) return undefined;

  if (rateLimit === false) {
    return { rateLimit: false };
  }

  return {
    rateLimit: {
      max: rateLimit.max,
      timeWindow: rateLimit.timeWindow,
    },
  };
}

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Check if a permission requires authentication
 *
 * A permission requires auth if:
 * - It exists AND
 * - It doesn't have _isPublic flag set to true
 *
 * This is used to automatically add fastify.authenticate
 * to the preHandler chain for non-public routes.
 */
function requiresAuthentication(permission: PermissionCheck | undefined): boolean {
  if (!permission) return false; // No permission = public by default
  return !permission._isPublic;
}

/**
 * Build authentication middleware
 *
 * - Protected routes (requireAuth, requireRoles, etc.): uses fastify.authenticate (fails without token)
 * - Public routes (allowPublic): uses fastify.optionalAuthenticate (parses token if present, doesn't fail)
 *
 * This ensures request.user is populated on public routes when a Bearer token is sent,
 * enabling downstream middleware (e.g. multiTenant flexible filter) to apply org-scoped queries.
 */
function buildAuthMiddleware(
  fastify: FastifyWithDecorators,
  permission: PermissionCheck | undefined,
): RouteHandlerMethod | null {
  if (requiresAuthentication(permission)) {
    // Protected route: require auth (401 if no token)
    return (fastify.authenticate as RouteHandlerMethod) ?? null;
  }
  // Public route: optionally parse auth to populate request.user
  return (fastify.optionalAuthenticate as RouteHandlerMethod) ?? null;
}

/**
 * Build permission middleware from PermissionCheck function
 *
 * Creates a Fastify preHandler that:
 * 1. Executes the permission check
 * 2. Returns 401 if authentication required but user absent
 * 3. Returns 403 if permission denied
 * 4. Applies query filters from PermissionResult if present
 */
function buildPermissionMiddleware(
  permissionCheck: PermissionCheck | undefined,
  resourceName: string,
  action: string,
): RouteHandlerMethod | null {
  // No permission check = public route
  if (!permissionCheck) return null;

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const reqWithExtras = request as RequestWithExtras;

    // Build permission context
    const params = request.params as Record<string, string> | undefined;
    const context: PermissionContext = {
      user: (reqWithExtras.user as UserLike | undefined) ?? null,
      request,
      resource: resourceName,
      action,
      resourceId: params?.id,
      params,
      data: request.body as Record<string, unknown> | undefined,
    };

    // Execute permission check — catch exceptions so authz bugs don't become 500s
    let result: boolean | PermissionResult;
    try {
      result = await permissionCheck(context);
    } catch (err) {
      request.log?.warn?.({ err, resource: resourceName, action }, "Permission check threw");
      reply.code(403).send({ success: false, error: "Permission denied" });
      return;
    }

    // Handle boolean result
    if (typeof result === "boolean") {
      if (!result) {
        reply.code(context.user ? 403 : 401).send({
          success: false,
          error: context.user ? "Permission denied" : "Authentication required",
        });
        return;
      }
      return;
    }

    // Handle PermissionResult
    const permResult = result as PermissionResult;
    if (!permResult.granted) {
      // Sanitize reason — prevent leaking internals in long or unexpected messages
      const defaultMsg = context.user ? "Permission denied" : "Authentication required";
      const reason =
        permResult.reason && permResult.reason.length <= 100 ? permResult.reason : defaultMsg;
      reply.code(context.user ? 403 : 401).send({
        success: false,
        error: reason,
      });
      return;
    }

    // Apply filters from permission result (for ownership patterns)
    if (permResult.filters) {
      reqWithExtras._policyFilters = {
        ...(reqWithExtras._policyFilters ?? {}),
        ...permResult.filters,
      };
    }
  };
}

/**
 * Create additional routes from preset/custom definitions
 */
function createAdditionalRoutes<TDoc = unknown>(
  fastify: FastifyWithDecorators,
  routes: AdditionalRoute[],
  controller: CrudController<TDoc> | undefined,
  options: {
    tag: string;
    resourceName: string;
    arcDecorator: RouteHandlerMethod;
    rateLimitConfig?: RouteRateLimitConfig;
    cacheMw: RouteHandlerMethod | null;
    idempotencyMw: RouteHandlerMethod | null;
    pipeline?: PipelineConfig;
  },
): void {
  const { tag, resourceName, arcDecorator, rateLimitConfig, cacheMw, idempotencyMw, pipeline } =
    options;

  for (const route of routes) {
    // Derive logical operation name for pipeline keys and permission actions.
    // Priority: explicit operation > handler name (string) > method+path slug
    const opName =
      route.operation ??
      (typeof route.handler === "string"
        ? route.handler
        : `${route.method.toLowerCase()}${route.path.replace(/[/:]/g, "_")}`);

    // Resolve handler - wrapHandler is REQUIRED (no auto-detection)
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
      // Bind method to controller
      const boundMethod = (method as Function).bind(controller);

      // Explicit wrapHandler - no auto-detection
      if (route.wrapHandler) {
        const steps = pipeline ? resolvePipelineSteps(pipeline, opName) : [];
        if (steps.length > 0) {
          handler = createPipelineHandler(
            boundMethod as (ctx: IRequestContext) => Promise<IControllerResponse<unknown>>,
            steps,
            opName,
            resourceName,
          );
        } else {
          handler = createFastifyHandler(boundMethod as ControllerHandler);
        }
      } else {
        handler = boundMethod as RouteHandlerMethod;
      }
    } else {
      // Function handler - use explicit wrapHandler
      if (route.wrapHandler) {
        const steps = pipeline ? resolvePipelineSteps(pipeline, opName) : [];
        if (steps.length > 0) {
          handler = createPipelineHandler(
            route.handler as (ctx: IRequestContext) => Promise<IControllerResponse<unknown>>,
            steps,
            opName,
            resourceName,
          );
        } else {
          handler = createFastifyHandler(route.handler as ControllerHandler);
        }
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

    // Build preHandler chain: arc decorator → auth → permission check → custom middlewares
    const authMw = buildAuthMiddleware(fastify, route.permissions);
    const permissionMw = buildPermissionMiddleware(route.permissions, resourceName, opName);

    // Resolve preHandler - can be array or function that receives fastify
    const customPreHandlers =
      typeof route.preHandler === "function"
        ? (route.preHandler as (fastify: FastifyWithDecorators) => RouteHandlerMethod[])(fastify)
        : ((route.preHandler ?? []) as PreHandlerHook[]);

    // Select plugin middleware based on HTTP method
    const pluginMw =
      route.method === "GET"
        ? cacheMw
        : ["POST", "PUT", "PATCH"].includes(route.method)
          ? idempotencyMw
          : null;

    const preHandler = [
      arcDecorator,
      authMw, // Authenticate first (populates request.user)
      permissionMw, // Then check permissions
      pluginMw, // Cache (GET) or idempotency (mutations) — after auth
      ...customPreHandlers,
    ].filter(Boolean) as PreHandlerHook[];

    fastify.route({
      method: route.method,
      url: route.path,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schema: schema as Record<string, any>, // Fastify RouteOptions.schema requires this shape
      preHandler: preHandler.length > 0 ? (preHandler as any) : undefined,
      handler,
      ...(rateLimitConfig ? { config: rateLimitConfig } : {}),
    });
  }
}

// ============================================================================
// Pipeline Helpers
// ============================================================================

/**
 * Resolve pipeline steps for a specific operation.
 * If pipeline is a flat array, all steps are returned.
 * If it's a per-operation map, only matching steps are returned.
 */
function resolvePipelineSteps(
  pipeline: PipelineConfig | undefined,
  operation: string,
): PipelineStep[] {
  if (!pipeline) return [];
  if (Array.isArray(pipeline)) return pipeline;
  return pipeline[operation] ?? [];
}

/**
 * Create a Fastify handler that wraps a controller method with pipeline execution.
 */
function createPipelineHandler<T>(
  controllerMethod: (ctx: IRequestContext) => Promise<IControllerResponse<T>>,
  steps: PipelineStep[],
  operation: string,
  resourceName: string,
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const reqCtx = createRequestContext(req);
    const pipeCtx: PipelineContext = {
      ...reqCtx,
      resource: resourceName,
      operation,
    };
    const response = await executePipeline(
      steps,
      pipeCtx,
      (ctx) => controllerMethod(ctx) as Promise<IControllerResponse<unknown>>,
      operation,
    );
    sendControllerResponse(reply, response as IControllerResponse<T>, req);
  };
}

/**
 * Create CRUD routes for a controller
 *
 * @param fastify - Fastify instance with Arc decorators
 * @param controller - CRUD controller with handler methods
 * @param options - Router configuration
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
    additionalRoutes = [],
    disableDefaultRoutes = false,
    disabledRoutes = [],
    resourceName = "unknown",
    schemaOptions,
    rateLimit,
    pipe: pipeline,
    fields: fieldPermissions,
    updateMethod = DEFAULT_UPDATE_METHOD,
  } = options;

  // Build per-route rate limit config (applied to every route in this resource)
  const rateLimitConfig = buildRateLimitConfig(rateLimit);

  // Optional plugin middleware — injected AFTER auth+permissions, BEFORE custom middlewares.
  // These plugins expose route-level middleware that must run after auth populates
  // request.user, ensuring user-scoped cache keys and idempotency fingerprints.
  //
  // Skip response-cache when QueryCache is active for this resource.
  // QueryCache handles caching at the controller level (data-layer) with SWR,
  // so the HTTP-level response-cache is unnecessary and would cause double caching.
  const resourceHasQueryCache =
    fastify.hasDecorator("queryCache") &&
    controller &&
    typeof (controller as unknown as Record<string, unknown>)._cacheConfig !== "undefined" &&
    (controller as unknown as Record<string, unknown>)._cacheConfig !== undefined;
  const cacheMw: RouteHandlerMethod | null =
    !resourceHasQueryCache && fastify.hasDecorator("responseCache")
      ? (fastify.responseCache.middleware as RouteHandlerMethod)
      : null;
  const idempotencyMw: RouteHandlerMethod | null = fastify.hasDecorator("idempotency")
    ? (fastify.idempotency.middleware as RouteHandlerMethod)
    : null;

  // Pre-build frozen arc metadata — allocated once, shared across all requests
  const arcMeta = Object.freeze({
    resourceName,
    schemaOptions,
    permissions,
    // Include instance-scoped hooks if available (for proper isolation)
    hooks: fastify.arc?.hooks,
    // Include events emitter if available
    events: fastify.events,
    // Field-level permissions for response filtering
    fields: fieldPermissions,
  });

  // Arc metadata decorator - sets req.arc with resource configuration and instance-scoped systems
  const arcDecorator: RouteHandlerMethod = async (req, _reply) => {
    (req as unknown as { arc?: unknown }).arc = arcMeta;

    // Populate requestContext with resource name for downstream access
    const store = requestContext.get();
    if (store) {
      store.resourceName = resourceName;
    }
  };

  // Get middleware for each operation
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
   * Build route schema by merging: base (tags/summary) → defaults (response/querystring) → user overrides.
   * User-provided schemas always take precedence. Defaults enable fast-json-stringify when no user schema is set.
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

  // Only validate and create handlers when default routes are enabled
  let handlers: ReturnType<typeof createCrudHandlers> | undefined;

  if (!disableDefaultRoutes) {
    // Controller is required for default CRUD routes
    if (!controller) {
      throw new Error(
        "Controller is required when disableDefaultRoutes is not true. " +
          "Provide a controller or use defineResource which auto-creates BaseController.",
      );
    }

    const ctrl = controller as IController<TDoc>;

    // If pipeline is configured, wrap handlers with pipeline execution
    if (pipeline) {
      const ops = CRUD_OPERATIONS;
      const wrapped: Record<string, RouteHandlerMethod> = {};
      for (const op of ops) {
        const steps = resolvePipelineSteps(pipeline, op);
        if (steps.length > 0) {
          const method = ctrl[op].bind(ctrl) as (
            ctx: IRequestContext,
          ) => Promise<IControllerResponse<unknown>>;
          wrapped[op] = createPipelineHandler(method, steps, op, resourceName);
        }
      }
      // Create standard handlers first, then override with pipeline-wrapped ones
      const standardHandlers = createCrudHandlers(ctrl);
      handlers = {
        ...standardHandlers,
        ...wrapped,
      };
    } else {
      handlers = createCrudHandlers(ctrl);
    }
  }

  // Standard CRUD routes
  if (!disableDefaultRoutes && handlers) {
    // GET / - List all
    if (!disabledRoutes.includes("list")) {
      const authMw = buildAuthMiddleware(fastify, permissions.list);
      const permMw = buildPermissionMiddleware(permissions.list, resourceName, "list");
      const listPreHandler = [arcDecorator, authMw, permMw, cacheMw, ...mw.list].filter(
        Boolean,
      ) as PreHandlerHook[];
      fastify.route({
        method: "GET",
        url: "/",
        schema: buildSchema(
          { tags: [tag], summary: `List ${tag}` },
          defaultSchemas.list,
          schemas.list as Record<string, unknown> | undefined,
        ),
        preHandler: listPreHandler.length > 0 ? (listPreHandler as any) : undefined,
        handler: handlers.list,
        ...(rateLimitConfig ? { config: rateLimitConfig } : {}),
      });
    }

    // GET /:id - Get by ID
    if (!disabledRoutes.includes("get")) {
      const authMw = buildAuthMiddleware(fastify, permissions.get);
      const permMw = buildPermissionMiddleware(permissions.get, resourceName, "get");
      const getPreHandler = [arcDecorator, authMw, permMw, cacheMw, ...mw.get].filter(
        Boolean,
      ) as PreHandlerHook[];
      fastify.route({
        method: "GET",
        url: "/:id",
        schema: buildSchema(
          { tags: [tag], summary: `Get ${tag} by ID`, params: idParamsSchema },
          defaultSchemas.get,
          schemas.get as Record<string, unknown> | undefined,
        ),
        preHandler: getPreHandler.length > 0 ? (getPreHandler as any) : undefined,
        handler: handlers.get,
        ...(rateLimitConfig ? { config: rateLimitConfig } : {}),
      });
    }

    // POST / - Create
    if (!disabledRoutes.includes("create")) {
      const authMw = buildAuthMiddleware(fastify, permissions.create);
      const permMw = buildPermissionMiddleware(permissions.create, resourceName, "create");
      const createPreHandler = [arcDecorator, authMw, permMw, idempotencyMw, ...mw.create].filter(
        Boolean,
      ) as PreHandlerHook[];
      fastify.route({
        method: "POST",
        url: "/",
        schema: buildSchema(
          { tags: [tag], summary: `Create ${tag}` },
          defaultSchemas.create,
          schemas.create as Record<string, unknown> | undefined,
        ),
        preHandler: createPreHandler.length > 0 ? (createPreHandler as any) : undefined,
        handler: handlers.create,
        ...(rateLimitConfig ? { config: rateLimitConfig } : {}),
      });
    }

    // UPDATE /:id - PATCH, PUT, or both
    if (!disabledRoutes.includes("update")) {
      const updateMethods =
        updateMethod === "both" ? (["PUT", "PATCH"] as const) : ([updateMethod] as const);
      const authMw = buildAuthMiddleware(fastify, permissions.update);
      const permMw = buildPermissionMiddleware(permissions.update, resourceName, "update");
      const updatePreHandler = [arcDecorator, authMw, permMw, idempotencyMw, ...mw.update].filter(
        Boolean,
      ) as PreHandlerHook[];
      for (const method of updateMethods) {
        fastify.route({
          method,
          url: "/:id",
          schema: buildSchema(
            {
              tags: [tag],
              summary: `${method === "PUT" ? "Replace" : "Update"} ${tag}`,
              params: idParamsSchema,
            },
            defaultSchemas.update,
            schemas.update as Record<string, unknown> | undefined,
          ),
          preHandler: updatePreHandler.length > 0 ? (updatePreHandler as any) : undefined,
          handler: handlers.update,
          ...(rateLimitConfig ? { config: rateLimitConfig } : {}),
        });
      }
    }

    // DELETE /:id - Delete
    if (!disabledRoutes.includes("delete")) {
      const authMw = buildAuthMiddleware(fastify, permissions.delete);
      const permMw = buildPermissionMiddleware(permissions.delete, resourceName, "delete");
      const deletePreHandler = [arcDecorator, authMw, permMw, ...mw.delete].filter(
        Boolean,
      ) as PreHandlerHook[];
      fastify.route({
        method: "DELETE",
        url: "/:id",
        schema: buildSchema(
          { tags: [tag], summary: `Delete ${tag}`, params: idParamsSchema },
          defaultSchemas.delete,
          schemas.delete as Record<string, unknown> | undefined,
        ),
        preHandler: deletePreHandler.length > 0 ? (deletePreHandler as any) : undefined,
        handler: handlers.delete,
        ...(rateLimitConfig ? { config: rateLimitConfig } : {}),
      });
    }
  }

  // Additional routes from presets and custom
  if (additionalRoutes.length > 0) {
    createAdditionalRoutes(fastify, additionalRoutes, controller, {
      tag,
      resourceName,
      arcDecorator,
      rateLimitConfig,
      cacheMw,
      idempotencyMw,
      pipeline,
    });
  }
}

/**
 * Create permission middleware from PermissionCheck
 * Useful for custom route registration
 */
export function createPermissionMiddleware(
  permission: PermissionCheck,
  resourceName: string,
  action: string,
): RouteHandlerMethod | null {
  return buildPermissionMiddleware(permission, resourceName, action);
}

