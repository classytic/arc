/**
 * Shared action permission resolution.
 *
 * Single source of truth for the fallback chain used by:
 *  - `normalizeActionsToRouterConfig` (HTTP router, `defineResource.ts`)
 *  - `resourceToTools` (MCP tool generation)
 *  - `openapi.ts` action-endpoint docs
 *
 * Keeping this in one place prevents a class of cross-surface auth gaps where
 * REST is protected but MCP/OpenAPI see stale, undefined gates.
 *
 * Chain (fail-closed):
 *   1. Per-action `permissions` (explicit gate on the `ActionDefinition`)
 *   2. Resource-level `actionPermissions`
 *   3. Router-level `globalAuth` (only applies to HTTP; MCP/OpenAPI don't pass it)
 *   4. Resource `permissions.update` — actions mutate state, so this is the
 *      safe default. The HTTP normalizer warns when it fires; MCP/OpenAPI
 *      silently honour it.
 *   5. `undefined` — no gate; caller must treat this as either a boot error
 *      (HTTP path) or a "no permission declared" situation (MCP/OpenAPI).
 */

import type { PermissionCheck } from "../permissions/types.js";
import type { ActionEntry, ResourcePermissions } from "../types/index.js";

export interface ResolveActionPermissionInput {
  /** The `ActionEntry` from `resource.actions[name]` — function or `ActionDefinition`. */
  readonly action: ActionEntry;
  /** Resource-level `permissions` block (carries `update`, `create`, etc.). */
  readonly resourcePermissions: ResourcePermissions | undefined;
  /** Resource-level `actionPermissions` — global-for-actions gate. */
  readonly resourceActionPermissions: PermissionCheck | undefined;
  /**
   * Router-level `globalAuth` (HTTP only). Pass `undefined` from MCP/OpenAPI —
   * those surfaces reach this helper with only the resource-level data.
   */
  readonly globalAuth?: PermissionCheck;
}

/**
 * Return the effective `PermissionCheck` for a single action, or `undefined`
 * when the resource declares no gate at any level.
 *
 * Callers decide what "no gate" means:
 *   - HTTP: boot-time throw in `normalizeActionsToRouterConfig`.
 *   - MCP: tool-generation throw in `resourceToTools` (mirrors HTTP — the
 *     two surfaces fail closed identically so MCP can't expose an
 *     unauthenticated mutating tool when the HTTP plugin lifecycle hasn't
 *     run).
 *   - OpenAPI: docs advertise the endpoint as unauthenticated.
 */
export function resolveActionPermission(
  input: ResolveActionPermissionInput,
): PermissionCheck | undefined {
  const { action, resourcePermissions, resourceActionPermissions, globalAuth } = input;

  // 1. Per-action explicit permission.
  const explicit =
    typeof action !== "function" && action.permissions
      ? (action.permissions as PermissionCheck)
      : undefined;
  if (explicit) return explicit;

  // 2. Resource-level `actionPermissions`.
  if (resourceActionPermissions) return resourceActionPermissions;

  // 3. Router-level `globalAuth` (HTTP only).
  if (globalAuth) return globalAuth;

  // 4. Resource `permissions.update` fallback.
  const updateFallback = resourcePermissions?.update as PermissionCheck | undefined;
  if (updateFallback) return updateFallback;

  // 5. No gate.
  return undefined;
}
