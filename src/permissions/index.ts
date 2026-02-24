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

// Permission presets — common patterns in one call
import * as presets from './presets.js';
export { presets as permissions };
export {
  publicRead,
  publicReadAdminWrite,
  authenticated,
  adminOnly,
  ownerWithAdminBypass,
  fullPublic,
  readOnly,
} from './presets.js';

// Field-level permissions
export { fields, applyFieldReadPermissions, applyFieldWritePermissions } from './fields.js';
export type { FieldPermission, FieldPermissionMap, FieldPermissionType } from './fields.js';

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
  const check: PermissionCheck = () => true;
  // Mark as public for OpenAPI documentation and introspection
  (check as any)._isPublic = true;
  return check;
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
  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: 'Authentication required' };
    }
    return true;
  };
  return check;
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
  const check: PermissionCheck = (ctx) => {
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
  (check as any)._roles = roles;
  return check;
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
    if (!userId) {
      return { granted: false, reason: 'User identity missing (no id or _id)' };
    }
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

// ============================================================================
// Organization Permission Helpers
// ============================================================================

/** Extract org roles from request context (set by Better Auth adapter or orgScopePlugin) */
function getOrgContext(request: unknown): {
  organizationId?: string;
  orgRoles?: string[];
  orgScope?: string;
} {
  const req = request as Record<string, any>;
  return {
    organizationId: req?.organizationId ?? req?.context?.organizationId,
    orgRoles: req?.context?.orgRoles ?? [],
    orgScope: req?.context?.orgScope,
  };
}

/**
 * Require membership in the active organization.
 * User must be authenticated AND a member of the active org.
 *
 * Reads `request.context.orgRoles` populated by the Better Auth adapter
 * (with `orgContext: true`) or any middleware that sets the same shape.
 *
 * @example
 * ```typescript
 * permissions: {
 *   list: requireOrgMembership(),
 *   get: requireOrgMembership(),
 * }
 * ```
 */
export function requireOrgMembership(
  options?: { bypassRoles?: readonly string[] }
): PermissionCheck {
  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: 'Authentication required' };
    }

    const userRoles = (ctx.user.roles ?? []) as string[];
    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

    const org = getOrgContext(ctx.request);

    // Bypass scope = superadmin-level, always pass
    if (org.orgScope === 'bypass') return true;

    if (!org.organizationId) {
      return { granted: false, reason: 'No active organization' };
    }

    if (!org.orgRoles || org.orgRoles.length === 0) {
      return { granted: false, reason: 'Not a member of this organization' };
    }

    return true;
  };
  (check as any)._orgPermission = 'membership';
  return check;
}

/**
 * Require specific org-level roles.
 * Checks `request.context.orgRoles` (populated by Better Auth adapter or orgScopePlugin).
 *
 * @param roles - Required org roles (user needs at least one)
 * @param options - Optional bypass roles (checked against global user.roles)
 *
 * @example
 * ```typescript
 * permissions: {
 *   create: requireOrgRole('admin', 'owner'),
 *   delete: requireOrgRole('owner'),
 * }
 * ```
 */
export function requireOrgRole(
  ...args: string[] | [readonly string[], { bypassRoles?: readonly string[] }?]
): PermissionCheck {
  // Support both: requireOrgRole('admin', 'owner') and requireOrgRole(['admin'], { bypassRoles: [...] })
  let roles: readonly string[];
  let options: { bypassRoles?: readonly string[] } | undefined;

  if (Array.isArray(args[0])) {
    roles = args[0] as readonly string[];
    options = args[1] as { bypassRoles?: readonly string[] } | undefined;
  } else {
    roles = args as string[];
    options = undefined;
  }

  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: 'Authentication required' };
    }

    const userRoles = (ctx.user.roles ?? []) as string[];
    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

    const org = getOrgContext(ctx.request);

    if (org.orgScope === 'bypass') return true;

    if (!org.organizationId) {
      return { granted: false, reason: 'No active organization' };
    }

    if (!org.orgRoles || org.orgRoles.length === 0) {
      return { granted: false, reason: 'Not a member of this organization' };
    }

    if (roles.some((r) => org.orgRoles!.includes(r))) {
      return true;
    }

    return {
      granted: false,
      reason: `Required org roles: ${roles.join(', ')}`,
    };
  };
  (check as any)._orgRoles = roles;
  return check;
}

/**
 * Create a scoped permission system for resource-action patterns.
 * Maps org roles to fine-grained permissions without external API calls.
 *
 * @example
 * ```typescript
 * const perms = createOrgPermissions({
 *   statements: {
 *     product: ['create', 'update', 'delete'],
 *     order: ['create', 'approve'],
 *   },
 *   roles: {
 *     owner: { product: ['create', 'update', 'delete'], order: ['create', 'approve'] },
 *     admin: { product: ['create', 'update'], order: ['create'] },
 *     member: { product: [], order: [] },
 *   },
 * });
 *
 * defineResource({
 *   permissions: {
 *     create: perms.can({ product: ['create'] }),
 *     delete: perms.can({ product: ['delete'] }),
 *   }
 * });
 * ```
 */
export function createOrgPermissions(config: {
  statements: Record<string, readonly string[]>;
  roles: Record<string, Record<string, readonly string[]>>;
  bypassRoles?: readonly string[];
}): {
  can: (permissions: Record<string, string[]>) => PermissionCheck;
  requireRole: (...roles: string[]) => PermissionCheck;
  requireMembership: () => PermissionCheck;
  requireTeamMembership: () => PermissionCheck;
} {
  const { roles: roleMap, bypassRoles } = config;

  function hasPermissions(
    orgRoles: string[],
    required: Record<string, string[]>
  ): boolean {
    // User's effective permissions = union of all their role permissions
    for (const [resource, actions] of Object.entries(required)) {
      for (const action of actions) {
        const granted = orgRoles.some((role) => {
          const perms = roleMap[role]?.[resource];
          return perms?.includes(action);
        });
        if (!granted) return false;
      }
    }
    return true;
  }

  return {
    can(permissions: Record<string, string[]>): PermissionCheck {
      return (ctx) => {
        if (!ctx.user) {
          return { granted: false, reason: 'Authentication required' };
        }

        const userRoles = (ctx.user.roles ?? []) as string[];
        if (bypassRoles?.some((r) => userRoles.includes(r))) {
          return true;
        }

        const org = getOrgContext(ctx.request);
        if (org.orgScope === 'bypass') return true;

        if (!org.organizationId) {
          return { granted: false, reason: 'No active organization' };
        }

        if (!org.orgRoles || org.orgRoles.length === 0) {
          return { granted: false, reason: 'Not a member of this organization' };
        }

        if (hasPermissions(org.orgRoles, permissions)) {
          return true;
        }

        const needed = Object.entries(permissions)
          .map(([r, a]) => `${r}:[${a.join(',')}]`)
          .join(', ');
        return {
          granted: false,
          reason: `Missing permissions: ${needed}`,
        };
      };
    },

    requireRole(...roles: string[]): PermissionCheck {
      return requireOrgRole(roles, { bypassRoles });
    },

    requireMembership(): PermissionCheck {
      return requireOrgMembership({ bypassRoles });
    },

    requireTeamMembership(): PermissionCheck {
      return requireTeamMembership({ bypassRoles });
    },
  };
}

// ============================================================================
// Team Permission Helpers
// ============================================================================

/** Extract team context from request (set by Better Auth adapter) */
function getTeamContext(request: unknown): { teamId?: string } {
  const req = request as Record<string, any>;
  return { teamId: req?.teamId ?? req?.context?.teamId };
}

/**
 * Require membership in the active team.
 * User must be authenticated, a member of the active org, AND have an active team.
 *
 * Better Auth teams are flat member groups (no team-level roles).
 * Reads `request.context.teamId` populated by the Better Auth adapter.
 *
 * @example
 * ```typescript
 * permissions: {
 *   list: requireTeamMembership(),
 *   create: requireTeamMembership(),
 * }
 * ```
 */
export function requireTeamMembership(
  options?: { bypassRoles?: readonly string[] }
): PermissionCheck {
  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: 'Authentication required' };
    }

    const userRoles = (ctx.user.roles ?? []) as string[];
    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

    const org = getOrgContext(ctx.request);

    // Bypass scope = superadmin-level, always pass
    if (org.orgScope === 'bypass') return true;

    if (!org.organizationId) {
      return { granted: false, reason: 'No active organization' };
    }

    if (!org.orgRoles || org.orgRoles.length === 0) {
      return { granted: false, reason: 'Not a member of this organization' };
    }

    const team = getTeamContext(ctx.request);
    if (!team.teamId) {
      return { granted: false, reason: 'No active team' };
    }

    return true;
  };
  (check as any)._teamPermission = 'membership';
  return check;
}
