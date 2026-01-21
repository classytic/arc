/**
 * Resource Registry
 *
 * Singleton that tracks all registered resources for introspection.
 */

import type {
  IntrospectionData,
  OpenApiSchemas,
  RegistryEntry,
  RegistryStats,
  ResourcePermissions,
} from '../types/index.js';
import type { ResourceDefinition } from '../core/defineResource.js';

export interface RegisterOptions {
  module?: string;
  /** Pre-generated OpenAPI schemas */
  openApiSchemas?: OpenApiSchemas;
}

export class ResourceRegistry {
  private _resources: Map<string, RegistryEntry>;
  private _frozen: boolean;

  constructor() {
    this._resources = new Map();
    this._frozen = false;
  }

  /**
   * Register a resource
   */
  register(resource: ResourceDefinition<unknown>, options: RegisterOptions = {}): this {
    if (this._frozen) {
      throw new Error(
        `Registry frozen. Cannot register '${resource.name}' after startup.`
      );
    }

    if (this._resources.has(resource.name)) {
      throw new Error(`Resource '${resource.name}' already registered.`);
    }

    const entry: RegistryEntry = {
      name: resource.name,
      displayName: resource.displayName,
      tag: resource.tag,
      prefix: resource.prefix,
      module: options.module ?? undefined,
      adapter: resource.adapter
        ? {
            type: resource.adapter.type,
            name: resource.adapter.name,
          }
        : null,
      permissions: resource.permissions as ResourcePermissions | undefined,
      presets: resource._appliedPresets ?? [],
      routes: [], // Populated later by getIntrospection()
      additionalRoutes: resource.additionalRoutes.map((r) => ({
        method: r.method,
        path: r.path,
        handler:
          typeof r.handler === 'string'
            ? r.handler
            : (r.handler as Function).name || 'anonymous',
        summary: r.summary,
        description: r.description,
        permissions: r.permissions,
        wrapHandler: r.wrapHandler,
        schema: r.schema, // Include schema for OpenAPI docs
      })),
      events: Object.keys(resource.events ?? {}),
      registeredAt: new Date().toISOString(),
      disableDefaultRoutes: resource.disableDefaultRoutes,
      openApiSchemas: options.openApiSchemas,
      plugin: resource.toPlugin(), // Store plugin factory
    };

    this._resources.set(resource.name, entry);
    return this;
  }

  /**
   * Get resource by name
   */
  get(name: string): RegistryEntry | undefined {
    return this._resources.get(name);
  }

  /**
   * Get all resources
   */
  getAll(): RegistryEntry[] {
    return Array.from(this._resources.values());
  }

  /**
   * Get resources by module
   */
  getByModule(moduleName: string): RegistryEntry[] {
    return this.getAll().filter((r) => r.module === moduleName);
  }

  /**
   * Get resources by preset
   */
  getByPreset(presetName: string): RegistryEntry[] {
    return this.getAll().filter((r) => r.presets.includes(presetName));
  }

  /**
   * Check if resource exists
   */
  has(name: string): boolean {
    return this._resources.has(name);
  }

  /**
   * Get registry statistics
   */
  getStats(): RegistryStats {
    const resources = this.getAll();
    const presetCounts: Record<string, number> = {};

    for (const r of resources) {
      for (const preset of r.presets) {
        presetCounts[preset] = (presetCounts[preset] ?? 0) + 1;
      }
    }

    return {
      totalResources: resources.length,
      byModule: this._groupBy(resources, 'module'),
      presetUsage: presetCounts,
      totalRoutes: resources.reduce((sum, r) => {
        const defaultRouteCount = r.disableDefaultRoutes ? 0 : 5;
        return sum + (r.additionalRoutes?.length ?? 0) + defaultRouteCount;
      }, 0),
      totalEvents: resources.reduce((sum, r) => sum + (r.events?.length ?? 0), 0),
    };
  }

  /**
   * Get full introspection data
   */
  getIntrospection(): IntrospectionData {
    return {
      resources: this.getAll().map((r) => {
        // Only include default routes if not disabled
        const defaultRoutes = r.disableDefaultRoutes
          ? []
          : [
              { method: 'GET', path: r.prefix, operation: 'list' },
              { method: 'GET', path: `${r.prefix}/:id`, operation: 'get' },
              { method: 'POST', path: r.prefix, operation: 'create' },
              { method: 'PATCH', path: `${r.prefix}/:id`, operation: 'update' },
              { method: 'DELETE', path: `${r.prefix}/:id`, operation: 'delete' },
            ];

        return {
          name: r.name,
          displayName: r.displayName,
          prefix: r.prefix,
          module: r.module,
          presets: r.presets,
          permissions: r.permissions,
          routes: [
            ...defaultRoutes,
            ...(r.additionalRoutes?.map((ar) => ({
              method: ar.method,
              path: `${r.prefix}${ar.path}`,
              operation: typeof ar.handler === 'string' ? ar.handler : 'custom',
              handler: typeof ar.handler === 'string' ? ar.handler : undefined,
              summary: ar.summary,
            })) ?? []),
          ],
          events: r.events,
        };
      }),
      stats: this.getStats(),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Freeze registry (prevent further registrations)
   */
  freeze(): void {
    this._frozen = true;
  }

  /**
   * Check if frozen
   */
  isFrozen(): boolean {
    return this._frozen;
  }

  /**
   * Unfreeze registry (for testing)
   */
  _unfreeze(): void {
    this._frozen = false;
  }

  /**
   * Clear all resources (for testing)
   */
  _clear(): void {
    this._resources.clear();
    this._frozen = false;
  }

  /**
   * Group by key
   */
  private _groupBy(
    arr: RegistryEntry[],
    key: keyof RegistryEntry
  ): Record<string, number> {
    const result: Record<string, number> = {};
    for (const item of arr) {
      const k = String(item[key] ?? 'uncategorized');
      result[k] = (result[k] ?? 0) + 1;
    }
    return result;
  }
}

// Singleton instance (use global to avoid duplicate bundles creating separate registries)
const registryKey = Symbol.for('arc.resourceRegistry');
const globalScope = globalThis as typeof globalThis & {
  [registryKey]?: ResourceRegistry;
};
export const resourceRegistry = globalScope[registryKey] ?? new ResourceRegistry();
if (!globalScope[registryKey]) {
  globalScope[registryKey] = resourceRegistry;
}

export default resourceRegistry;
