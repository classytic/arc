/**
 * User-object helpers.
 *
 * Small utilities that operate on arc's `UserLike` shape with no
 * runtime dependencies — usable from controllers, hooks, scope
 * resolvers, and tests. Live in `@classytic/arc/utils` instead of
 * `@classytic/arc/types` so the types subpath can stay genuinely
 * type-only (v2.11.0 cleanup).
 */

import type { UserLike } from "../types/base.js";

/**
 * Extract a user ID from a user object. Accepts `id` or `_id` — returns
 * `undefined` when neither is present. Used by arc's controllers to
 * populate `createdBy` / `updatedBy` fields and for cache scoping.
 *
 * @example
 * ```ts
 * import { getUserId } from '@classytic/arc/utils';
 * const uid = getUserId(request.user);
 * ```
 */
export function getUserId(user: UserLike | null | undefined): string | undefined {
  if (!user) return undefined;
  const id = user.id ?? user._id;
  return id ? String(id) : undefined;
}

/** Normalize a raw role value from Better Auth, JWT, or a custom identity provider. */
export function normalizeRoles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((role) => String(role).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.length > 0) {
    return value
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean);
  }
  return [];
}

/** Extract normalized roles from a user-like object. */
export function getUserRoles(
  user: { role?: unknown; roles?: unknown } | null | undefined,
): string[] {
  return user ? normalizeRoles(user.role ?? user.roles) : [];
}
