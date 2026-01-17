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
  AdditionalRoute,
  AnyRecord,
  AuthConfig,
  MiddlewareConfig,
  PresetResult,
  ResourceConfig,
  RouteSchemaOptions,
} from '../types/index.js';

// Export preset functions
export { softDeletePreset } from './softDelete.js';
export type { SoftDeleteOptions } from './softDelete.js';

export { slugLookupPreset } from './slugLookup.js';
export type { SlugLookupOptions } from './slugLookup.js';

export { ownedByUserPreset } from './ownedByUser.js';
export type { OwnedByUserOptions } from './ownedByUser.js';

export { multiTenantPreset } from './multiTenant.js';
export type { MultiTenantOptions } from './multiTenant.js';

export { treePreset } from './tree.js';
export type { TreeOptions } from './tree.js';

export { auditedPreset } from './audited.js';
export type { AuditedPresetOptions } from './audited.js';

// Export preset type interfaces for type safety
export type {
  ISoftDeleteController,
  ISlugLookupController,
  ITreeController,
  IOwnedByUserPreset,
  IMultiTenantPreset,
  IAuditedPreset,
  IPresetController,
} from './types.js';

// Import preset implementations for sync resolution
import { softDeletePreset } from './softDelete.js';
import { slugLookupPreset } from './slugLookup.js';
import { ownedByUserPreset } from './ownedByUser.js';
import { multiTenantPreset } from './multiTenant.js';
import { treePreset } from './tree.js';
import { auditedPreset } from './audited.js';

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
};

/**
 * Get preset by name with options
 */
export function getPreset(nameOrConfig: string | { name: string; [key: string]: unknown }): PresetResult {
  if (typeof nameOrConfig === 'object' && nameOrConfig.name) {
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
    const available = Object.keys(presetRegistry).join(', ');
    throw new Error(
      `Unknown preset: '${name}'\n` +
      `Available presets: ${available}\n` +
      `Docs: https://github.com/classytic/arc#presets`
    );
  }

  return factory(options);
}

/**
 * Register a custom preset
 */
export function registerPreset(name: string, factory: PresetFactory): void {
  if (presetRegistry[name]) {
    throw new Error(`Preset '${name}' already exists`);
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

/**
 * Apply presets to resource config
 */
export function applyPresets<TDoc = AnyRecord>(
  config: ResourceConfig<TDoc>,
  presets: PresetInput[] = []
): ResourceConfig<TDoc> {
  let result = { ...config };

  for (const preset of presets) {
    const resolved = resolvePresetInput(preset);
    result = mergePreset(result, resolved) as ResourceConfig<TDoc>;
  }

  return result;
}

/**
 * Resolve preset input to PresetResult
 */
function resolvePresetInput(preset: PresetInput): PresetResult {
  // Check if already a fully-resolved PresetResult (has middlewares or additionalRoutes)
  // This allows custom presets to be passed directly without registry lookup
  if (typeof preset === 'object' && ('middlewares' in preset || 'additionalRoutes' in preset)) {
    return preset as PresetResult;
  }

  // Object with name and options (for registry lookup)
  if (typeof preset === 'object' && 'name' in preset) {
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
    operation: 'create' | 'update' | 'delete' | 'read' | 'list';
    phase: 'before' | 'after';
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
  preset: PresetResult
): ResourceConfig<TDoc> {
  const result = { ...config } as ExtendedResourceConfig<TDoc>;

  // Merge additional routes
  if (preset.additionalRoutes) {
    const routes: AdditionalRoute[] = typeof preset.additionalRoutes === 'function'
      ? preset.additionalRoutes(config.permissions ?? {})
      : preset.additionalRoutes;

    result.additionalRoutes = [
      ...(result.additionalRoutes ?? []),
      ...routes,
    ];
  }

  // Merge middlewares
  if (preset.middlewares) {
    result.middlewares = result.middlewares ?? {};
    for (const [op, mws] of Object.entries(preset.middlewares)) {
      const key = op as keyof MiddlewareConfig;
      result.middlewares[key] = [
        ...(result.middlewares[key] ?? []),
        ...(mws ?? []),
      ];
    }
  }

  // Merge schema options
  if (preset.schemaOptions) {
    result.schemaOptions = {
      ...result.schemaOptions,
      ...preset.schemaOptions,
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
