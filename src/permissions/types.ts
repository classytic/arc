/**
 * Permission Types - Core Type Definitions
 *
 * PermissionCheck is THE ONLY way to define permissions in Arc.
 * No string arrays, no alternative patterns.
 */

import type { FastifyRequest } from "fastify";

/**
 * User base interface - minimal shape Arc expects
 * Your actual User can have any additional fields
 */
export interface UserBase {
  id?: string;
  _id?: string;
  /** User roles — string (comma-separated), string[], or undefined. Matches Better Auth's admin plugin pattern. */
  role?: string | string[];
  [key: string]: unknown;
}

/**
 * Extract normalized roles from a user object.
 *
 * Reads `user.role` which can be:
 * - A comma-separated string: `"superadmin,user"` (Better Auth admin plugin)
 * - A string array: `["admin", "user"]` (JWT / custom auth)
 * - A single string: `"admin"`
 */
/**
 * Normalize a raw role value (string, comma-separated string, or array) into a string[].
 * Shared low-level helper used by both getUserRoles() and the Better Auth adapter.
 */
export function normalizeRoles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((r) => String(r).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.length > 0) {
    return value.split(',').map((r) => r.trim()).filter(Boolean);
  }
  return [];
}

export function getUserRoles(user: UserBase | null | undefined): string[] {
  if (!user) return [];
  return normalizeRoles(user.role);
}

/**
 * Context passed to permission check functions
 */
export interface PermissionContext<TDoc = any> {
  /** Authenticated user or null if unauthenticated */
  user: UserBase | null;
  /** Fastify request object */
  request: FastifyRequest;
  /** Resource name being accessed */
  resource: string;
  /** Action being performed (list, get, create, update, delete, or custom operation name) */
  action: string;
  /** Resource ID for single-resource operations (shortcut for params.id) */
  resourceId?: string;
  /** All route parameters (slug, parentId, custom params, etc.) */
  params?: Record<string, string>;
  /** Request body data */
  data?: Partial<TDoc> | Record<string, unknown>;
}

/**
 * Result from permission check
 */
export interface PermissionResult {
  /** Whether access is granted */
  granted: boolean;
  /** Reason for denial (for error messages) */
  reason?: string;
  /** Query filters to apply (for ownership patterns) */
  filters?: Record<string, unknown>;
}

/**
 * Permission Check Function
 *
 * THE ONLY way to define permissions in Arc.
 * Returns boolean, PermissionResult, or Promise of either.
 *
 * @example
 * ```typescript
 * // Simple boolean return
 * const isAdmin: PermissionCheck = (ctx) => getUserRoles(ctx.user).includes('admin');
 *
 * // With filters for ownership
 * const ownedByUser: PermissionCheck = (ctx) => ({
 *   granted: true,
 *   filters: { userId: ctx.user?.id }
 * });
 *
 * // Async check
 * const canAccessOrg: PermissionCheck = async (ctx) => {
 *   const isMember = await checkMembership(ctx.user?.id, ctx.organizationId);
 *   return { granted: isMember, reason: isMember ? undefined : 'Not a member' };
 * };
 * ```
 */
export type PermissionCheck<TDoc = any> = ((
  context: PermissionContext<TDoc>,
) => boolean | PermissionResult | Promise<boolean | PermissionResult>) &
  PermissionCheckMeta;

/**
 * Optional metadata attached to permission check functions.
 * Used for OpenAPI docs, introspection, and route-level auth decisions.
 */
export interface PermissionCheckMeta {
  /** Set by allowPublic() — marks the endpoint as publicly accessible */
  _isPublic?: boolean;
  /** Set by requireRoles() — the roles required for access */
  _roles?: readonly string[];
  /** Set by requireOrgMembership() — org-level permission type */
  _orgPermission?: string;
  /** Set by requireOrgRole() — the org roles required for access */
  _orgRoles?: readonly string[];
  /** Set by requireTeamMembership() — team-level permission type */
  _teamPermission?: string;
}
