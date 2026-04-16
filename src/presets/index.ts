/**
 * Presets Module
 *
 * Reusable resource configurations that add routes, middlewares, and schema options.
 *
 * @example
 * import { defineResource } from '@classytic/arc';
 *
 * // Using preset strings (resolved internally)
 * defineResource({
 *   presets: ['softDelete', 'slugLookup'],
 * });
 *
 * // Using preset functions with options
 * import { softDeletePreset, treePreset } from '@classytic/arc/presets';
 *
 * defineResource({
 *   presets: [
 *     softDeletePreset(),
 *     treePreset({ parentField: 'parentSlug' }),
 *   ],
 * });
 */

import type {
  AnyRecord,
  MiddlewareConfig,
  PresetResult,
  ResourceConfig,
  RouteSchemaOptions,
} from "../types/index.js";

export type { MultiTenantOptions, TenantFieldSpec } from "./multiTenant.js";
export { multiTenantPreset } from "./multiTenant.js";
export type { OwnedByUserOptions } from "./ownedByUser.js";

export { ownedByUserPreset } from "./ownedByUser.js";
export type { SlugLookupOptions } from "./slugLookup.js";
export { slugLookupPreset } from "./slugLookup.js";
// Export preset functions
export { softDeletePreset } from "./softDelete.js";

/**
 * Convenience alias for multiTenantPreset with public list/get routes
 * Equivalent to: multiTenantPreset({ allowPublic: ['list', 'get'] })
 */
export const flexibleMultiTenantPreset = (
  options: Omit<import("./multiTenant.js").MultiTenantOptions, "allowPublic"> = {},
) => multiTenantPreset({ ...options, allowPublic: ["list", "get"] });

export type { AuditedPresetOptions } from "./audited.js";
export { auditedPreset } from "./audited.js";
export type { BulkOperation, BulkPresetOptions } from "./bulk.js";
export { bulkPreset } from "./bulk.js";
export type {
  FilesUploadPresetOptions,
  FilesUploadPresetPermissions,
  FilesUploadPresetRoutes,
} from "./filesUpload.js";
export { filesUploadPreset } from "./filesUpload.js";
export type {
  SearchHandler,
  SearchPresetOptions,
  SearchRouteConfig,
} from "./search.js";
export { searchPreset } from "./search.js";
export type { TreeOptions } from "./tree.js";
export { treePreset } from "./tree.js";

// Export preset type interfaces for type safety
export type {
  IAuditedPreset,
  IMultiTenantPreset,
  IOwnedByUserPreset,
  IPresetController,
  ISlugLookupController,
  ISoftDeleteController,
  ITreeController,
} from "./types.js";

import { auditedPreset } from "./audited.js";
import { bulkPreset } from "./bulk.js";
import { multiTenantPreset } from "./multiTenant.js";
import { ownedByUserPreset } from "./ownedByUser.js";
import { slugLookupPreset } from "./slugLookup.js";
// Import preset implementations for sync resolution
import { softDeletePreset } from "./softDelete.js";
import { treePreset } from "./tree.js";

// ============================================================================
// Preset Registry
// ============================================================================

type PresetFactory = (options?: AnyRecord) => PresetResult;

const presetRegistry: Record<string, PresetFactory> = {
  softDelete: softDeletePreset,
  slugLookup: slugLookupPreset,
  ownedByUser: ownedByUserPreset,
  multiTenant: multiTenantPreset,
  tree: treePreset,
  audited: auditedPreset,
  bulk: bulkPreset,
};

/**
 * Get preset by name with options
 */
export function getPreset(
  nameOrConfig: string | { name: string; [key: string]: unknown },
): PresetResult {
  if (typeof nameOrConfig === "object" && nameOrConfig.name) {
    const { name, ...options } = nameOrConfig;
    return resolvePreset(name, options);
  }

  return resolvePreset(nameOrConfig as string);
}

/**
 * Resolve preset by name
 */
function resolvePreset(name: string, options: AnyRecord = {}): PresetResult {
  const factory = presetRegistry[name];

  if (!factory) {
    const available = Object.keys(presetRegistry).join(", ");
    throw new Error(
      `Unknown preset: '${name}'\n` +
        `Available presets: ${available}\n` +
        `Docs: https://github.com/classytic/arc#presets`,
    );
  }

  return factory(options);
}

/**
 * Register a custom preset
 */
export function registerPreset(
  name: string,
  factory: PresetFactory,
  options?: { override?: boolean },
): void {
  if (presetRegistry[name] && !options?.override) {
    throw new Error(`Preset '${name}' already exists. Pass { override: true } to replace.`);
  }
  presetRegistry[name] = factory;
}

/**
 * Get all available preset names
 */
export function getAvailablePresets(): string[] {
  return Object.keys(presetRegistry);
}

// ============================================================================
// Apply Presets
// ============================================================================

type PresetInput = string | PresetResult | { name: string; [key: string]: unknown };

// ============================================================================
// Preset Conflict Detection
// ============================================================================

interface PresetConflict {
  presets: [string, string];
  message: string;
  severity: "error" | "warning";
}

/**
 * Validate that preset combinations don't conflict.
 * Detects route collisions (same method + path from different presets).
 */
function validatePresetCombination(presets: PresetResult[]): PresetConflict[] {
  const conflicts: PresetConflict[] = [];
  const routeMap = new Map<string, string>(); // "METHOD /path" -> preset name

  for (const preset of presets) {
    const name = preset.name ?? "unknown";
    const presetRoutes = preset.routes
      ? typeof preset.routes === "function"
        ? preset.routes({})
        : preset.routes
      : [];

    for (const route of presetRoutes) {
      const key = `${route.method} ${route.path}`;
      const existing = routeMap.get(key);
      if (existing) {
        conflicts.push({
          presets: [existing, name],
          message: `Both '${existing}' and '${name}' define route ${key}`,
          severity: "error",
        });
      }
      routeMap.set(key, name);
    }
  }

  return conflicts;
}

/**
 * Apply presets to resource config.
 * Validates preset combinations for conflicts before merging.
 */
export function applyPresets<TDoc = AnyRecord>(
  config: ResourceConfig<TDoc>,
  presets: PresetInput[] = [],
): ResourceConfig<TDoc> {
  let result = { ...config };

  // Resolve all presets first for validation
  const resolved = presets.map(resolvePresetInput);

  // Validate combinations — fail-fast on route collisions
  const conflicts = validatePresetCombination(resolved);
  const errors = conflicts.filter((c) => c.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `[Arc] Resource '${config.name}' preset conflicts:\n` +
        errors.map((c) => `  - ${c.message}`).join("\n"),
    );
  }

  for (const preset of resolved) {
    result = mergePreset(result, preset) as ResourceConfig<TDoc>;
  }

  return result;
}

/**
 * Resolve preset input to PresetResult
 */
function resolvePresetInput(preset: PresetInput): PresetResult {
  // Check if already a fully-resolved PresetResult (has routes or middlewares)
  if (typeof preset === "object" && ("middlewares" in preset || "routes" in preset)) {
    return preset as PresetResult;
  }

  // Object with name and options (for registry lookup)
  if (typeof preset === "object" && "name" in preset) {
    const { name, ...options } = preset as { name: string; [key: string]: unknown };
    return resolvePreset(name, options);
  }

  // String preset name
  return resolvePreset(preset);
}

/** Extended config with internal fields */
interface ExtendedResourceConfig<TDoc = AnyRecord> extends ResourceConfig<TDoc> {
  _controllerOptions?: {
    slugField?: string;
    parentField?: string;
    [key: string]: unknown;
  };
  _hooks?: Array<{
    presetName: string;
    operation: "create" | "update" | "delete" | "read" | "list";
    phase: "before" | "after";
    handler: (ctx: {
      resource: string;
      operation: string;
      phase: string;
      data?: AnyRecord;
      result?: AnyRecord | AnyRecord[];
      user?: { id: string; email: string; [key: string]: unknown };
      context?: { organizationId?: string | null; [key: string]: unknown };
      meta?: AnyRecord;
    }) => void | Promise<void> | AnyRecord | Promise<AnyRecord>;
    priority?: number;
  }>;
}

/**
 * Merge preset into config
 */
function mergePreset<TDoc = AnyRecord>(
  config: ResourceConfig<TDoc>,
  preset: PresetResult,
): ResourceConfig<TDoc> {
  const result = { ...config } as ExtendedResourceConfig<TDoc>;

  // Merge preset routes into config.routes (v2.8.1+)
  if (preset.routes) {
    const resolved =
      typeof preset.routes === "function" ? preset.routes(config.permissions ?? {}) : preset.routes;
    result.routes = [...(result.routes ?? []), ...resolved];
  }

  // Merge middlewares
  if (preset.middlewares) {
    result.middlewares = result.middlewares ?? {};
    for (const [op, mws] of Object.entries(preset.middlewares)) {
      const key = op as keyof MiddlewareConfig;
      result.middlewares[key] = [...(result.middlewares[key] ?? []), ...(mws ?? [])];
    }
  }

  // Merge schema options (deep-merge fieldRules so presets accumulate rules)
  if (preset.schemaOptions) {
    result.schemaOptions = {
      ...result.schemaOptions,
      ...preset.schemaOptions,
      fieldRules: {
        ...result.schemaOptions?.fieldRules,
        ...preset.schemaOptions?.fieldRules,
      },
    } as RouteSchemaOptions;
  }

  // Merge controller options (slugField, parentField, etc.)
  if (preset.controllerOptions) {
    result._controllerOptions = {
      ...result._controllerOptions,
      ...preset.controllerOptions,
    };
  }

  // Collect hooks from preset
  if (preset.hooks && preset.hooks.length > 0) {
    result._hooks = result._hooks ?? [];
    for (const hook of preset.hooks) {
      result._hooks.push({
        presetName: preset.name,
        operation: hook.operation,
        phase: hook.phase,
        handler: hook.handler,
        priority: hook.priority,
      });
    }
  }

  return result;
}
