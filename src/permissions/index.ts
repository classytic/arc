/**
 * Permission System — clean, function-based, composable.
 *
 * Every permission check is a `PermissionCheck` function returning
 * `boolean | PermissionResult`. Compose with `allOf`, `anyOf`, `not`,
 * `when`, `denyAll`. No inheritance, no classes, no global state.
 *
 * ## File map
 * - `./core.ts`     — universal primitives (allowPublic, requireAuth,
 *                     requireRoles, requireOwnership, allOf/anyOf/not/when/denyAll)
 * - `./scope.ts`    — scope-bound checks (org/service/team/scope-context)
 * - `./dynamic.ts`  — role × resource × action matrices (static + dynamic)
 * - `./fields.ts`   — field-level permissions
 * - `./presets.ts`  — common patterns in one call (publicRead, adminOnly, …)
 * - `./roleHierarchy.ts` — role inheritance graphs
 *
 * @example
 * ```typescript
 * import { allowPublic, requireAuth, requireRoles, requireOwnership, anyOf } from '@classytic/arc/permissions';
 *
 * defineResource({
 *   permissions: {
 *     list: allowPublic(),
 *     get: allowPublic(),
 *     create: requireAuth(),
 *     update: anyOf(requireRoles(['admin']), requireOwnership('userId')),
 *     delete: requireRoles(['admin']),
 *   }
 * });
 * ```
 */

// ──────────────────────────────────────────────────────────────────────
// Agent-auth — DPoP + capability mandates (AP2 / x402 / MCP authorization)
// ──────────────────────────────────────────────────────────────────────
export type { RequireAgentScopeOptions, RequireMandateOptions } from "./agent.js";
export { requireAgentScope, requireDPoP, requireMandate } from "./agent.js";
// ──────────────────────────────────────────────────────────────────────
// Framework-internal primitives
// Exported because the package has `sideEffects: false`, so ESM
// tree-shaking eliminates unused re-exports for end users. Internal call
// sites (createCrudRouter, createActionRouter, MCP resourceToTools)
// import these directly from "./applyPermissionResult.js".
// ──────────────────────────────────────────────────────────────────────
export { applyPermissionResult, normalizePermissionResult } from "./applyPermissionResult.js";
// ──────────────────────────────────────────────────────────────────────
// Core primitives — auth/role/ownership + combinators
// ──────────────────────────────────────────────────────────────────────
export {
  allOf,
  allowPublic,
  anyOf,
  denyAll,
  not,
  requireAuth,
  requireOwnership,
  requireRoles,
  roles,
  when,
} from "./core.js";
// ──────────────────────────────────────────────────────────────────────
// Permission matrices — role × resource × action
// ──────────────────────────────────────────────────────────────────────
export type {
  ConnectEventsOptions,
  DynamicPermissionMatrix,
  DynamicPermissionMatrixConfig,
  PermissionEventBus,
} from "./dynamic.js";
export { createDynamicPermissionMatrix, createOrgPermissions } from "./dynamic.js";
// ──────────────────────────────────────────────────────────────────────
// Field-level permissions
// ──────────────────────────────────────────────────────────────────────
export type {
  FieldPermission,
  FieldPermissionMap,
  FieldPermissionType,
} from "./fields.js";
export {
  applyFieldReadPermissions,
  applyFieldWritePermissions,
  fields,
  resolveEffectiveRoles,
} from "./fields.js";
// ──────────────────────────────────────────────────────────────────────
// Role hierarchy
// ──────────────────────────────────────────────────────────────────────
export type { RoleHierarchy } from "./roleHierarchy.js";
export { createRoleHierarchy } from "./roleHierarchy.js";
// ──────────────────────────────────────────────────────────────────────
// Scope-bound checks — org/service/team/scope-context
// ──────────────────────────────────────────────────────────────────────
export {
  requireOrgInScope,
  requireOrgMembership,
  requireOrgRole,
  requireScopeContext,
  requireServiceScope,
  requireTeamMembership,
} from "./scope.js";
// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────
export type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
  UserBase,
} from "./types.js";
export { getUserRoles, normalizeRoles } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// Convenience presets — common patterns in one call
// ──────────────────────────────────────────────────────────────────────
import * as presets from "./presets.js";

export {
  adminOnly,
  authenticated,
  fullPublic,
  ownerWithAdminBypass,
  publicRead,
  publicReadAdminWrite,
  readOnly,
} from "./presets.js";

/**
 * Namespace alias for all preset bundles. Use either form:
 *
 * ```typescript
 * import { permissions, publicRead } from '@classytic/arc/permissions';
 *
 * defineResource({ permissions: permissions.publicRead() });
 * defineResource({ permissions: publicRead() });
 * ```
 */
export { presets as permissions };
