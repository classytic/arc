/**
 * Phase 1 — fail-fast structural validation.
 *
 * Rejects malformed config BEFORE preset application, controller
 * construction, or schema synthesis run. The goal is "any error
 * surfaced here points at exactly one user mistake" — preset/Phase 3+
 * errors carry less of a paper trail back to the source.
 *
 * Two failure modes:
 *
 *   1. Hard errors (`throw new Error(...)`) — config will never produce
 *      a working resource. Surfaced synchronously at define-time so the
 *      host sees the failure during module load, before any request
 *      can hit a half-wired endpoint.
 *
 *   2. Non-fatal diagnostics — collected into a `ResourceDiagnostic[]`
 *      and returned to the caller. `defineResource()` attaches them to
 *      `ResourceDefinition._diagnostics`; `buildResourcePlugin` flushes
 *      them through `fastify.log.warn` on first mount so the host's
 *      configured logger handles them. The framework never reaches for
 *      `console.*` directly outside of `src/cli/`.
 */

import type { ActionDefinition, AnyRecord, ResourceConfig } from "../../types/index.js";
import { assertValidConfig } from "../validateResourceConfig.js";
import type { ResourceDiagnostic } from "./diagnostics.js";

/**
 * CRUD op names — kept module-scope (vs allocated per `defineResource()`
 * call) since the set is fixed and the cost of re-allocating is a
 * pointless boot tax for hosts with hundreds of resources.
 */
const CRUD_OP_NAMES = new Set<string>(["create", "update", "delete", "list", "get"]);

/**
 * Run the structural validation pipeline.
 *
 * Throws synchronously on hard errors. Returns the (possibly empty)
 * list of non-fatal diagnostics — defineResource attaches them to the
 * resulting `ResourceDefinition` for the plugin layer to flush through
 * `fastify.log.warn` on first mount.
 */
export function validateDefineResourceConfig<TDoc>(
  config: ResourceConfig<TDoc>,
): ResourceDiagnostic[] {
  assertValidConfig(config as ResourceConfig<AnyRecord>, {
    skipControllerCheck: true,
  });

  validatePermissionsShape(config);
  validateCustomRoutePermissions(config);
  validateActionsShape(config);
  return collectRedundantFieldRuleDiagnostics(config);
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
 * Surface common field-rule misconfigurations as boot-time diagnostics.
 *
 * Catches:
 *   1. `immutable: true` + `immutableAfterCreate: true` — `immutable`
 *      already covers `immutableAfterCreate`. Picking both signals the
 *      author wasn't sure which to use.
 *   2. `systemManaged: true` + `readonly: true` — both are write rules
 *      and `BodySanitizer` strips on either; the second flag is dead.
 *   3. `hidden: true` + `aggregable: false` — `hidden` already blocks
 *      aggregation; `aggregable: false` is redundant.
 *
 * NOT hard errors — write-rule overlap is harmless at runtime, just
 * noisy in code review. Returned as `ResourceDiagnostic[]` so the
 * caller can route them through the host logger; never logged here.
 */
function collectRedundantFieldRuleDiagnostics<TDoc>(
  config: ResourceConfig<TDoc>,
): ResourceDiagnostic[] {
  const fieldRules = config.schemaOptions?.fieldRules;
  if (!fieldRules) return [];

  const diagnostics: ResourceDiagnostic[] = [];
  for (const [field, rule] of Object.entries(fieldRules)) {
    if (!rule) continue;
    const r = rule as Record<string, unknown>;
    if (r.immutable === true && r.immutableAfterCreate === true) {
      diagnostics.push({
        severity: "warn",
        code: "field-rule-redundant-immutable",
        message:
          `[Arc] Resource '${config.name}' fieldRules.${field}: ` +
          "`immutable: true` already implies `immutableAfterCreate: true` — drop the second flag.",
      });
    }
    if (r.systemManaged === true && r.readonly === true) {
      diagnostics.push({
        severity: "warn",
        code: "field-rule-redundant-system-managed",
        message:
          `[Arc] Resource '${config.name}' fieldRules.${field}: ` +
          "`systemManaged` and `readonly` both strip writes — pick one (`systemManaged` is the canonical name).",
      });
    }
    if (r.hidden === true && r.aggregable === false) {
      diagnostics.push({
        severity: "warn",
        code: "field-rule-redundant-hidden",
        message:
          `[Arc] Resource '${config.name}' fieldRules.${field}: ` +
          "`hidden: true` already blocks aggregation — `aggregable: false` is redundant.",
      });
    }
  }
  return diagnostics;
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
