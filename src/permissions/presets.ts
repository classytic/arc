/**
 * Permission Presets — Common permission patterns in one call.
 *
 * Reduces 5 lines of permission declarations to 1.
 * Each preset returns a ResourcePermissions object that can be
 * spread or overridden per-operation.
 *
 * @example
 * ```typescript
 * import { permissions } from '@classytic/arc';
 *
 * // Public read, authenticated write
 * defineResource({ name: 'product', permissions: permissions.publicRead() });
 *
 * // Override specific operations
 * defineResource({
 *   name: 'product',
 *   permissions: permissions.publicRead({ delete: requireRoles(['superadmin']) }),
 * });
 * ```
 */

import { allowPublic, anyOf, requireAuth, requireOwnership, requireRoles } from "./index.js";
import type { PermissionCheck } from "./types.js";

/**
 * ResourcePermissions shape — matches the type in types/index.ts
 */
interface ResourcePermissions<TDoc = any> {
  list?: PermissionCheck<TDoc>;
  get?: PermissionCheck<TDoc>;
  create?: PermissionCheck<TDoc>;
  update?: PermissionCheck<TDoc>;
  delete?: PermissionCheck<TDoc>;
}

type PermissionOverrides<TDoc = any> = Partial<ResourcePermissions<TDoc>>;

/**
 * Merge a base preset with user overrides.
 * Overrides replace individual operations — undefined values don't clear them.
 */
function withOverrides<TDoc = any>(
  base: ResourcePermissions<TDoc>,
  overrides?: PermissionOverrides<TDoc>,
): ResourcePermissions<TDoc> {
  if (!overrides) return base;
  const filtered = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return { ...base, ...filtered };
}

/**
 * Public read, authenticated write.
 * list + get = allowPublic(), create + update + delete = requireAuth()
 */
export function publicRead<TDoc = any>(
  overrides?: PermissionOverrides<TDoc>,
): ResourcePermissions<TDoc> {
  return withOverrides(
    {
      list: allowPublic(),
      get: allowPublic(),
      create: requireAuth(),
      update: requireAuth(),
      delete: requireAuth(),
    },
    overrides,
  );
}

/**
 * Public read, admin write.
 * list + get = allowPublic(), create + update + delete = requireRoles(['admin'])
 */
export function publicReadAdminWrite<TDoc = any>(
  roles: readonly string[] = ["admin"],
  overrides?: PermissionOverrides<TDoc>,
): ResourcePermissions<TDoc> {
  return withOverrides(
    {
      list: allowPublic(),
      get: allowPublic(),
      create: requireRoles(roles),
      update: requireRoles(roles),
      delete: requireRoles(roles),
    },
    overrides,
  );
}

/**
 * All operations require authentication.
 */
export function authenticated<TDoc = any>(
  overrides?: PermissionOverrides<TDoc>,
): ResourcePermissions<TDoc> {
  return withOverrides(
    {
      list: requireAuth(),
      get: requireAuth(),
      create: requireAuth(),
      update: requireAuth(),
      delete: requireAuth(),
    },
    overrides,
  );
}

/**
 * All operations require specific roles.
 * @param roles - Required roles (user needs at least one). Default: ['admin']
 */
export function adminOnly<TDoc = any>(
  roles: readonly string[] = ["admin"],
  overrides?: PermissionOverrides<TDoc>,
): ResourcePermissions<TDoc> {
  return withOverrides(
    {
      list: requireRoles(roles),
      get: requireRoles(roles),
      create: requireRoles(roles),
      update: requireRoles(roles),
      delete: requireRoles(roles),
    },
    overrides,
  );
}

/**
 * Owner-scoped with admin bypass.
 * list = auth (scoped to owner), get = auth, create = auth,
 * update + delete = ownership check with admin bypass.
 *
 * @param ownerField - Field containing owner ID (default: 'userId')
 * @param bypassRoles - Roles that bypass ownership check (default: ['admin'])
 */
export function ownerWithAdminBypass<TDoc = any>(
  ownerField: Extract<keyof TDoc, string> | string = "userId",
  bypassRoles: readonly string[] = ["admin"],
  overrides?: PermissionOverrides<TDoc>,
): ResourcePermissions<TDoc> {
  return withOverrides(
    {
      list: requireAuth(),
      get: requireAuth(),
      create: requireAuth(),
      update: anyOf(requireRoles(bypassRoles), requireOwnership(ownerField)),
      delete: anyOf(requireRoles(bypassRoles), requireOwnership(ownerField)),
    },
    overrides,
  );
}

/**
 * Full public access — no auth required for any operation.
 * Use sparingly (dev/testing, truly public APIs).
 */
export function fullPublic<TDoc = any>(
  overrides?: PermissionOverrides<TDoc>,
): ResourcePermissions<TDoc> {
  return withOverrides(
    {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    overrides,
  );
}

/**
 * Read-only: list + get authenticated, write operations denied.
 * Useful for computed/derived resources.
 */
export function readOnly<TDoc = any>(
  overrides?: PermissionOverrides<TDoc>,
): ResourcePermissions<TDoc> {
  return withOverrides(
    {
      list: requireAuth(),
      get: requireAuth(),
    },
    overrides,
  );
}
