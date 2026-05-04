/**
 * Phase 3 — apply presets + auto-inject tenant-field schema rules.
 *
 * Produces the canonical `resolvedConfig` — a fresh clone of the
 * caller's config with presets applied and tenant-field schema rules
 * inferred. Always returns a fresh object so downstream mutations
 * (`_appliedPresets`, `schemaOptions` auto-inject, `_controllerOptions`,
 * `_hooks`) never leak onto the caller's config. Pre-2.11 the
 * no-preset branch returned the raw caller reference, which mutated
 * resource-config fragments hosts were reusing.
 *
 * Centralising the auto-inject + tenant inference here means every
 * downstream reader (`BodySanitizer`, adapter `generateSchemas()`,
 * MCP tool generator, OpenAPI builder) sees the same post-inject
 * shape — `defineResource()` only ever consults `resolvedConfig`,
 * never the raw user input, after this phase runs.
 */

import { CRUD_OPERATIONS, DEFAULT_TENANT_FIELD } from "../../constants.js";
import { arcLog } from "../../logger/index.js";
import { applyPresets } from "../../presets/index.js";
import type { ResourceConfig } from "../../types/index.js";
import { autoInjectTenantFieldRules } from "../schemaOptions.js";
import type { InternalResourceConfig } from "./config.js";

/**
 * Run the Phase 3 pipeline: clone → apply presets → infer tenant
 * field → auto-inject system-managed rules. Returns the resolved
 * `InternalResourceConfig` that every later phase consumes.
 */
export function applyPresetsAndAutoInject<TDoc>(
  config: ResourceConfig<TDoc>,
): InternalResourceConfig<TDoc> {
  const originalPresets = (config.presets ?? []).map((p) =>
    typeof p === "string" ? p : (p as { name: string }).name,
  );

  const resolvedConfig = (
    config.presets?.length ? applyPresets(config, config.presets) : { ...config }
  ) as InternalResourceConfig<TDoc>;

  resolvedConfig._appliedPresets = originalPresets;

  inferTenantFieldFromAdapter(resolvedConfig);

  resolvedConfig.schemaOptions = autoInjectTenantFieldRules(
    resolvedConfig.schemaOptions,
    resolvedConfig.tenantField,
  );

  return resolvedConfig;
}

/**
 * Infer `tenantField: false` for resources whose model schema doesn't
 * declare the configured tenant path. Closes the silent-zero-results
 * footgun where hosts forget `tenantField: false` on company-wide
 * tables (lookup tables, platform settings, single-tenant apps) — the
 * default `'organizationId'` filter would scope every read to the
 * caller's org and return nothing for documents that don't carry the
 * field. Adapters opt into inference by implementing `hasFieldPath`;
 * when the hook is absent, behaviour is unchanged (legacy default).
 *
 * Mutates the resolved config in place because (a) the next call
 * (`autoInjectTenantFieldRules`) reads the inferred value, and (b)
 * `_appliedPresets` is already stamped — keeping the mutation here
 * avoids a second clone per resource.
 *
 * Three branches:
 *   - `tenantField === false` → host explicitly opted out, no inference.
 *   - `tenantField === undefined` AND adapter says the default doesn't
 *     exist → set to `false`, log info (the inferred decision).
 *   - `tenantField === '<custom>'` AND adapter says it doesn't exist →
 *     warn (likely typo or stale field); leave the value as-is so
 *     failures surface at runtime with the configured name in error
 *     messages.
 */
function inferTenantFieldFromAdapter<TDoc>(config: InternalResourceConfig<TDoc>): void {
  if (config.tenantField === false) return;

  const adapter = config.adapter as
    | { hasFieldPath?: (name: string) => boolean | undefined }
    | undefined;
  if (!adapter?.hasFieldPath) return;

  const configured = config.tenantField ?? DEFAULT_TENANT_FIELD;
  const exists = adapter.hasFieldPath(configured);
  // `undefined` per the `hasFieldPath` contract = "adapter doesn't
  // know" — treat as "skip inference".
  if (exists === undefined) return;
  if (exists) return;

  if (config.tenantField === undefined) {
    config.tenantField = false;
    arcLog("defineResource").info(
      `Resource "${config.name}": auto-inferred \`tenantField: false\` — model has no \`${configured}\` path. ` +
        `Set \`tenantField\` explicitly to silence this log, or to a real field name on this resource's model.`,
    );
    return;
  }

  arcLog("defineResource").warn(
    `Resource "${config.name}": configured \`tenantField: '${configured}'\` but the model has no such path. ` +
      `Queries scoped by this field will silently return nothing. ` +
      `Either set \`tenantField: false\` (company-wide resource), or fix the field name.`,
  );
}

/** Does this resource register any default CRUD routes? */
export function computeHasCrudRoutes<TDoc>(config: ResourceConfig<TDoc>): boolean {
  const disabled = new Set(config.disabledRoutes ?? []);
  return !config.disableDefaultRoutes && CRUD_OPERATIONS.some((op) => !disabled.has(op));
}
