/**
 * Organization Module
 *
 * Multi-org/multi-tenant utilities and plugins.
 *
 * Org context is resolved via `request.scope` (set by auth adapters).
 * Use guards and permission helpers to enforce org-level access.
 *
 * @example
 * import { orgGuard, requireOrg, requireOrgRole } from '@classytic/arc/org';
 *
 * // Use guards for role-based access
 * fastify.post('/settings', {
 *   preHandler: [fastify.authenticate, requireOrgRole('admin', 'owner')]
 * }, handler);
 */

// Organization Plugin (adapter-based REST endpoints)
export {
  default as organizationPlugin,
  organizationPlugin as organizationPluginFn,
} from "./organizationPlugin.js";
export type { OrgGuardOptions } from "./orgGuard.js";
// Org Guard Middleware (for route-level enforcement)
export {
  orgGuard,
  requireOrg,
  requireOrgRole,
} from "./orgGuard.js";
export type { OrgMembershipOptions, OrgRolesOptions } from "./orgMembership.js";
// Org Membership Utilities
export {
  getUserOrgRoles,
  hasOrgRole,
  orgMembershipCheck,
} from "./orgMembership.js";

// Organization Types (adapter interfaces)
export type {
  InvitationAdapter,
  InvitationDoc,
  MemberDoc,
  OrgAdapter,
  OrganizationPluginOptions,
  OrgDoc,
  OrgPermissionStatement,
  OrgRole,
} from "./types.js";
