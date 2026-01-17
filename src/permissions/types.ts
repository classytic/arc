/**
 * Permission Types - Core Type Definitions
 *
 * PermissionCheck is THE ONLY way to define permissions in Arc.
 * No string arrays, no alternative patterns.
 */

import type { FastifyRequest } from 'fastify';

/**
 * User base interface - minimal shape Arc expects
 * Your actual User can have any additional fields
 */
export interface UserBase {
  id?: string;
  _id?: string;
  roles?: string[];
  [key: string]: unknown;
}

/**
 * Context passed to permission check functions
 */
export interface PermissionContext {
  /** Authenticated user or null if unauthenticated */
  user: UserBase | null;
  /** Fastify request object */
  request: FastifyRequest;
  /** Resource name being accessed */
  resource: string;
  /** Action being performed (list, get, create, update, delete) */
  action: string;
  /** Resource ID for single-resource operations */
  resourceId?: string;
  /** Organization context for multi-tenant apps */
  organizationId?: string;
  /** Request body data */
  data?: Record<string, unknown>;
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
 * const isAdmin: PermissionCheck = (ctx) => ctx.user?.roles?.includes('admin') ?? false;
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
export type PermissionCheck = (
  context: PermissionContext
) => boolean | PermissionResult | Promise<boolean | PermissionResult>;
