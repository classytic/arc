/**
 * Resolve Org Scope from Header
 *
 * Utility hook for JWT/custom auth apps that use `x-organization-id` header
 * to select an organization. Better Auth apps don't need this — org context
 * comes from the session automatically.
 *
 * **Important:** This hook reads `request.user` and `request.scope`, which
 * are populated by the auth `preHandler`. Register it as a `preHandler`
 * (not `onRequest`) so it runs after authentication:
 *
 * @example
 * ```typescript
 * import { resolveOrgFromHeader } from '@classytic/arc/scope';
 *
 * app.addHook('preHandler', resolveOrgFromHeader({
 *   resolveMembership: async (userId, orgId) => {
 *     const member = await MemberModel.findOne({ userId, orgId });
 *     return member ? { roles: member.roles } : null;
 *   },
 * }));
 * ```
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RequestScope } from './types.js';

export interface ResolveOrgFromHeaderOptions {
  /** Header name (default: 'x-organization-id') */
  header?: string;
  /** Resolve user's membership in the org. Return roles or null if not a member. */
  resolveMembership: (userId: string, orgId: string) => Promise<{ roles: string[] } | null>;
}

/**
 * Create a preHandler hook that resolves org scope from a header.
 * Must run AFTER authentication so `request.user` is populated.
 * If the header is present and user is a member, sets `request.scope` to `member`.
 * If the header is absent, scope stays as-is (typically `authenticated`).
 */
export function resolveOrgFromHeader(
  options: ResolveOrgFromHeaderOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const { header = 'x-organization-id', resolveMembership } = options;

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const orgId = request.headers[header] as string | undefined;
    if (!orgId) return; // No org header — scope stays as auth adapter set it

    const scope = request.scope;
    if (!scope || scope.kind === 'public') {
      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required for organization access',
        code: 'ORG_AUTH_REQUIRED',
      });
      return;
    }

    // Already elevated — don't downgrade
    if (scope.kind === 'elevated') return;

    const user = request.user;
    if (!user) {
      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required for organization access',
        code: 'ORG_AUTH_REQUIRED',
      });
      return;
    }

    const userId = String(user.id ?? user._id ?? '');
    if (!userId) {
      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message: 'User identity required for organization access',
      });
      return;
    }

    const membership = await resolveMembership(userId, orgId);
    if (!membership) {
      reply.code(403).send({
        success: false,
        error: 'Forbidden',
        message: 'Not a member of this organization',
        code: 'ORG_ACCESS_DENIED',
      });
      return;
    }

    request.scope = {
      kind: 'member',
      organizationId: orgId,
      orgRoles: membership.roles,
    } satisfies RequestScope;
  };
}
