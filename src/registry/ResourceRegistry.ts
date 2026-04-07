/**
 * Resource Registry
 *
 * Singleton that tracks all registered resources for introspection.
 */

import { CRUD_OPERATIONS, DEFAULT_UPDATE_METHOD } from "../constants.js";
import type { ResourceDefinition } from "../core/defineResource.js";
import type { FieldPermissionMap } from "../permissions/fields.js";
import type { PipelineConfig, PipelineStep } from "../pipeline/types.js";
import type {
  IntrospectionData,
  OpenApiSchemas,
  RegistryEntry,
  RegistryStats,
  ResourcePermissions,
} from "../types/index.js";

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
      throw new Error(`Registry frozen. Cannot register '${resource.name}' after startup.`);
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
          typeof r.handler === "string" ? r.handler : (r.handler as Function).name || "anonymous",
        operation: r.operation,
        summary: r.summary,
        description: r.description,
        permissions: r.permissions,
        wrapHandler: r.wrapHandler,
        schema: r.schema, // Include schema for OpenAPI docs
      })),
      events: Object.keys(resource.events ?? {}),
      registeredAt: new Date().toISOString(),
      disableDefaultRoutes: resource.disableDefaultRoutes,
      updateMethod: resource.updateMethod,
      disabledRoutes: resource.disabledRoutes,
      openApiSchemas: options.openApiSchemas,
      fieldPermissions: extractFieldPermissions(resource.fields),
      pipelineSteps: extractPipelineSteps(resource.pipe),
      rateLimit: resource.rateLimit,
      audit: resource.audit,
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
      byModule: this._groupBy(resources, "module"),
      presetUsage: presetCounts,
      totalRoutes: resources.reduce((sum, r) => {
        if (r.disableDefaultRoutes) {
          return sum + (r.additionalRoutes?.length ?? 0);
        }
        const disabledSet = new Set(r.disabledRoutes ?? []);
        let defaultCount = CRUD_OPERATIONS.filter((route) => !disabledSet.has(route)).length;
        // 'update' creates 2 routes when updateMethod is 'both' (PUT + PATCH)
        if (!disabledSet.has("update") && r.updateMethod === "both") {
          defaultCount += 1;
        }
        return sum + defaultCount + (r.additionalRoutes?.length ?? 0);
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
        // Build default routes accounting for disabledRoutes and updateMethod
        const disabledSet = new Set(r.disabledRoutes ?? []);
        const updateMethod = r.updateMethod ?? DEFAULT_UPDATE_METHOD;
        const defaultRoutes = r.disableDefaultRoutes
          ? []
          : [
              ...(!disabledSet.has("list")
                ? [{ method: "GET", path: r.prefix, operation: "list" }]
                : []),
              ...(!disabledSet.has("get")
                ? [{ method: "GET", path: `${r.prefix}/:id`, operation: "get" }]
                : []),
              ...(!disabledSet.has("create")
                ? [{ method: "POST", path: r.prefix, operation: "create" }]
                : []),
              ...(!disabledSet.has("update")
                ? updateMethod === "both"
                  ? [
                      { method: "PUT", path: `${r.prefix}/:id`, operation: "update" },
                      { method: "PATCH", path: `${r.prefix}/:id`, operation: "update" },
                    ]
                  : [{ method: updateMethod, path: `${r.prefix}/:id`, operation: "update" }]
                : []),
              ...(!disabledSet.has("delete")
                ? [{ method: "DELETE", path: `${r.prefix}/:id`, operation: "delete" }]
                : []),
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
              operation: ar.operation ?? (typeof ar.handler === "string" ? ar.handler : "custom"),
              handler: typeof ar.handler === "string" ? ar.handler : undefined,
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
   * Unfreeze registry (allow new registrations)
   */
  unfreeze(): void {
    this._frozen = false;
  }

  /**
   * Reset registry — clear all resources and unfreeze
   */
  reset(): void {
    this._resources.clear();
    this._frozen = false;
  }

  /** @internal Alias for unfreeze() */
  _unfreeze(): void {
    this.unfreeze();
  }

  /** @internal Alias for reset() */
  _clear(): void {
    this.reset();
  }

  /**
   * Group by key
   */
  private _groupBy(arr: RegistryEntry[], key: keyof RegistryEntry): Record<string, number> {
    const result: Record<string, number> = {};
    for (const item of arr) {
      const k = String(item[key] ?? "uncategorized");
      result[k] = (result[k] ?? 0) + 1;
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers for extracting v2.0 metadata
// ---------------------------------------------------------------------------

function extractFieldPermissions(fields?: FieldPermissionMap): RegistryEntry["fieldPermissions"] {
  if (!fields || Object.keys(fields).length === 0) return undefined;

  const result: NonNullable<RegistryEntry["fieldPermissions"]> = {};
  for (const [field, perm] of Object.entries(fields)) {
    const entry: { type: string; roles?: readonly string[]; redactValue?: unknown } = {
      type: perm._type,
    };
    if (perm.roles?.length) entry.roles = perm.roles;
    if (perm.redactValue !== undefined) entry.redactValue = perm.redactValue;
    result[field] = entry;
  }
  return result;
}

function extractPipelineSteps(pipe?: PipelineConfig): RegistryEntry["pipelineSteps"] {
  if (!pipe) return undefined;

  const steps: PipelineStep[] = [];
  if (Array.isArray(pipe)) {
    steps.push(...pipe);
  } else {
    const seen = new Set<string>();
    for (const opSteps of Object.values(pipe)) {
      if (Array.isArray(opSteps)) {
        for (const step of opSteps) {
          const key = `${step._type}:${step.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            steps.push(step);
          }
        }
      }
    }
  }

  if (steps.length === 0) return undefined;

  return steps.map((s) => ({
    type: s._type,
    name: s.name,
    operations: s.operations ? [...s.operations] : undefined,
  }));
}
