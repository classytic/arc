/**
 * Shared Router Primitives
 *
 * The CRUD router (`createCrudRouter`) and the action router (`createActionRouter`)
 * share everything except the per-route shape. This module is the single source
 * of truth for the pieces that must not drift between them — each concern lives
 * in its own module under `middlewares/` and is re-exported here:
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

export { type ArcRouteMeta, buildArcDecorator } from "./middlewares/arcDecorator.js";
export {
  buildAuthMiddleware,
  buildAuthMiddlewareForPermissions,
  requiresAuthentication,
} from "./middlewares/auth.js";
export {
  buildPreHandlerChain,
  type PreHandlerHook,
  resolveRoutePreHandlers,
} from "./middlewares/chain.js";
export { buildFieldWritePreHandler, methodCarriesBody } from "./middlewares/fieldWrite.js";
export {
  buildActionPermissionMw,
  buildCrudPermissionMw,
  buildPermissionContext,
} from "./middlewares/permissions.js";
export {
  buildActionPipelineHandler,
  buildPipelineHandler,
  resolvePipelineSteps,
} from "./middlewares/pipeline.js";
export {
  type RouterPluginMw,
  resolveRouterPluginMw,
  selectPluginMw,
} from "./middlewares/pluginMw.js";
export { buildRateLimitConfig, type RouteRateLimitConfig } from "./middlewares/rateLimit.js";
export { tryRegisterRoute } from "./middlewares/registerRoute.js";
