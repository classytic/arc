/**
 * Shared projection from a full `RequestScope` discriminated union
 * → the lightweight `{ organizationId, userId, orgRoles }` shape that
 * 95% of arc's tenant-scoped code actually reads.
 *
 * One implementation, two consumers:
 * - `IRequestContext.scope` (via `core/fastifyAdapter.ts`) — hosts use it
 *   in controller overrides and custom route handlers.
 * - `ResourceHookContext.scope` (via `core/defineResource.ts` hook
 *   wrapper) — hosts use it in inline `config.hooks.{beforeCreate, ...}`
 *   handlers.
 *
 * Having one helper keeps both surfaces in lockstep — when arc grows
 * a new scope-derived field (e.g. `teamId`), every entry point that
 * exposes the projection picks it up automatically.
 */

import type { RequestScope } from "./types.js";
import { getOrgId, getUserId, isMember } from "./types.js";

/**
 * Lightweight projection of `RequestScope` — just the fields tenant-aware
 * hooks and controllers usually read. Full discriminated-union access is
 * still available through the underlying `RequestScope` for advanced
 * branching on `scope.kind`.
 */
export interface RequestScopeProjection {
  /** Tenant the caller is scoped to (member, pinned elevated admin, service key bound to an org). */
  organizationId?: string;
  /** Caller's user id when authenticated — undefined for public / service-only scopes. */
  userId?: string;
  /** Org-level roles (e.g. `['admin', 'warehouse-manager']`) — separate from global `user.roles`. */
  orgRoles?: string[];
}

/**
 * Compute the request-scope projection. Returns `undefined` when no
 * scope is attached (public / unscoped routes) so hosts can idiomatically
 * write `ctx.scope?.organizationId` without a double-null check.
 */
export function buildRequestScopeProjection(
  scope: RequestScope | undefined,
): RequestScopeProjection | undefined {
  if (!scope) return undefined;
  return {
    organizationId: getOrgId(scope),
    userId: getUserId(scope),
    orgRoles: isMember(scope) ? scope.orgRoles : undefined,
  };
}
