/**
 * Shared projection from a full `RequestScope` discriminated union
 * → the lightweight tenant/actor shape that
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
import { getOrgId, getScopeContextMap, getTeamId, getUserId, isMember } from "./types.js";

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
  /** Active team for member scopes. */
  teamId?: string;
  /** Host-defined project / branch / region / workspace dimensions. */
  context?: Readonly<Record<string, string>>;
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
    teamId: getTeamId(scope),
    context: freezeContext(getScopeContextMap(scope)),
  };
}

/**
 * Hand out a FROZEN COPY of the scope's context, never the live map.
 *
 * `Readonly<Record<string, string>>` is erased at runtime, so the annotation
 * alone protected nothing: `getScopeContextMap` returns the scope's own
 * object, and a hook doing `ctx.scope.context.branchId = 'other'` mutated the
 * caller's REAL scope. That matters because `requireScopeContext()` authorises
 * against exactly these values — a later permission check in the same request
 * would read the tampered dimension and allow what it should refuse.
 *
 * A copy rather than freezing in place: the map belongs to whoever built the
 * scope (a host auth function), and freezing someone else's object as a side
 * effect of reading it is a surprise a library should not spring. Copying also
 * makes the guarantee deterministic instead of "frozen once something happens
 * to call the accessor".
 *
 * ESM is always strict mode, so a write to the frozen copy THROWS rather than
 * failing silently — the mistake surfaces where it is made.
 */
function freezeContext(
  ctx: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  return ctx === undefined ? undefined : Object.freeze({ ...ctx });
}
