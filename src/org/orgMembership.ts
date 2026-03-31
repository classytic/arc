/**
 * Organization Membership Utilities
 *
 * Server-side membership validation.
 */

import type { UserBase, UserOrganization } from "../types/index.js";

export interface OrgMembershipOptions {
  /** Path to user's organizations array */
  userOrgsPath?: string;
  /** Optional DB lookup function */
  validateFromDb?: (userId: string, orgId: string) => Promise<boolean>;
}

export interface OrgRolesOptions {
  /** Path to user's organizations array */
  userOrgsPath?: string;
}

/**
 * Check if user is member of organization.
 * This is a low-level utility for checking membership from user object data.
 * For request-level checks, use `request.scope` (isMember/isElevated guards).
 */
export async function orgMembershipCheck(
  user: UserBase | undefined | null,
  orgId: string | undefined | null,
  options: OrgMembershipOptions = {},
): Promise<boolean> {
  const { userOrgsPath = "organizations", validateFromDb } = options;

  if (!user || !orgId) return false;

  // Check from user object
  const userOrgs = ((user as UserBase & { [key: string]: unknown })[userOrgsPath] ??
    []) as UserOrganization[];
  const isMemberFromUser = userOrgs.some((o) => {
    const memberOrgId = o.organizationId?.toString() ?? String(o);
    return memberOrgId === orgId.toString();
  });

  if (isMemberFromUser) return true;

  // Optional: validate from database
  if (validateFromDb) {
    const userId = (user._id ?? user.id)?.toString();
    if (userId) {
      return validateFromDb(userId, orgId);
    }
  }

  return false;
}

/**
 * Get user's role in organization from user object data.
 * For request-level role checks, use `request.scope.orgRoles` (when scope is 'member').
 */
export function getUserOrgRoles(
  user: UserBase | undefined | null,
  orgId: string | undefined | null,
  options: OrgRolesOptions = {},
): string[] {
  const { userOrgsPath = "organizations" } = options;

  if (!user || !orgId) return [];

  const userOrgs = ((user as UserBase & { [key: string]: unknown })[userOrgsPath] ??
    []) as UserOrganization[];
  const membership = userOrgs.find((o) => {
    const memberOrgId = o.organizationId?.toString() ?? String(o);
    return memberOrgId === orgId.toString();
  });

  const membershipRoles = membership as { roles?: string[] } | undefined;
  return membershipRoles?.roles ?? [];
}

/**
 * Check if user has specific role in organization from user object data.
 * For request-level role checks, use `requireOrgRole()` permission or `request.scope`.
 */
export function hasOrgRole(
  user: UserBase | undefined | null,
  orgId: string | undefined | null,
  roles: string | string[],
  options: OrgRolesOptions = {},
): boolean {
  const userOrgRoles = getUserOrgRoles(user, orgId, options);
  const requiredRoles = Array.isArray(roles) ? roles : [roles];

  return requiredRoles.some((role) => userOrgRoles.includes(role));
}

export default { orgMembershipCheck, getUserOrgRoles, hasOrgRole };
