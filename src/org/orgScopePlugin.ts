/**
 * 🏢 Smart Organization Scope Plugin
 *
 * Intelligent organization filtering that adapts to authentication context.
 *
 * Philosophy: "Be Lenient with Public, Strict with Authenticated"
 * - Public routes: Allow without org filter (shows all)
 * - Authenticated routes: Validate org access
 * - Admin routes: Bypass restrictions
 *
 * Usage Pattern:
 * - This plugin adds a `organizationScoped()` decorator factory to fastify
 * - Apply it per-route as preHandler, NOT as a global hook
 * - Resources can opt-in to org scoping individually
 *
 * @example
 * // Register the plugin
 * await fastify.register(orgScopePlugin, {
 *   header: 'x-organization-id',
 *   bypassRoles: ['superadmin'],
 * });
 *
 * // Use per-route (required org)
 * fastify.get('/invoices', {
 *   preHandler: [fastify.authenticate, fastify.organizationScoped({ required: true })]
 * }, handler);
 *
 * // Optional org scoping (shows all if no header)
 * fastify.get('/products', {
 *   preHandler: [fastify.organizationScoped({ required: false })]
 * }, handler);
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { OrgScopeOptions, RequestContext, UserBase, UserOrganization } from '../types/index.js';

export interface OrganizationScopedOptions {
  /** Require org header (default: true) */
  required?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    context?: RequestContext;
    organizationId?: string;
    teamId?: string;
  }

  interface FastifyInstance {
    organizationScoped: (options?: OrganizationScopedOptions) => RouteHandlerMethod;
    createOrgContext: (orgId: string, options?: Partial<RequestContext>) => RequestContext;
  }
}

/**
 * Create org context object
 */
export function createOrgContext(
  orgId: string,
  options: Partial<RequestContext> = {}
): RequestContext {
  return {
    organizationId: orgId,
    orgScope: options.orgScope ?? 'explicit',
    orgRoles: options.orgRoles ?? [],
    ...options,
  };
}

const orgScopePlugin: FastifyPluginAsync<OrgScopeOptions> = async (
  fastify: FastifyInstance,
  opts: OrgScopeOptions = {}
) => {
  const {
    header = 'x-organization-id',
    bypassRoles = ['superadmin'],
    userOrgsPath = 'organizations',
    validateMembership,
  } = opts;

  // Decorate request with context and organizationId (only if not already decorated)
  if (!fastify.hasRequestDecorator('context')) {
    fastify.decorateRequest('context', undefined);
  }
  if (!fastify.hasRequestDecorator('organizationId')) {
    fastify.decorateRequest('organizationId', undefined);
  }

  /**
   * Organization Scoped PreHandler Factory
   *
   * Returns a preHandler that intelligently handles org context:
   * - No header + superadmin → allow (global access)
   * - No header + required → 403
   * - No header + not required → allow (public data)
   * - Header + not authenticated → 401
   * - Header + superadmin → allow any org
   * - Header + authenticated → validate membership
   */
  fastify.decorate('organizationScoped', function organizationScoped(
    options: OrganizationScopedOptions = {}
  ): RouteHandlerMethod {
    const { required = true } = options;

    return async function organizationScopePreHandler(
      request: FastifyRequest,
      reply: FastifyReply
    ): Promise<void> {
      const user = (request as FastifyRequest & { user?: UserBase }).user;
      const userWithRoles = user as { roles?: string[] | string };
      const roles = Array.isArray(userWithRoles?.roles)
        ? userWithRoles.roles
        : (userWithRoles?.roles ? [String(userWithRoles.roles)] : []);

      const orgIdFromHeader = (request.headers[header] as string)?.toString().trim();
      const isAuthenticated = !!user;
      const isSuperadmin = bypassRoles.some((role: string) => roles.includes(role));

      // Initialize context
      const req = request as FastifyRequest & { context: RequestContext; organizationId?: string };
      req.context = req.context ?? {};

      // ========================================
      // CASE 1: No org header provided
      // ========================================
      if (!orgIdFromHeader) {
        // Superadmins can see everything without org filter
        if (isSuperadmin) {
          request.log?.debug?.({ msg: 'Superadmin - no org filter required' });
          req.context.orgScope = 'global';
          return;
        }

        // Required routes need org header
        if (required) {
          reply.code(403).send({
            success: false,
            error: 'Organization context required',
            code: 'ORG_HEADER_REQUIRED',
            message: 'x-organization-id header required',
          });
          return;
        }

        // Optional routes - proceed without org filter (shows all public data)
        request.log?.debug?.({ msg: 'No org filter - showing all public data' });
        req.context.orgScope = 'public';
        return;
      }

      // ========================================
      // CASE 2: Org header provided
      // ========================================

      // Public routes with org header - require auth
      if (!isAuthenticated) {
        request.log?.warn?.({
          msg: 'Organization filtering requires authentication',
          headerOrgId: orgIdFromHeader,
        });
        reply.code(401).send({
          success: false,
          error: 'Authentication required to filter by organization',
          code: 'AUTH_REQUIRED_FOR_ORG',
        });
        return;
      }

      // Superadmins can access any organization
      if (isSuperadmin) {
        request.log?.debug?.({
          msg: 'Superadmin accessing organization',
          orgId: orgIdFromHeader,
        });
        req.organizationId = orgIdFromHeader;
        req.context.organizationId = orgIdFromHeader;
        req.context.orgScope = 'bypass';
        req.context.bypassReason = 'superadmin';
        return;
      }

      // Validate user has access to this organization
      const userOrgs = ((user as UserBase & { [key: string]: unknown })?.[userOrgsPath] ?? []) as UserOrganization[];

      // Custom validator or default membership check
      let hasAccess = false;
      if (validateMembership) {
        hasAccess = await validateMembership(user, orgIdFromHeader);
      } else {
        hasAccess = userOrgs.some((org) => {
          const memberOrgId = org.organizationId?.toString() ?? String(org);
          return memberOrgId === orgIdFromHeader;
        });
      }

      if (!hasAccess) {
        request.log?.warn?.({
          msg: 'Access denied - user not member of organization',
          userId: user._id ?? user.id,
          requestedOrgId: orgIdFromHeader,
          userOrgIds: userOrgs.map((o) => o.organizationId?.toString() ?? String(o)),
        });
        reply.code(403).send({
          success: false,
          error: 'No access to this organization',
          code: 'ORG_ACCESS_DENIED',
        });
        return;
      }

      // Access granted - set organization context
      req.organizationId = orgIdFromHeader;
      req.context.organizationId = orgIdFromHeader;
      req.context.orgScope = 'member';

      // Get user's roles in this org
      const orgMembership = userOrgs.find((o) => {
        const memberOrgId = o.organizationId?.toString() ?? String(o);
        return memberOrgId === orgIdFromHeader;
      });
      req.context.orgRoles = (orgMembership?.roles as string[] | undefined) ?? [];

      request.log?.debug?.({
        msg: 'Organization context set',
        orgId: orgIdFromHeader,
        userId: user._id ?? user.id,
        orgRoles: req.context.orgRoles,
      });
    };
  });

  // Decorator for creating org context manually
  fastify.decorate('createOrgContext', createOrgContext);

  fastify.log?.debug?.('Organization scope plugin registered');
};

export default fp(orgScopePlugin, {
  name: 'arc-org-scope',
  fastify: '5.x',
});

export { orgScopePlugin };
export type { OrgScopeOptions };
