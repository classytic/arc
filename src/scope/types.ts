/**
 * Request Scope — The One Standard
 *
 * Discriminated union representing the access context of every request.
 * Replaces scattered orgScope/orgRoles/organizationId/bypassRoles.
 *
 * Set once by auth adapters, read everywhere by permissions/presets/guards.
 *
 * @example
 * ```typescript
 * // In a permission check
 * const scope = request.scope;
 * if (isElevated(scope)) return true;
 * if (isMember(scope) && scope.orgRoles.includes('admin')) return true;
 *
 * // Get user identity from scope
 * const userId = getUserId(scope);
 * const globalRoles = getUserRoles(scope);
 * ```
 */

// ============================================================================
// Core Type
// ============================================================================

/**
 * Request scope — 4 kinds, 4 states, no ambiguity.
 *
 * | Kind          | Meaning                           |
 * |---------------|-----------------------------------|
 * | public        | No authentication                 |
 * | authenticated | Logged in, no org context          |
 * | member        | In an org with specific roles      |
 * | elevated      | Platform admin, explicit elevation |
 *
 * `userId` and `userRoles` are available on all authenticated variants.
 * `orgRoles` are org-level roles (from membership); `userRoles` are global roles (from user document).
 */
export type RequestScope =
  | { kind: "public" }
  | { kind: "authenticated"; userId?: string; userRoles?: string[] }
  | {
      kind: "member";
      userId?: string;
      userRoles: string[];
      organizationId: string;
      orgRoles: string[];
      teamId?: string;
    }
  | { kind: "elevated"; userId?: string; organizationId?: string; elevatedBy: string };

// ============================================================================
// Type Guards
// ============================================================================

/** Check if scope is `member` kind */
export function isMember(scope: RequestScope): scope is Extract<RequestScope, { kind: "member" }> {
  return scope.kind === "member";
}

/** Check if scope is `elevated` kind */
export function isElevated(
  scope: RequestScope,
): scope is Extract<RequestScope, { kind: "elevated" }> {
  return scope.kind === "elevated";
}

/** Check if scope has org access (member OR elevated) */
export function hasOrgAccess(scope: RequestScope): boolean {
  return scope.kind === "member" || scope.kind === "elevated";
}

/** Check if request is authenticated (any kind except public) */
export function isAuthenticated(scope: RequestScope): boolean {
  return scope.kind !== "public";
}

// ============================================================================
// Accessors
// ============================================================================

/** Get organizationId from scope (if present) */
export function getOrgId(scope: RequestScope): string | undefined {
  if (scope.kind === "member") return scope.organizationId;
  if (scope.kind === "elevated") return scope.organizationId;
  return undefined;
}

/** Get org roles from scope (empty array if not a member) */
export function getOrgRoles(scope: RequestScope): string[] {
  if (scope.kind === "member") return scope.orgRoles;
  return [];
}

/** Get team ID from scope (only available on member kind) */
export function getTeamId(scope: RequestScope): string | undefined {
  if (scope.kind === "member") return scope.teamId;
  return undefined;
}

/**
 * Get userId from scope (available on authenticated, member, elevated).
 *
 * @example
 * ```typescript
 * import { getUserId } from '@classytic/arc/scope';
 * const userId = getUserId(request.scope);
 * ```
 */
export function getUserId(scope: RequestScope): string | undefined {
  if (scope.kind === "public") return undefined;
  return (scope as { userId?: string }).userId;
}

/**
 * Get global user roles from scope (available on authenticated and member).
 * These are user-level roles (e.g. superadmin, finance-admin) distinct from
 * org-level roles (scope.orgRoles).
 *
 * @example
 * ```typescript
 * import { getUserRoles } from '@classytic/arc/scope';
 * const globalRoles = getUserRoles(request.scope);
 * ```
 */
export function getUserRoles(scope: RequestScope): string[] {
  if (scope.kind === "authenticated") return scope.userRoles ?? [];
  if (scope.kind === "member") return scope.userRoles;
  return [];
}

// ============================================================================
// Constants
// ============================================================================

/** Default public scope — used as initial decoration value */
export const PUBLIC_SCOPE: Readonly<RequestScope> = Object.freeze({ kind: "public" as const });

/** Default authenticated scope — used when user is logged in but no org */
export const AUTHENTICATED_SCOPE: Readonly<RequestScope> = Object.freeze({
  kind: "authenticated" as const,
});
