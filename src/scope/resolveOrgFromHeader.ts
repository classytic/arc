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

import type { FastifyReply, FastifyRequest } from "fastify";
import { OrgAccessDeniedError, UnauthorizedError } from "../utils/errors.js";
import { requireSingleHeaderValue } from "../utils/headers.js";
import { getUserRoles } from "../utils/userHelpers.js";
import type { RequestScope } from "./types.js";

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
  const { header = "x-organization-id", resolveMembership } = options;

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    // Tenant selection is security-sensitive: a REPEATED header arrives as an
    // array at runtime, and picking either value would let a smuggled
    // duplicate steer the membership check. Reject outright instead — this
    // is exactly the duplicate-header posture `getHeader()`'s docs prescribe.
    const orgId = requireSingleHeaderValue(request.headers, header);
    if (!orgId) return; // No org header — scope stays as auth adapter set it

    // Canonical error contract: THROW ArcError subclasses and let the global
    // error handler emit the ErrorContract shape — a hand-rolled reply here
    // would bypass error mapping, tracing attributes, and log severity rules.
    const scope = request.scope;
    if (!scope || scope.kind === "public") {
      throw new UnauthorizedError("Authentication required for organization access");
    }

    // Already elevated — don't downgrade
    if (scope.kind === "elevated") return;

    const user = request.user;
    if (!user) {
      throw new UnauthorizedError("Authentication required for organization access");
    }

    const userId = String(user.id ?? user._id ?? "");
    if (!userId) {
      throw new UnauthorizedError("User identity required for organization access");
    }

    const membership = await resolveMembership(userId, orgId);
    if (!membership) {
      throw new OrgAccessDeniedError("Not a member of this organization");
    }

    // Preserve roles the auth adapter already resolved onto the scope
    // (JWT `roles` claim, session roles) — re-deriving from `user.role`
    // alone dropped them when upgrading authenticated → member. Fall back
    // to the canonical helper for scopes that carry no roles.
    const carriedRoles =
      "userRoles" in scope && Array.isArray(scope.userRoles) ? scope.userRoles : undefined;

    request.scope = {
      kind: "member",
      userId: userId || undefined,
      userRoles: carriedRoles?.length ? carriedRoles : getUserRoles(user),
      organizationId: orgId,
      orgRoles: membership.roles,
    } satisfies RequestScope;
  };
}
