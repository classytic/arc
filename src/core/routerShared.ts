/**
 * Shared Router Primitives
 *
 * The CRUD router (`createCrudRouter`) and the action router (`createActionRouter`)
 * share everything except the per-route shape. This module is the single source
 * of truth for the pieces that must not drift between them:
 *
 *   - `arcDecorator`           — stamps `req.arc` so `sendControllerResponse`
 *                                knows how to field-mask responses and which
 *                                hooks/events bus the handler is attached to
 *   - `buildAuthMiddleware`    — choose `authenticate` vs `optionalAuthenticate`
 *                                from a single permission or a set of permissions
 *   - `buildCrudPermissionMw`  — static per-route permission gate (CRUD op names)
 *   - `buildPermissionContext` — PermissionContext from a Fastify request
 *   - `buildPipelineHandler`   — pipeline wrapper for controller methods
 *   - `buildActionPipelineHandler` — pipeline wrapper for action handlers
 *   - `resolvePipelineSteps`   — `PipelineConfig | undefined` → steps for op
 *   - `buildRateLimitConfig`   — per-route rate-limit config
 *   - `selectPluginMw`         — pick cacheMw/idempotencyMw by HTTP method
 *   - `buildPreHandlerChain`   — compose preHandler[] in the canonical order
 *
 * Canonical preHandler order (CRUD + Actions must agree):
 *
 *   preAuth → arcDecorator → authMw → permissionMw → pluginMw → routeGuards → customMws
 *
 * Where:
 *   - `preAuth`       runs BEFORE auth (token promotion, header rewrites for SSE)
 *   - `arcDecorator`  stamps `req.arc` (so downstream can read fields/hooks/events)
 *   - `authMw`        authenticates (required) or optionally authenticates (public)
 *   - `permissionMw`  evaluates the permission check and applies filters/scope
 *   - `pluginMw`      `responseCache` (GET) or `idempotency` (mutations)
 *   - `routeGuards`   resource-level guards (before per-op middlewares)
 *   - `customMws`     per-route user middlewares
 */

import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
  RouteHandlerMethod,
} from "fastify";

import { requestContext } from "../context/requestContext.js";
import { evaluateAndApplyPermission } from "../permissions/applyPermissionResult.js";
import type { PermissionCheck, PermissionContext } from "../permissions/types.js";
import { executePipeline } from "../pipeline/pipe.js";
import type { PipelineConfig, PipelineContext, PipelineStep } from "../pipeline/types.js";
import type {
  FastifyWithDecorators,
  IControllerResponse,
  IRequestContext,
  RateLimitConfig,
  RequestWithExtras,
  UserLike,
} from "../types/index.js";
import { createError } from "../utils/errors.js";
import { createRequestContext, sendControllerResponse } from "./fastifyAdapter.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Fastify 5.8+ tightened preHandler hook types. `RouteHandlerMethod` returns
 * `unknown` but preHandler expects `void | Promise<unknown>`. This alias bridges
 * the gap — all arc middleware conforms at runtime.
 */
export type PreHandlerHook = preHandlerHookHandler | RouteHandlerMethod;

/**
 * HTTP methods for which Fastify's rate-limit plugin applies per-route config.
 */
export interface RouteRateLimitConfig {
  rateLimit: { max: number; timeWindow: string } | false;
}

/**
 * Frozen metadata stamped onto `req.arc` by `arcDecorator`. Downstream
 * consumers (`sendControllerResponse`, hook system, event bus) read it to
 * find the resource's wiring without threading config through every layer.
 */
export interface ArcRouteMeta {
  readonly resourceName: string;
  readonly schemaOptions: unknown;
  readonly permissions: unknown;
  readonly hooks: unknown;
  readonly events: unknown;
  readonly fields: unknown;
}

/**
 * Request-lifecycle plugin middlewares exposed by Fastify decorators.
 * Selected per HTTP method by `selectPluginMw`.
 */
export interface RouterPluginMw {
  readonly cacheMw: RouteHandlerMethod | null;
  readonly idempotencyMw: RouteHandlerMethod | null;
}

// ============================================================================
// Arc metadata decorator
// ============================================================================

/**
 * Build the `arcDecorator` preHandler for a resource.
 *
 * The decorator is a closure over frozen metadata — allocated once per
 * resource and shared across every request. Stamps `req.arc` with the
 * resource's field permissions, hooks, events bus, and schema options
 * so `sendControllerResponse`, `BaseController.run*`, and custom
 * middleware can read a consistent view.
 *
 * Also populates `requestContext.resourceName` for async-context access
 * in code paths that can't reach `req.arc` directly (e.g. detached logger
 * formatters).
 */
export function buildArcDecorator(meta: ArcRouteMeta): RouteHandlerMethod {
  const frozen = Object.freeze({ ...meta });
  return async (req, _reply) => {
    (req as unknown as { arc?: ArcRouteMeta }).arc = frozen;
    const store = requestContext.get();
    if (store) {
      store.resourceName = frozen.resourceName;
    }
  };
}

// ============================================================================
// Authentication middleware
// ============================================================================

/**
 * A permission requires authentication unless it carries the `_isPublic`
 * marker set by `allowPublic()`. Absence of a permission is treated as
 * public (no auth) — matches historical CRUD behaviour.
 */
export function requiresAuthentication(permission: PermissionCheck | undefined): boolean {
  if (!permission) return false;
  return !permission._isPublic;
}

/**
 * Pick the right Fastify auth decorator for a single-permission route:
 *   - protected route → `fastify.authenticate` (401 on missing token)
 *   - public route    → `fastify.optionalAuthenticate` (parses token if present)
 *
 * Public routes still get optional auth so downstream multi-tenant filters
 * can narrow queries when a Bearer token IS supplied.
 */
export function buildAuthMiddleware(
  fastify: FastifyWithDecorators,
  permission: PermissionCheck | undefined,
): RouteHandlerMethod | null {
  if (requiresAuthentication(permission)) {
    return (fastify.authenticate as RouteHandlerMethod) ?? null;
  }
  return (fastify.optionalAuthenticate as RouteHandlerMethod) ?? null;
}

/**
 * Pick the right auth decorator for a multi-permission route (Action router).
 *
 * The input is the array of resolved per-action permissions — one slot per
 * action, in registration order, already flattened against `globalAuth`
 * fallback by the caller (`actionPermissions[name] ?? globalAuth`). A slot
 * may be `undefined` when the action has no per-action check AND no
 * `globalAuth` fallback — that is "public by omission" and must be honored
 * here the same way `buildActionPermissionMw` honors it (by skipping the
 * permission evaluation entirely). If we filtered undefineds out at this
 * layer, a mixed endpoint like `{ ping: undefined, promote: requireRoles(...) }`
 * would collapse to "all protected" and 401 the public `ping` action at the
 * auth layer before the permission prehandler could let it through.
 *
 * Rules:
 *   - ALL public (explicit allowPublic OR omission) → `optionalAuthenticate`
 *   - ALL protected                                 → `authenticate` (fail-fast)
 *   - MIXED                                         → `optionalAuthenticate`
 *     (parse token if present; per-action check fails-closed when user=null)
 *
 * The mixed case was previously handled by an in-handler
 * `fastify.authenticate()` call that bypassed the preHandler chain; this
 * helper moves that logic back into the preHandler stack so the request
 * lifecycle is consistent across router types.
 */
export function buildAuthMiddlewareForPermissions(
  fastify: FastifyWithDecorators,
  permissions: ReadonlyArray<PermissionCheck | undefined>,
): RouteHandlerMethod | null {
  if (permissions.length === 0) {
    return (fastify.optionalAuthenticate as RouteHandlerMethod) ?? null;
  }
  const hasProtected = permissions.some((p) => requiresAuthentication(p));
  // `p._isPublic` is an explicit allowPublic() marker; `!p` is an undefined
  // slot — public by omission. Both must flip the decision to optionalAuth.
  const hasPublic =
    permissions.some((p) => p && p._isPublic === true) || permissions.some((p) => !p);

  if (hasProtected && !hasPublic) {
    return (fastify.authenticate as RouteHandlerMethod) ?? null;
  }
  return (fastify.optionalAuthenticate as RouteHandlerMethod) ?? null;
}

// ============================================================================
// Permission middleware + context
// ============================================================================

/**
 * Build a PermissionContext from a Fastify request. Extracted so the CRUD
 * permission middleware and the dynamic action-permission check use the same
 * field layout — divergence here silently broke policy filters for actions.
 */
export function buildPermissionContext(
  req: FastifyRequest,
  opts: {
    resource: string;
    action: string;
    resourceId?: string;
    data?: Record<string, unknown>;
  },
): PermissionContext {
  const reqWithExtras = req as RequestWithExtras;
  const params = req.params as Record<string, string> | undefined;
  return {
    user: (reqWithExtras.user as UserLike | undefined) ?? null,
    request: req,
    resource: opts.resource,
    action: opts.action,
    resourceId: opts.resourceId ?? params?.id,
    params,
    data: opts.data ?? (req.body as Record<string, unknown> | undefined),
  };
}

/**
 * Static per-route CRUD permission gate. The permission and action are known
 * at route-registration time, so the gate is a plain preHandler.
 *
 * Actions use the dynamic counterpart `buildActionPermissionMw` — their
 * permission is resolved from `body.action` at request time.
 */
export function buildCrudPermissionMw(
  permissionCheck: PermissionCheck | undefined,
  resourceName: string,
  action: string,
): RouteHandlerMethod | null {
  if (!permissionCheck) return null;
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const context = buildPermissionContext(req, { resource: resourceName, action });
    await evaluateAndApplyPermission(permissionCheck, context, req, reply);
    // evaluateAndApplyPermission returns false when it sends a response;
    // Fastify treats a sent reply as terminating the preHandler chain.
  };
}

/**
 * Dynamic per-action permission gate for the action router.
 *
 * Resolves the permission from `body.action` at request time and runs
 * `evaluateAndApplyPermission` from the canonical `permissionMw` slot — so
 * `_policyFilters` and `request.scope` are installed BEFORE `pluginMw`
 * (idempotency) and `routeGuards` run. Previously this check lived inside
 * the main action handler, which meant idempotency recorded unauthorized
 * requests and route guards saw unfiltered scope — the very divergence
 * routerShared exists to prevent.
 *
 * Also acts as a defensive fallback for invalid action names — the
 * `oneOf` body schema normally rejects these at AJV validation, but
 * hosts that disable schema validation still get a 400 here.
 */
export function buildActionPermissionMw(
  actionEnum: readonly string[],
  actionPermissions: Record<string, PermissionCheck>,
  globalAuth: PermissionCheck | undefined,
  resourceName: string,
): RouteHandlerMethod {
  const enumSet = new Set(actionEnum);
  const validActions = [...actionEnum];
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = (req.body ?? {}) as { action?: string } & Record<string, unknown>;
    const action = body.action;

    if (!action || !enumSet.has(action)) {
      // Throw a canonical 400 ArcError — the global error handler emits the
      // ErrorContract shape with `details.validActions` for consumers.
      throw createError(
        400,
        `Invalid action '${action ?? ""}'. Valid actions: ${validActions.join(", ")}`,
        { validActions },
      );
    }

    const permissionCheck = actionPermissions[action] ?? globalAuth;
    if (!permissionCheck) return;

    const { action: _discard, ...data } = body;
    const params = req.params as { id?: string } | undefined;
    const context = buildPermissionContext(req, {
      resource: resourceName,
      action,
      resourceId: params?.id,
      data,
    });
    await evaluateAndApplyPermission(permissionCheck, context, req, reply, {
      defaultDenialMessage: (user) =>
        user ? `Permission denied for '${action}'` : "Authentication required",
    });
  };
}

// ============================================================================
// Pipeline handlers
// ============================================================================

/**
 * Resolve pipeline steps for a specific operation.
 * Flat-array config applies to every op; map config applies per-op.
 */
export function resolvePipelineSteps(
  pipeline: PipelineConfig | undefined,
  operation: string,
): PipelineStep[] {
  if (!pipeline) return [];
  if (Array.isArray(pipeline)) return pipeline;
  return pipeline[operation] ?? [];
}

/**
 * Wrap a controller method (one that takes `IRequestContext` and returns
 * `IControllerResponse<T>`) with pipeline execution. Used by CRUD ops and
 * string-handler custom routes.
 */
export function buildPipelineHandler<T>(
  controllerMethod: (ctx: IRequestContext) => Promise<IControllerResponse<T>>,
  steps: PipelineStep[],
  operation: string,
  resourceName: string,
): RouteHandlerMethod {
  return async (req, reply): Promise<void> => {
    const reqCtx = createRequestContext(req);
    const pipeCtx: PipelineContext = { ...reqCtx, resource: resourceName, operation };
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
 * Wrap an action handler (one that takes `(id, data, req)` and returns a raw
 * result) with pipeline execution. Returns a function that produces a full
 * `IControllerResponse<unknown>` — the action router feeds this directly into
 * `sendControllerResponse`, so field masking, custom status codes, `meta`,
 * `details`, and structured error codes from pipeline interceptors flow
 * through to the client unchanged.
 *
 * CRUD and actions now share the same parity invariant: a pipeline that
 * returns `{ success: false, status: 422, error, details, meta }` reaches the
 * client with all four fields intact. Previously the action path stringified
 * failures into a generic `Error` and dropped everything except `statusCode`.
 *
 * Handler throws still bubble out — the caller's try/catch handles `onError`
 * shaping and the generic `ACTION_FAILED` fallback.
 */
export function buildActionPipelineHandler(
  handler: (id: string, data: Record<string, unknown>, req: RequestWithExtras) => Promise<unknown>,
  steps: PipelineStep[],
  operation: string,
  resourceName: string,
): (
  id: string,
  data: Record<string, unknown>,
  req: RequestWithExtras,
) => Promise<IControllerResponse<unknown>> {
  if (steps.length === 0) {
    return async (id, data, req) => ({
      status: 200,
      data: await handler(id, data, req),
    });
  }
  return async (id, data, req) => {
    const reqCtx = createRequestContext(req);
    const pipeCtx: PipelineContext = { ...reqCtx, resource: resourceName, operation };
    return executePipeline(
      steps,
      pipeCtx,
      async (_ctx) => ({
        status: 200,
        data: await handler(id, data, req),
      }),
      operation,
    );
  };
}

// ============================================================================
// Rate limit config
// ============================================================================

/**
 * Build the `config` object for Fastify route options so
 * @fastify/rate-limit picks up per-route overrides.
 *
 *   - `undefined`                 → no override (inherits instance config)
 *   - `false`                     → explicitly disable rate limiting
 *   - `{ max, timeWindow }`       → apply that limit
 */
export function buildRateLimitConfig(
  rateLimit: RateLimitConfig | false | undefined,
): RouteRateLimitConfig | undefined {
  if (rateLimit === undefined) return undefined;
  if (rateLimit === false) return { rateLimit: false };
  return {
    rateLimit: {
      max: rateLimit.max,
      timeWindow: rateLimit.timeWindow,
    },
  };
}

// ============================================================================
// Plugin middleware selection
// ============================================================================

/**
 * Pick the request-lifecycle plugin middleware for an HTTP method:
 *   - GET / HEAD        → response cache (if present)
 *   - POST / PUT / PATCH → idempotency (if present)
 *   - DELETE            → none
 *
 * Either field may be `null` if the corresponding plugin wasn't registered.
 */
export function selectPluginMw(method: string, mws: RouterPluginMw): RouteHandlerMethod | null {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD") return mws.cacheMw;
  if (upper === "POST" || upper === "PUT" || upper === "PATCH") return mws.idempotencyMw;
  return null;
}

/**
 * Resolve the default cache/idempotency middlewares for a resource.
 *
 * Skips response-cache when the resource has QueryCache active — QueryCache
 * handles caching at the controller level with SWR, so the HTTP-level
 * response-cache would double-cache.
 */
export function resolveRouterPluginMw(
  fastify: FastifyWithDecorators,
  resourceHasQueryCache: boolean,
): RouterPluginMw {
  const cacheMw: RouteHandlerMethod | null =
    !resourceHasQueryCache && fastify.hasDecorator("responseCache")
      ? (fastify.responseCache.middleware as RouteHandlerMethod)
      : null;
  const idempotencyMw: RouteHandlerMethod | null = fastify.hasDecorator("idempotency")
    ? (fastify.idempotency.middleware as RouteHandlerMethod)
    : null;
  return { cacheMw, idempotencyMw };
}

// ============================================================================
// PreHandler chain composition
// ============================================================================

/**
 * Compose preHandler[] in the canonical order. Every null/undefined entry is
 * dropped. Keeps CRUD and Action routers from accidentally ordering the same
 * ingredients differently (regression risk: cache before auth → user-scoped
 * cache keys leak across users).
 *
 * Canonical order:
 *   preAuth → arcDecorator → authMw → permissionMw → pluginMw → routeGuards → customMws
 */
export function buildPreHandlerChain(parts: {
  preAuth?: ReadonlyArray<PreHandlerHook | null | undefined>;
  arcDecorator: RouteHandlerMethod;
  authMw?: RouteHandlerMethod | null;
  permissionMw?: RouteHandlerMethod | null;
  pluginMw?: RouteHandlerMethod | null;
  routeGuards?: ReadonlyArray<RouteHandlerMethod | null | undefined>;
  customMws?: ReadonlyArray<PreHandlerHook | null | undefined>;
}): PreHandlerHook[] {
  return [
    ...(parts.preAuth ?? []),
    parts.arcDecorator,
    parts.authMw ?? null,
    parts.permissionMw ?? null,
    parts.pluginMw ?? null,
    ...(parts.routeGuards ?? []),
    ...(parts.customMws ?? []),
  ].filter(Boolean) as PreHandlerHook[];
}

// ============================================================================
// resolveRoutePreHandlers — turn `RouteDefinition.preHandler` into a flat array
// ============================================================================

/**
 * `RouteDefinition.preHandler` accepts two shapes:
 *
 *   1. **Array form** — `RouteHandlerMethod[]`. Used directly.
 *   2. **Factory form** — `(fastify) => RouteHandlerMethod[]`. Called once at
 *      route-registration time with the Fastify instance, so handlers can
 *      capture decorators (`fastify.authenticate`, `fastify.events`, etc.)
 *      that aren't on the request.
 *
 * The two forms are equally idiomatic, but the discrimination is by
 * `typeof preHandler === "function"`. Single-function shapes such as
 * `multipartBody({...})` (a `RouteHandlerMethod`) **structurally satisfy
 * the factory branch** at the call site, then fail with a cryptic
 * `Cannot read properties of undefined (reading 'content-type')` once the
 * handler runs with `fastify` in the request slot.
 *
 * This resolver:
 *   1. Distinguishes the two valid shapes.
 *   2. Validates the factory's RETURN — must be an array of functions.
 *   3. Throws an actionable error pointing at the route + the fix when
 *      a single `RouteHandlerMethod` was passed instead of an array, OR
 *      when a factory returned the wrong shape.
 *
 * The error message names the route (`{method} {path}`) and the
 * canonical fix (`preHandler: [yourHandler]`) so the failure mode is
 * obvious instead of debug-archaeology.
 *
 * @param preHandler  The `route.preHandler` value (any of the valid shapes
 *                    plus the common bare-handler mistake).
 * @param fastify     Passed to factory-form preHandlers.
 * @param routeId     `"GET /todos/:id/attach"` (or similar) — used in the
 *                    error message so a multi-route file points at the
 *                    actual offender.
 */
export function resolveRoutePreHandlers(
  preHandler: unknown,
  fastify: FastifyWithDecorators,
  routeId: string,
): PreHandlerHook[] {
  if (preHandler === undefined || preHandler === null) return [];

  // Array form — wrap each entry through a presence filter to drop nulls
  if (Array.isArray(preHandler)) {
    return preHandler.filter((h): h is PreHandlerHook => typeof h === "function");
  }

  // Factory form — call with fastify, validate the return shape
  if (typeof preHandler === "function") {
    let result: unknown;
    try {
      result = (preHandler as (f: FastifyWithDecorators) => unknown)(fastify);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TypeError(
        `Route ${routeId}: preHandler factory threw during route registration: ${msg}.\n` +
          `If you intended to pass a single handler (e.g. \`multipartBody({...})\`), ` +
          `wrap it in an array: \`preHandler: [yourHandler]\`. ` +
          `The factory form is \`(fastify) => RouteHandlerMethod[]\` — it must return an array.`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
    // Async preHandlers (`async function (req, reply) {...}`) return a Promise
    // when invoked here — the body would crash on `request.headers` since we
    // passed `fastify` as the first arg. Swallow that rejection BEFORE we
    // throw the actionable TypeError below; otherwise it surfaces as an
    // unhandled rejection in a separate microtask and pollutes test logs /
    // process.unhandledRejection listeners.
    if (result && typeof (result as { then?: unknown }).then === "function") {
      (result as Promise<unknown>).catch(() => undefined);
    }
    if (!Array.isArray(result)) {
      throw new TypeError(
        `Route ${routeId}: preHandler factory must return an array of handlers, got ${describeValue(
          result,
        )}.\n` +
          `Common cause: passing a single \`RouteHandlerMethod\` (e.g. \`multipartBody({...})\`) ` +
          `where an array was expected. Wrap it: \`preHandler: [yourHandler]\`. ` +
          `The factory form \`(fastify) => RouteHandlerMethod[]\` is for cases that need the ` +
          `Fastify instance — e.g. \`(fastify) => [fastify.authenticate, myHandler]\`.`,
      );
    }
    return result.filter((h): h is PreHandlerHook => typeof h === "function");
  }

  // Anything else is a programming error — not a string, not an object.
  throw new TypeError(
    `Route ${routeId}: preHandler must be an array of handlers OR a factory ` +
      `\`(fastify) => RouteHandlerMethod[]\`. Got ${describeValue(preHandler)}.`,
  );
}

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "function") return "a function (single handler — wrap in array)";
  if (Array.isArray(v)) return `an array of length ${v.length}`;
  return `${typeof v} (${JSON.stringify(v).slice(0, 80)})`;
}
