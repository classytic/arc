/**
 * Permission System
 *
 * Clean, function-based permission system.
 * PermissionCheck is THE ONLY way to define permissions.
 *
 * @example
 * ```typescript
 * import { allowPublic, requireAuth, requireRoles } from '@classytic/arc/permissions';
 *
 * defineResource({
 *   permissions: {
 *     list: allowPublic(),
 *     get: allowPublic(),
 *     create: requireAuth(),
 *     update: requireRoles(['admin', 'editor']),
 *     delete: requireRoles(['admin']),
 *   }
 * });
 * ```
 */

// Re-export types
export type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
  UserBase,
} from './types.js';

import type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
} from './types.js';

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Allow public access (no authentication required)
 *
 * @example
 * ```typescript
 * permissions: {
 *   list: allowPublic(),
 *   get: allowPublic(),
 * }
 * ```
 */
export function allowPublic(): PermissionCheck {
  return () => true;
}

/**
 * Require authentication (any authenticated user)
 *
 * @example
 * ```typescript
 * permissions: {
 *   create: requireAuth(),
 *   update: requireAuth(),
 * }
 * ```
 */
export function requireAuth(): PermissionCheck {
  return (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: 'Authentication required' };
    }
    return true;
  };
}

/**
 * Require specific roles
 *
 * @param roles - Required roles (user needs at least one)
 * @param options - Optional bypass roles
 *
 * @example
 * ```typescript
 * permissions: {
 *   create: requireRoles(['admin', 'editor']),
 *   delete: requireRoles(['admin']),
 * }
 *
 * // With bypass roles
 * permissions: {
 *   update: requireRoles(['owner'], { bypassRoles: ['admin', 'superadmin'] }),
 * }
 * ```
 */
export function requireRoles(
  roles: readonly string[],
  options?: { bypassRoles?: readonly string[] }
): PermissionCheck {
  return (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: 'Authentication required' };
    }

    const userRoles = (ctx.user.roles ?? []) as string[];

    // Check bypass roles first
    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

    // Check required roles (any match)
    if (roles.some((r) => userRoles.includes(r))) {
      return true;
    }

    return {
      granted: false,
      reason: `Required roles: ${roles.join(', ')}`,
    };
  };
}

/**
 * Require resource ownership
 *
 * Returns filters to scope queries to user's owned resources.
 *
 * @param ownerField - Field containing owner ID (default: 'userId')
 * @param options - Optional bypass roles
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: requireOwnership('userId'),
 *   delete: requireOwnership('createdBy', { bypassRoles: ['admin'] }),
 * }
 * ```
 */
export function requireOwnership(
  ownerField: string = 'userId',
  options?: { bypassRoles?: readonly string[] }
): PermissionCheck {
  return (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: 'Authentication required' };
    }

    const userRoles = (ctx.user.roles ?? []) as string[];

    // Check bypass roles
    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

    // Return filters to scope to owned resources
    const userId = ctx.user.id ?? ctx.user._id;
    return {
      granted: true,
      filters: { [ownerField]: userId },
    };
  };
}

/**
 * Combine multiple checks - ALL must pass (AND logic)
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: allOf(
 *     requireAuth(),
 *     requireRoles(['editor']),
 *     requireOwnership('createdBy')
 *   ),
 * }
 * ```
 */
export function allOf(...checks: PermissionCheck[]): PermissionCheck {
  return async (ctx) => {
    let mergedFilters: Record<string, unknown> = {};

    for (const check of checks) {
      const result = await check(ctx);
      const normalized: PermissionResult =
        typeof result === 'boolean' ? { granted: result } : result;

      if (!normalized.granted) {
        return normalized;
      }

      // Merge filters
      if (normalized.filters) {
        mergedFilters = { ...mergedFilters, ...normalized.filters };
      }
    }

    return {
      granted: true,
      filters: Object.keys(mergedFilters).length > 0 ? mergedFilters : undefined,
    };
  };
}

/**
 * Combine multiple checks - ANY must pass (OR logic)
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: anyOf(
 *     requireRoles(['admin']),
 *     requireOwnership('createdBy')
 *   ),
 * }
 * ```
 */
export function anyOf(...checks: PermissionCheck[]): PermissionCheck {
  return async (ctx) => {
    const reasons: string[] = [];

    for (const check of checks) {
      const result = await check(ctx);
      const normalized: PermissionResult =
        typeof result === 'boolean' ? { granted: result } : result;

      if (normalized.granted) {
        return normalized;
      }

      if (normalized.reason) {
        reasons.push(normalized.reason);
      }
    }

    return {
      granted: false,
      reason: reasons.join('; '),
    };
  };
}

/**
 * Deny all access
 *
 * @example
 * ```typescript
 * permissions: {
 *   delete: denyAll('Deletion not allowed'),
 * }
 * ```
 */
export function denyAll(reason = 'Access denied'): PermissionCheck {
  return () => ({ granted: false, reason });
}

/**
 * Dynamic permission based on context
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: when((ctx) => ctx.data?.status === 'draft'),
 * }
 * ```
 */
export function when(
  condition: (ctx: PermissionContext) => boolean | Promise<boolean>
): PermissionCheck {
  return async (ctx) => {
    const result = await condition(ctx);
    return {
      granted: result,
      reason: result ? undefined : 'Condition not met',
    };
  };
}
