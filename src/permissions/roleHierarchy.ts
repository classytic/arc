/**
 * Role Hierarchy — Composable RBAC Inheritance
 *
 * Expands roles based on an inheritance map. Apply at scope-building time
 * so that requireRoles() works with the already-expanded list.
 *
 * @example
 * ```typescript
 * import { createRoleHierarchy } from '@classytic/arc/permissions';
 *
 * const hierarchy = createRoleHierarchy({
 *   superadmin: ['admin'],
 *   admin: ['branch_manager'],
 *   branch_manager: ['member'],
 * });
 *
 * // When building scope:
 * const expandedRoles = hierarchy.expand(user.roles);
 * // ['superadmin'] → ['superadmin', 'admin', 'branch_manager', 'member']
 *
 * // Check inclusion:
 * hierarchy.includes(['admin'], 'branch_manager'); // true (admin inherits branch_manager)
 * hierarchy.includes(['member'], 'admin');          // false (child doesn't inherit parent)
 * ```
 */

export interface RoleHierarchy {
  /** Expand roles to include all inherited (child) roles. Deduplicated. */
  expand(roles: readonly string[]): string[];
  /** Check if any of the user's roles (expanded) include the required role. */
  includes(userRoles: readonly string[], requiredRole: string): boolean;
}

/**
 * Create a role hierarchy from a parent → children map.
 *
 * Each key is a parent role, each value is the array of roles it inherits.
 * Inheritance is transitive: if A → B and B → C, then A expands to [A, B, C].
 * Circular references are handled safely (visited set).
 */
export function createRoleHierarchy(map: Record<string, readonly string[]>): RoleHierarchy {
  // Pre-compute the full expansion for each role (with circular protection)
  const cache = new Map<string, string[]>();

  function resolveRole(role: string, visited: Set<string>): string[] {
    if (visited.has(role)) return []; // circular protection
    visited.add(role);

    const cached = cache.get(role);
    if (cached) return cached;

    const children = map[role];
    if (!children || children.length === 0) {
      cache.set(role, [role]);
      return [role];
    }

    const result = [role];
    for (const child of children) {
      result.push(...resolveRole(child, visited));
    }

    // Deduplicate
    const deduped = [...new Set(result)];
    cache.set(role, deduped);
    return deduped;
  }

  return {
    expand(roles: readonly string[]): string[] {
      if (roles.length === 0) return [];

      const all = new Set<string>();
      for (const role of roles) {
        for (const expanded of resolveRole(role, new Set())) {
          all.add(expanded);
        }
      }
      return [...all];
    },

    includes(userRoles: readonly string[], requiredRole: string): boolean {
      if (userRoles.length === 0) return false;
      const expanded = this.expand(userRoles);
      return expanded.includes(requiredRole);
    },
  };
}
