/**
 * Authentication middleware selection — choose `authenticate` vs
 * `optionalAuthenticate` from a single permission or a set of permissions.
 */

import type { RouteHandlerMethod } from "fastify";

import type { PermissionCheck } from "../../permissions/types.js";
import type { FastifyWithDecorators } from "../../types/index.js";

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
