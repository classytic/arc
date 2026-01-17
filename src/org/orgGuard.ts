/**
 * Organization Guard Middleware
 *
 * Ensures organization context is present before handler execution.
 *
 * @example
 * // Require org context
 * fastify.get('/invoices', {
 *   preHandler: [fastify.authenticate, orgGuard()]
 * }, handler);
 *
 * // Require specific org roles
 * fastify.post('/invoices', {
 *   preHandler: [fastify.authenticate, orgGuard({ roles: ['admin', 'accountant'] })]
 * }, handler);
 */

import type { FastifyReply } from 'fastify';
import type { RequestContext, RequestWithExtras, RouteHandler, UserBase } from '../types/index.js';

export interface OrgGuardOptions {
  /** Require organization context (default: true) */
  requireOrgContext?: boolean;
  /** Required org-level roles */
  roles?: string[];
  /** Allow superadmin without org context */
  allowGlobal?: boolean;
}

/**
 * Create org guard middleware
 */
export function orgGuard(options: OrgGuardOptions = {}): RouteHandler {
  const {
    requireOrgContext = true,
    roles = [],
    allowGlobal = false,
  } = options;

  return async function orgGuardMiddleware(
    request: RequestWithExtras,
    reply: FastifyReply
  ): Promise<void> {
    const context: RequestContext = request.context ?? {};
    const user = request.user;
    const userWithRoles = user as { roles?: string[] } | undefined;

    // Check if user is superadmin with global access
    if (allowGlobal && userWithRoles?.roles?.includes('superadmin')) {
      return; // Allow through
    }

    // Check org context exists
    if (requireOrgContext && !context.organizationId) {
      reply.code(403).send({
        success: false,
        error: 'Organization context required',
        code: 'ORG_CONTEXT_REQUIRED',
        message:
          'This endpoint requires an organization context. ' +
          'Please specify organization via x-organization-id header.',
      });
      return;
    }

    // Check org-level roles if specified
    if (roles.length > 0 && context.organizationId) {
      const contextWithRoles = context as { orgRoles?: string[] };
      const userOrgRoles = contextWithRoles.orgRoles ?? [];
      const hasRequiredRole = roles.some((role) => userOrgRoles.includes(role));

      // Superadmin bypasses org role check
      if (!hasRequiredRole && !userWithRoles?.roles?.includes('superadmin')) {
        reply.code(403).send({
          success: false,
          error: 'Insufficient organization permissions',
          code: 'ORG_ROLE_REQUIRED',
          message: `This action requires one of these organization roles: ${roles.join(', ')}`,
          required: roles,
          current: userOrgRoles,
        });
        return;
      }
    }
  };
}

/**
 * Shorthand for requiring org context
 */
export function requireOrg(): RouteHandler {
  return orgGuard({ requireOrgContext: true });
}

/**
 * Require org context with specific roles
 */
export function requireOrgRole(...roles: string[]): RouteHandler {
  return orgGuard({ requireOrgContext: true, roles });
}

export default orgGuard;
