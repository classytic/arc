/**
 * Resource Registry
 *
 * Singleton that tracks all registered resources for introspection.
 */

import { DEFAULT_UPDATE_METHOD } from "../constants.js";
import type { AggMeasureInput } from "../core/aggregation/types.js";
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

/**
 * One enumerated wire route. Matches `ResourceMetadata.routes[]`'s shape so
 * it slots straight into `IntrospectionData` without re-mapping.
 */
export interface RouteRow {
  method: string;
  path: string;
  operation?: string;
  handler?: string;
  summary?: string;
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
      customRoutes: (resource.routes ?? []).map((r) => ({
        method: r.method,
        path: r.path,
        handler:
          typeof r.handler === "string" ? r.handler : (r.handler as Function).name || "anonymous",
        operation: r.operation,
        summary: r.summary,
        description: r.description,
        permissions: r.permissions,
        raw: r.raw,
        schema: r.schema,
      })),
      events: Object.keys(resource.events ?? {}),
      registeredAt: new Date().toISOString(),
      disableDefaultRoutes: resource.disableDefaultRoutes,
      updateMethod: resource.updateMethod,
      disabledRoutes: resource.disabledRoutes ? [...resource.disabledRoutes] : undefined,
      openApiSchemas: options.openApiSchemas,
      fieldPermissions: extractFieldPermissions(resource.fields),
      pipelineSteps: extractPipelineSteps(resource.pipe),
      rateLimit: resource.rateLimit,
      audit: resource.audit,
      // v2.8.1 — expose actions metadata + fallback permission for OpenAPI/MCP/introspection
      actionPermissions: resource.actionPermissions,
      actions: resource.actions
        ? Object.entries(resource.actions).map(([name, entry]) => {
            if (typeof entry === "function") {
              return { name };
            }
            return {
              name,
              description: entry.description,
              schema: entry.schema as Record<string, unknown> | undefined,
              permissions: entry.permissions,
              mcp: entry.mcp,
            };
          })
        : undefined,
      // v2.13 — aggregation metadata for OpenAPI + MCP. Measures are
      // serialized to their op-tag form (`'count'` / `'sum:price'`)
      // so the doc layer doesn't have to re-implement IR walking.
      aggregations: resource.aggregations
        ? Object.entries(resource.aggregations).map(([name, entry]) => ({
            name,
            summary: entry.summary,
            description: entry.description,
            permissions: entry.permissions,
            groupBy: entry.groupBy,
            measures: stringifyMeasureMap(entry.measures),
            lookupAliases: (entry.lookups ?? []).map((l) => l.as ?? l.from),
            requireDateRange: entry.requireDateRange,
            requireFilters: entry.requireFilters,
            mcp: entry.mcp,
          }))
        : undefined,
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
   *
   * `totalRoutes` is derived from `enumerateRoutes()` — single source of
   * truth shared with `getIntrospection()` and consistent with what
   * OpenAPI / Fastify actually mount. New route sources (e.g. v2.13
   * aggregations) light up here automatically.
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
      totalRoutes: resources.reduce((sum, r) => sum + this.enumerateRoutes(r).length, 0),
      totalEvents: resources.reduce((sum, r) => sum + (r.events?.length ?? 0), 0),
    };
  }

  /**
   * Get full introspection data
   *
   * Routes come from `enumerateRoutes()` so consumers see the complete
   * surface — CRUD + custom + actions + aggregations — and match what
   * `getStats()` counts.
   */
  getIntrospection(): IntrospectionData {
    return {
      resources: this.getAll().map((r) => ({
        name: r.name,
        displayName: r.displayName,
        prefix: r.prefix,
        module: r.module,
        presets: r.presets,
        permissions: r.permissions,
        routes: this.enumerateRoutes(r),
        events: r.events,
      })),
      stats: this.getStats(),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Single source of truth for "what routes does this resource expose?".
   *
   * Enumerates every wire route the resource will mount on Fastify:
   *   - default CRUD (respecting `disabledRoutes` + `updateMethod`)
   *   - host-declared `customRoutes` (alias: `routes`)
   *   - the unified `POST /:id/action` endpoint when `actions` is set
   *   - one `GET /:resource/aggregations/:name` per declared aggregation
   *
   * Both `getStats()` and `getIntrospection()` consume this list, so a
   * new route source (e.g. future webhook routes) only has to be added
   * here — the count and the introspection contract update together.
   * Mirrors the same set of paths emitted by `docs/openapi.ts`.
   */
  enumerateRoutes(r: RegistryEntry): RouteRow[] {
    const routes: RouteRow[] = [];

    if (!r.disableDefaultRoutes) {
      const disabled = new Set(r.disabledRoutes ?? []);
      const updateMethod = r.updateMethod ?? DEFAULT_UPDATE_METHOD;
      if (!disabled.has("list")) routes.push({ method: "GET", path: r.prefix, operation: "list" });
      if (!disabled.has("get"))
        routes.push({ method: "GET", path: `${r.prefix}/:id`, operation: "get" });
      if (!disabled.has("create"))
        routes.push({ method: "POST", path: r.prefix, operation: "create" });
      if (!disabled.has("update")) {
        if (updateMethod === "both") {
          routes.push({ method: "PUT", path: `${r.prefix}/:id`, operation: "update" });
          routes.push({ method: "PATCH", path: `${r.prefix}/:id`, operation: "update" });
        } else {
          routes.push({ method: updateMethod, path: `${r.prefix}/:id`, operation: "update" });
        }
      }
      if (!disabled.has("delete"))
        routes.push({ method: "DELETE", path: `${r.prefix}/:id`, operation: "delete" });
    }

    for (const ar of r.customRoutes ?? []) {
      routes.push({
        method: ar.method,
        path: `${r.prefix}${ar.path}`,
        operation: ar.operation ?? (typeof ar.handler === "string" ? ar.handler : "custom"),
        handler: typeof ar.handler === "string" ? ar.handler : undefined,
        summary: ar.summary,
      });
    }

    if (r.actions && r.actions.length > 0) {
      routes.push({ method: "POST", path: `${r.prefix}/:id/action`, operation: "action" });
    }

    for (const agg of r.aggregations ?? []) {
      routes.push({
        method: "GET",
        path: `${r.prefix}/aggregations/${agg.name}`,
        operation: `aggregation:${agg.name}`,
        summary: agg.summary,
      });
    }

    return routes;
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

/**
 * Stringify a measure map for the registry. Object IR (`{ op: 'sum',
 * field: 'price' }`) collapses to its op-tag form (`'sum:price'`) so
 * the OpenAPI / MCP / describe layers can render docs without
 * re-implementing IR walking. Bare `count` (no field) stays `'count'`.
 *
 * Exported so the CLI describe command renders the same string form —
 * single source of truth for "how a measure looks to tooling".
 */
export function stringifyMeasureMap(
  measures: Record<string, AggMeasureInput>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [alias, m] of Object.entries(measures)) {
    if (typeof m === "string") {
      out[alias] = m;
      continue;
    }
    if (m.op === "count" && !("field" in m && m.field)) {
      out[alias] = "count";
      continue;
    }
    if ("field" in m && m.field) {
      out[alias] = `${m.op}:${m.field}`;
      continue;
    }
    // Defensive — shouldn't reach here for valid measures, but keep
    // the doc layer non-crashy.
    out[alias] = m.op;
  }
  return out;
}
