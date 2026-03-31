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

import type { FastifyReply } from "fastify";
import { getOrgRoles, hasOrgAccess, isElevated, isMember, PUBLIC_SCOPE } from "../scope/types.js";
import type { RequestWithExtras, RouteHandler } from "../types/index.js";

export interface OrgGuardOptions {
  /** Require organization context (default: true) */
  requireOrgContext?: boolean;
  /** Required org-level roles */
  roles?: string[];
}

/**
 * Create org guard middleware.
 * Reads `request.scope` for org context and roles.
 * Elevated scope always passes.
 */
export function orgGuard(options: OrgGuardOptions = {}): RouteHandler {
  const { requireOrgContext = true, roles = [] } = options;

  return async function orgGuardMiddleware(
    request: RequestWithExtras,
    reply: FastifyReply,
  ): Promise<void> {
    const scope = request.scope ?? PUBLIC_SCOPE;

    // Elevated scope always passes
    if (isElevated(scope)) return;

    // Check org context exists
    if (requireOrgContext && !hasOrgAccess(scope)) {
      reply.code(403).send({
        success: false,
        error: "Organization context required",
        code: "ORG_CONTEXT_REQUIRED",
        message:
          "This endpoint requires an organization context. " +
          "Please specify organization via x-organization-id header.",
      });
      return;
    }

    // Check org-level roles if specified
    if (roles.length > 0 && isMember(scope)) {
      const userOrgRoles = getOrgRoles(scope);
      const hasRequiredRole = roles.some((role) => userOrgRoles.includes(role));

      if (!hasRequiredRole) {
        reply.code(403).send({
          success: false,
          error: "Insufficient organization permissions",
          code: "ORG_ROLE_REQUIRED",
          message: `This action requires one of these organization roles: ${roles.join(", ")}`,
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
