/**
 * Permissions template — `src/shared/permissions.ts`.
 *
 * Single function with deeply conditional output: the resulting file
 * always re-exports the core permission primitives, but the higher-level
 * org/team helpers are only emitted on multi-tenant scaffolds, and they
 * branch on `auth: better-auth` vs `auth: jwt` because BA exposes
 * org-scoped role checks that the JWT path can't match.
 */

import type { ProjectConfig } from "../types.js";

export function permissionsTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeImport = ts ? ",\n  type PermissionCheck," : "";
  const returnType = ts ? ": PermissionCheck" : "";

  let content = `/**
 * Permission Helpers
 *
 * Clean, type-safe permission definitions for resources.
 */

import {
  requireAuth,
  requireRoles,
  requireOwnership,
  allowPublic,
  roles,
  anyOf,
  allOf,
  denyAll,
  when${typeImport}
} from '@classytic/arc/permissions';

// Re-export core helpers
export {
  allowPublic,
  requireAuth,
  requireRoles,
  requireOwnership,
  roles,
  allOf,
  anyOf,
  denyAll,
  when,
};

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Require any authenticated user
 */
export const requireAuthenticated = ()${returnType} =>
  requireRoles(['user', 'admin', 'superadmin']);

/**
 * Require admin or superadmin
 */
export const requireAdmin = ()${returnType} =>
  requireRoles(['admin', 'superadmin']);

/**
 * Require superadmin only
 */
export const requireSuperadmin = ()${returnType} =>
  requireRoles(['superadmin']);
`;

  if (config.tenant === "multi") {
    if (config.auth === "better-auth") {
      // Better Auth: use requireOrgRole() which checks per-org member.role
      content += `
// ============================================================================
// Better Auth Organization & Team Permission Helpers
// ============================================================================

/**
 * Organization-level guards (per-org member.role):
 *
 * - requireRoles('admin')              — checks BOTH user.role AND org member.role (recommended)
 * - requireOrgRole(['admin','owner'])  — checks member.role in active org ONLY
 * - requireOrgMembership()             — just checks if user is in the org (any role)
 * - requireTeamMembership()            — checks if user is in the active team
 *
 * RECOMMENDED: Use requireRoles() for most cases. Since Arc 2.7.1 it defaults to
 * checking both platform AND org roles, so a single call covers BA org plugin users
 * with platform-admin overrides. Use requireOrgRole() when you ONLY want org-level
 * checks (and want to explicitly exclude platform admins).
 *
 * Platform superadmin automatically bypasses all org role checks.
 *
 * IMPORTANT: When using Better Auth's Access Control (ac) with custom roles,
 * you MUST define ALL roles (owner, admin, member, + any custom) using the
 * same AC instance. BA's built-in defaults won't cover custom statements.
 * Omitting any role causes BA's hasPermission to fail silently for that role.
 *
 * @see multi-org-betterauth boilerplate (src/shared/access-control.ts) for the recommended pattern.
 */
import {
  requireOrgMembership,
  requireOrgRole,
  requireTeamMembership,
} from '@classytic/arc/permissions';
export { requireOrgMembership, requireOrgRole, requireTeamMembership };

/**
 * Require organization owner (checks member.role, not user.role)
 */
export const requireOrgOwner = ()${returnType} =>
  requireOrgRole(['owner']);

/**
 * Require organization manager or higher (checks member.role, not user.role)
 */
export const requireOrgManager = ()${returnType} =>
  requireOrgRole(['manager', 'admin', 'owner']);

/**
 * Require any organization member (any role)
 */
export const requireOrgStaff = ()${returnType} =>
  requireOrgMembership();
`;
    } else {
      // JWT: no BA org plugin — use requireRoles() with user.role
      content += `
/**
 * Require organization owner (elevated scope auto-bypasses)
 */
export const requireOrgOwner = ()${returnType} =>
  requireRoles(['owner', 'admin', 'superadmin']);

/**
 * Require organization manager or higher
 */
export const requireOrgManager = ()${returnType} =>
  requireRoles(['owner', 'manager', 'admin', 'superadmin']);

/**
 * Require organization staff (any org member)
 */
export const requireOrgStaff = ()${returnType} =>
  requireRoles(['owner', 'manager', 'staff', 'admin', 'superadmin']);
`;
    }
  }

  content += `
// ============================================================================
// Standard Permission Sets
// ============================================================================

/**
 * Public read, authenticated write (default for most resources)
 */
export const publicReadPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireAuthenticated(),
  update: requireAuthenticated(),
  delete: requireAuthenticated(),
};

/**
 * All operations require authentication
 */
export const authenticatedPermissions = {
  list: requireAuth(),
  get: requireAuth(),
  create: requireAuth(),
  update: requireAuth(),
  delete: requireAuth(),
};

/**
 * Admin only permissions
 */
export const adminPermissions = {
  list: requireAdmin(),
  get: requireAdmin(),
  create: requireSuperadmin(),
  update: requireSuperadmin(),
  delete: requireSuperadmin(),
};
`;

  if (config.tenant === "multi") {
    content += `
/**
 * Organization staff permissions
 */
export const orgStaffPermissions = {
  list: requireOrgStaff(),
  get: requireOrgStaff(),
  create: requireOrgManager(),
  update: requireOrgManager(),
  delete: requireOrgOwner(),
};
`;

    if (config.auth === "better-auth") {
      content += `
/**
 * Team-scoped permissions (requires active team)
 * Uses Better Auth's team membership — flat groups, no team-level roles.
 */
export const teamScopedPermissions = {
  list: requireTeamMembership(),
  get: requireTeamMembership(),
  create: requireTeamMembership(),
  update: requireTeamMembership(),
  delete: requireOrgOwner(),
};
`;
    }
  }

  return content;
}
