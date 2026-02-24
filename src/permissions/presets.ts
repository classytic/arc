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

import type { PermissionCheck } from './types.js';
import { allowPublic, requireAuth, requireRoles, requireOwnership, anyOf } from './index.js';

/**
 * ResourcePermissions shape — matches the type in types/index.ts
 */
interface ResourcePermissions {
  list?: PermissionCheck;
  get?: PermissionCheck;
  create?: PermissionCheck;
  update?: PermissionCheck;
  delete?: PermissionCheck;
}

type PermissionOverrides = Partial<ResourcePermissions>;

/**
 * Merge a base preset with user overrides.
 * Overrides replace individual operations — undefined values don't clear them.
 */
function withOverrides(base: ResourcePermissions, overrides?: PermissionOverrides): ResourcePermissions {
  if (!overrides) return base;
  return { ...base, ...overrides };
}

/**
 * Public read, authenticated write.
 * list + get = allowPublic(), create + update + delete = requireAuth()
 */
export function publicRead(overrides?: PermissionOverrides): ResourcePermissions {
  return withOverrides({
    list: allowPublic(),
    get: allowPublic(),
    create: requireAuth(),
    update: requireAuth(),
    delete: requireAuth(),
  }, overrides);
}

/**
 * Public read, admin write.
 * list + get = allowPublic(), create + update + delete = requireRoles(['admin'])
 */
export function publicReadAdminWrite(
  roles: readonly string[] = ['admin'],
  overrides?: PermissionOverrides,
): ResourcePermissions {
  return withOverrides({
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(roles),
    update: requireRoles(roles),
    delete: requireRoles(roles),
  }, overrides);
}

/**
 * All operations require authentication.
 */
export function authenticated(overrides?: PermissionOverrides): ResourcePermissions {
  return withOverrides({
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: requireAuth(),
    delete: requireAuth(),
  }, overrides);
}

/**
 * All operations require specific roles.
 * @param roles - Required roles (user needs at least one). Default: ['admin']
 */
export function adminOnly(
  roles: readonly string[] = ['admin'],
  overrides?: PermissionOverrides,
): ResourcePermissions {
  return withOverrides({
    list: requireRoles(roles),
    get: requireRoles(roles),
    create: requireRoles(roles),
    update: requireRoles(roles),
    delete: requireRoles(roles),
  }, overrides);
}

/**
 * Owner-scoped with admin bypass.
 * list = auth (scoped to owner), get = auth, create = auth,
 * update + delete = ownership check with admin bypass.
 *
 * @param ownerField - Field containing owner ID (default: 'userId')
 * @param bypassRoles - Roles that bypass ownership check (default: ['admin'])
 */
export function ownerWithAdminBypass(
  ownerField = 'userId',
  bypassRoles: readonly string[] = ['admin'],
  overrides?: PermissionOverrides,
): ResourcePermissions {
  return withOverrides({
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: anyOf(
      requireRoles(bypassRoles),
      requireOwnership(ownerField),
    ),
    delete: anyOf(
      requireRoles(bypassRoles),
      requireOwnership(ownerField),
    ),
  }, overrides);
}

/**
 * Full public access — no auth required for any operation.
 * Use sparingly (dev/testing, truly public APIs).
 */
export function fullPublic(overrides?: PermissionOverrides): ResourcePermissions {
  return withOverrides({
    list: allowPublic(),
    get: allowPublic(),
    create: allowPublic(),
    update: allowPublic(),
    delete: allowPublic(),
  }, overrides);
}

/**
 * Read-only: list + get authenticated, write operations denied.
 * Useful for computed/derived resources.
 */
export function readOnly(overrides?: PermissionOverrides): ResourcePermissions {
  return withOverrides({
    list: requireAuth(),
    get: requireAuth(),
  }, overrides);
}
