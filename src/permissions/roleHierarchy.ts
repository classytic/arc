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
  // Memo of each role's FULL transitive expansion. Only fully-independent
  // expansions are cached (see below) so the memo is always context-free correct.
  const cache = new Map<string, string[]>();

  /**
   * Resolve a role's transitive expansion.
   *
   * `stack` is the CURRENT recursion path (a DFS stack), NOT a shared visited
   * accumulator: a role is added on entry and REMOVED on exit, so sibling
   * branches never pollute each other. Without this, a diamond `A→B→D`, `A→C→D`
   * would let B's traversal leave `D` in a shared set, making C's `D` look like a
   * back-edge and caching `C` WITHOUT `D` — a nondeterministic under-grant.
   *
   * Returns `cyclic` = whether a back-edge into `stack` was cut anywhere in the
   * subtree. A cyclic subtree's result depends on the entry path, so it is NOT
   * cached (recomputed each call — correct, if unmemoized). Acyclic subtrees (the
   * norm) cache safely.
   */
  function resolveRole(role: string, stack: Set<string>): { roles: string[]; cyclic: boolean } {
    if (stack.has(role)) return { roles: [], cyclic: true }; // back-edge — cut

    const cached = cache.get(role);
    if (cached) return { roles: cached, cyclic: false };

    const children = map[role];
    if (!children || children.length === 0) {
      cache.set(role, [role]);
      return { roles: [role], cyclic: false };
    }

    stack.add(role);
    const result = [role];
    let cyclic = false;
    for (const child of children) {
      const childResult = resolveRole(child, stack);
      result.push(...childResult.roles);
      if (childResult.cyclic) cyclic = true;
    }
    stack.delete(role); // exit — restore the stack for siblings

    const deduped = [...new Set(result)];
    // Cache ONLY when no back-edge was cut in this subtree — a cut result is
    // entry-path-dependent and would poison a later lookup from another path.
    if (!cyclic) cache.set(role, deduped);
    return { roles: deduped, cyclic };
  }

  return {
    expand(roles: readonly string[]): string[] {
      if (roles.length === 0) return [];

      const all = new Set<string>();
      for (const role of roles) {
        for (const expanded of resolveRole(role, new Set()).roles) {
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
