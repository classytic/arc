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
import { allowPublic } from "../../permissions/index.js";
import { applyPresets } from "../../presets/index.js";
import { unresolvedPresetPermission } from "../../presets/presetPermission.js";
import type { PresetController, ResourceConfig } from "../../types/index.js";
import { autoInjectTenantFieldRules } from "../schemaOptions.js";
import type { InternalResourceConfig } from "./config.js";
import type { ResourceDiagnostic } from "./diagnostics.js";

const PRESET_ROUTE_PUBLIC_BY_OMISSION = "preset-route-public-by-omission";

/**
 * Run the Phase 3 pipeline: clone → apply presets → infer tenant
 * field → auto-inject system-managed rules. Returns the resolved
 * `InternalResourceConfig` that every later phase consumes. `controller` is the
 * handle preset `routes(permissions, controller)` builders receive; Phase 4 binds it.
 */
export function applyPresetsAndAutoInject<TDoc>(
  config: ResourceConfig<TDoc>,
  controller: PresetController,
): InternalResourceConfig<TDoc> {
  const originalPresets = (config.presets ?? []).map((p) =>
    typeof p === "string" ? p : (p as { name: string }).name,
  );

  // Snapshot the keys the USER literally typed BEFORE any preset / inference /
  // auto-inject runs. Downstream warns about "dropped author options" must only
  // fire for declared keys — pre-2.15 we leaked false-positives whenever a
  // preset OR `inferTenantFieldFromAdapter` mutated the config (e.g. setting
  // `tenantField: false` automatically and then complaining the user "set"
  // tenantField on a custom-controller resource). Any future inference
  // benefits from this provenance for free.
  const declaredKeys = new Set<string>(
    Object.keys(config).filter(
      (k) => (config as unknown as Record<string, unknown>)[k] !== undefined,
    ),
  );

  const resolvedConfig = (
    config.presets?.length ? applyPresets(config, config.presets, controller) : { ...config }
  ) as InternalResourceConfig<TDoc>;

  resolvedConfig._appliedPresets = originalPresets;
  resolvedConfig._declaredKeys = declaredKeys;

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

/**
 * Preset routes whose permission resolved to nothing (no preset option, no resource
 * permission to inherit; see `presetPermission`). The CRUD-read ladder: `error` under
 * `strict`; otherwise `info`, and the route is mounted public (`allowPublic()`), as an
 * ungated CRUD read is. Rewrites `config.routes` (a fresh array owned by `resolvedConfig`).
 */
export function resolvePresetRoutePermissions<TDoc>(
  config: InternalResourceConfig<TDoc>,
  strict = false,
): ResourceDiagnostic[] {
  const diagnostics: ResourceDiagnostic[] = [];
  const routes = config.routes?.map((route) => {
    const unresolved = unresolvedPresetPermission(route.permissions);
    if (!unresolved) return route;
    const { preset, inherits, option } = unresolved;
    const where = `${route.method} ${route.path}`;
    diagnostics.push({
      severity: strict ? "error" : "info",
      code: PRESET_ROUTE_PUBLIC_BY_OMISSION,
      message:
        `[Arc] Resource '${config.name}': preset '${preset}' route ${where} has no permission ` +
        `(it inherits permissions.${inherits}, which is not set).\n` +
        (strict
          ? "strictPermissions is on and an ungated READ is fatal. State intent explicitly:\n"
          : "It is mounted WITHOUT auth. State intent explicitly:\n") +
        `  permissions: { ${inherits}: allowPublic(), ... }  // intentionally public\n` +
        `  permissions: { ${inherits}: requireAuth(), ... }  // or requireRoles([...])` +
        (option ? `\n  ${option}  // this route only` : ""),
    });
    return strict ? route : { ...route, permissions: allowPublic() };
  });
  if (routes && !strict && diagnostics.length > 0) config.routes = routes;
  return diagnostics;
}

const WRITE_OPERATIONS = new Set<string>(["create", "update", "delete"]);

/**
 * Public-by-omission CRUD diagnostic (post-preset).
 *
 * An omitted CRUD permission mounts the route with NO permission
 * middleware at all — unlike custom routes and actions, which fail boot
 * without one. That asymmetry silently shipped unauthenticated writes
 * (`permissions: readOnly()` pre-2.20 being the canonical victim).
 *
 * Runs against `resolvedConfig` — never the raw user config — so
 * permissions injected by presets (ownedByUser, multiTenant policy
 * wiring, ...) count as gates and don't false-positive.
 *
 * Severity ladder:
 *   - `error` when ANY enabled op is ungated AND `strict` is on — the resource
 *     fails boot (`defineResource()` throws). An ungated read is as fatal as an
 *     ungated write: a public catalog states it with `allowPublic()`, so an
 *     accidental public read never ships.
 *   - `warn` (strict off) when an enabled WRITE op is ungated.
 *   - `info` (strict off) when only reads are ungated.
 *
 * The caller resolves `strict` (resource `strictPermissions`, else the
 * `ARC_STRICT_PERMISSIONS` env, which is on unless set to false).
 */
export function collectUngatedCrudDiagnostics<TDoc>(
  config: InternalResourceConfig<TDoc>,
  strict = false,
): ResourceDiagnostic[] {
  if (config.disableDefaultRoutes) return [];
  const disabled = new Set(config.disabledRoutes ?? []);
  const permissions = (config.permissions ?? {}) as Record<string, unknown>;
  const ungated = CRUD_OPERATIONS.filter(
    (op) => !disabled.has(op) && typeof permissions[op] !== "function",
  );
  if (ungated.length === 0) return [];

  const hasUngatedWrite = ungated.some((op) => WRITE_OPERATIONS.has(op));
  const severity: ResourceDiagnostic["severity"] = strict
    ? "error"
    : hasUngatedWrite
      ? "warn"
      : "info";
  const ungatedReads = ungated.filter((op) => !WRITE_OPERATIONS.has(op));
  return [
    {
      severity,
      code: "crud-public-by-omission",
      message:
        `[Arc] Resource '${config.name}' mounts ${ungated.length} CRUD route(s) with no permission gate: ${ungated.join(", ")}.\n` +
        (severity === "error"
          ? `strictPermissions is on and an ungated ${hasUngatedWrite ? "WRITE" : "READ"} is fatal. State intent explicitly:\n`
          : "An omitted permission mounts the route WITHOUT auth. State intent explicitly:\n") +
        (ungatedReads.length > 0
          ? `  permissions: { ${ungatedReads.map((op) => `${op}: allowPublic()`).join(", ")}, ... }  // intentionally public reads\n`
          : "") +
        `  permissions: fullPublic()     // every op intentionally public\n` +
        `  permissions: authenticated()  // require auth on every op\n` +
        `  permissions: { ${ungated[0]}: requireAuth(), ... }  // per-operation` +
        // A warning nobody can act on decisively gets filtered. Name the
        // switch that makes this whole class of mistake impossible. It is on
        // by default, so this branch only runs for a host that turned it off.
        (severity === "warn"
          ? "\nRecommended in production: ARC_STRICT_PERMISSIONS=true (or `strictPermissions: " +
            "true` on the resource) makes an ungated WRITE fail the boot instead of shipping. " +
            "Strict permissions is the default; this resource or app has switched it off."
          : ""),
    },
  ];
}
