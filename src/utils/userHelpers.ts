/**
 * User-object helpers.
 *
 * Small, framework-agnostic utilities that operate on arc's `UserLike`
 * shape. Live in `@classytic/arc/utils` instead of `@classytic/arc/types`
 * so the types subpath can stay genuinely type-only (v2.11.0 cleanup).
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
