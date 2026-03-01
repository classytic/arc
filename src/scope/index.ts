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

// Core types and guards
export type { RequestScope } from './types.js';
export {
  isMember,
  isElevated,
  hasOrgAccess,
  isAuthenticated,
  getOrgId,
  getOrgRoles,
  getTeamId,
  PUBLIC_SCOPE,
  AUTHENTICATED_SCOPE,
} from './types.js';

// Elevation plugin
export { default as elevationPlugin, elevationPlugin as elevationPluginFn } from './elevation.js';
export type { ElevationOptions, ElevationEvent } from './elevation.js';

// Org-from-header utility
export { resolveOrgFromHeader } from './resolveOrgFromHeader.js';
export type { ResolveOrgFromHeaderOptions } from './resolveOrgFromHeader.js';
