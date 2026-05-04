/**
 * Scope Module — The One Standard for Arc
 *
 * `request.scope` replaces all scattered org context fields.
 *
 * @example
 * ```typescript
 * import { isMember, isElevated, getOrgId } from '@classytic/arc/scope';
 *
 * // In a permission check
 * if (isElevated(request.scope)) return true;
 * if (isMember(request.scope) && request.scope.orgRoles.includes('admin')) return true;
 *
 * // Get org ID regardless of scope kind
 * const orgId = getOrgId(request.scope);
 * ```
 */

export type { ElevationEvent, ElevationOptions } from "./elevation.js";
// Elevation plugin
export { default as elevationPlugin, elevationPlugin as elevationPluginFn } from "./elevation.js";
export type { RateLimitKeyContext, TenantKeyGeneratorOptions } from "./rateLimitKey.js";
// Per-tenant rate limit key generator
export { createTenantKeyGenerator } from "./rateLimitKey.js";
export type { ResolveOrgFromHeaderOptions } from "./resolveOrgFromHeader.js";
// Org-from-header utility
export { resolveOrgFromHeader } from "./resolveOrgFromHeader.js";
// Core types and guards
export type { Mandate, RequestScope } from "./types.js";
export {
  AUTHENTICATED_SCOPE,
  getAncestorOrgIds,
  getClientId,
  getDPoPJkt,
  getMandate,
  getOrgContext,
  getOrgId,
  getOrgRoles,
  getRequestScope,
  getScopeContext,
  getScopeContextMap,
  getServiceScopes,
  getTeamId,
  getUserId,
  getUserRoles,
  hasOrgAccess,
  isAuthenticated,
  isElevated,
  isMember,
  isOrgInScope,
  isService,
  PUBLIC_SCOPE,
  // Throwing accessors — symmetric `require*` family. Throw `OrgRequiredError`
  // / `UnauthorizedError` so handlers don't hand-roll inconsistent throws.
  requireClientId,
  requireOrgId,
  requireTeamId,
  requireUserId,
} from "./types.js";
