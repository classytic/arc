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

// Org Guard Middleware (for route-level enforcement)
export {
  orgGuard,
  requireOrg,
  requireOrgRole,
} from './orgGuard.js';
export type { OrgGuardOptions } from './orgGuard.js';

// Org Membership Utilities
export {
  orgMembershipCheck,
  getUserOrgRoles,
  hasOrgRole,
} from './orgMembership.js';
export type { OrgMembershipOptions, OrgRolesOptions } from './orgMembership.js';

// Organization Plugin (adapter-based REST endpoints)
export {
  default as organizationPlugin,
  organizationPlugin as organizationPluginFn,
} from './organizationPlugin.js';

// Organization Types (adapter interfaces)
export type {
  OrgDoc,
  MemberDoc,
  InvitationDoc,
  OrgAdapter,
  InvitationAdapter,
  OrgPermissionStatement,
  OrgRole,
  OrganizationPluginOptions,
} from './types.js';
