/**
 * Organization Module
 *
 * Multi-org/multi-tenant utilities and plugins.
 *
 * Philosophy: "Be Lenient with Public, Strict with Authenticated"
 * - Public routes: Allow without org filter (shows all)
 * - Authenticated routes: Validate org access
 * - Admin routes: Bypass restrictions
 *
 * @example
 * import { orgScopePlugin, orgGuard, requireOrg } from '@classytic/arc/org';
 *
 * // Register org scope plugin (adds organizationScoped decorator)
 * await fastify.register(orgScopePlugin, {
 *   header: 'x-organization-id',
 *   bypassRoles: ['superadmin'],
 * });
 *
 * // Use decorator factory per-route
 * fastify.get('/invoices', {
 *   preHandler: [fastify.authenticate, fastify.organizationScoped({ required: true })]
 * }, handler);
 *
 * // Optional org filtering (public data)
 * fastify.get('/products', {
 *   preHandler: [fastify.organizationScoped({ required: false })]
 * }, handler);
 *
 * // Use guards for role-based access
 * fastify.post('/settings', {
 *   preHandler: [fastify.authenticate, requireOrgRole('admin', 'owner')]
 * }, handler);
 */

// Org Scope Plugin (smart decorator factory)
export {
  default as orgScopePlugin,
  orgScopePlugin as orgScopePluginFn,
  createOrgContext,
} from './orgScopePlugin.js';
export type { OrgScopeOptions, OrganizationScopedOptions } from './orgScopePlugin.js';

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
  getOrgRoles,
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
