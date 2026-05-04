/**
 * Phase 1 — fail-fast structural validation.
 *
 * Rejects malformed config BEFORE preset application, controller
 * construction, or schema synthesis run. The goal is "any error
 * surfaced here points at exactly one user mistake" — preset/Phase 3+
 * errors carry less of a paper trail back to the source.
 */

import type { ActionDefinition, AnyRecord, ResourceConfig } from "../../types/index.js";
import { assertValidConfig } from "../validateResourceConfig.js";

/**
 * CRUD op names — kept module-scope (vs allocated per `defineResource()`
 * call) since the set is fixed and the cost of re-allocating is a
 * pointless boot tax for hosts with hundreds of resources.
 */
const CRUD_OP_NAMES = new Set<string>(["create", "update", "delete", "list", "get"]);

/**
 * Run the structural validation pipeline. Throws an `Error` with a
 * resource-named message on the first failure — `defineResource()`
 * surfaces it verbatim so hosts get a clear "fix this resource"
 * pointer.
 */
export function validateDefineResourceConfig<TDoc>(config: ResourceConfig<TDoc>): void {
  assertValidConfig(config as ResourceConfig<AnyRecord>, {
    skipControllerCheck: true,
  });

  validatePermissionsShape(config);
  validateCustomRoutePermissions(config);
  validateActionsShape(config);
}

/** Permissions must be `PermissionCheck` functions, not arbitrary values. */
function validatePermissionsShape<TDoc>(config: ResourceConfig<TDoc>): void {
  if (!config.permissions) return;
  for (const [key, value] of Object.entries(config.permissions)) {
    if (value !== undefined && typeof value !== "function") {
      throw new Error(
        `[Arc] Resource '${config.name}': permissions.${key} must be a PermissionCheck function.\n` +
          `Use allowPublic(), requireAuth(), or requireRoles(['role']) from @classytic/arc/permissions.`,
      );
    }
  }
}

/**
 * Custom routes must declare `permissions` as a function — fail-closed
 * default. A missing `permissions` could otherwise quietly mount an
 * unauthenticated route.
 */
function validateCustomRoutePermissions<TDoc>(config: ResourceConfig<TDoc>): void {
  for (const route of config.routes ?? []) {
    if (typeof route.permissions !== "function") {
      throw new Error(
        `[Arc] Resource '${config.name}' route ${route.method} ${route.path}: ` +
          `permissions is required and must be a PermissionCheck function.`,
      );
    }
  }
}

/**
 * Actions (v2.8) — name must not collide with CRUD ops; handler +
 * permissions must have the right shapes. Fail at boot so production
 * never ships a misconfigured action endpoint.
 */
function validateActionsShape<TDoc>(config: ResourceConfig<TDoc>): void {
  if (!config.actions) return;
  for (const [name, entry] of Object.entries(config.actions)) {
    if (CRUD_OP_NAMES.has(name)) {
      throw new Error(
        `[Arc] Resource '${config.name}': action '${name}' conflicts with CRUD operation.\n` +
          `Use a different name (e.g., '${name}_item', 'do_${name}').`,
      );
    }
    if (typeof entry !== "function") {
      const def = entry as ActionDefinition;
      if (typeof def.handler !== "function") {
        throw new Error(
          `[Arc] Resource '${config.name}': actions.${name}.handler must be a function.`,
        );
      }
      if (def.permissions !== undefined && typeof def.permissions !== "function") {
        throw new Error(
          `[Arc] Resource '${config.name}': actions.${name}.permissions must be a PermissionCheck function.`,
        );
      }
    }
  }
}
