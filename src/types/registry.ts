/**
 * Registry & Metadata Types — what `ResourceRegistry` produces and what
 * the introspection plugin exposes.
 */

import type { PermissionCheck } from "../permissions/types.js";
import "./base.js";
import type {
  OpenApiSchemas,
  RateLimitConfig,
  ResolvedTenantPurge,
  ResourcePermissions,
} from "./resource.js";

export interface ResourceMetadata {
  name: string;
  displayName?: string;
  tag?: string;
  prefix: string;
  module?: string;
  permissions?: ResourcePermissions;
  presets: string[];
  customRoutes?: Array<{
    method: string;
    path: string;
    handler: string;
    operation?: string;
    summary?: string;
    description?: string;
    permissions?: PermissionCheck;
    raw?: boolean;
    schema?: unknown;
  }>;
  routes: Array<{
    method: string;
    path: string;
    handler?: string;
    operation?: string;
    summary?: string;
  }>;
  events?: string[];
}

export interface RegistryEntry extends ResourceMetadata {
  plugin: unknown;
  adapter?: { type: string; name: string } | null;
  events?: string[];
  disableDefaultRoutes?: boolean;
  /**
   * 2.15.5 — multi-tenant scoping field declared on the resource
   * (defaults to `'organizationId'`; `false` for company-wide tables).
   * Surfaced so introspection / cascade helpers can scope deletes
   * without re-reading the resource definition.
   */
  tenantField?: string | false;
  /**
   * Resolved tenant-purge strategy — what arc actually runs when
   * `cascadeDeleteForOrganization` fires for this resource. Computed
   * at boot from the resource's `onTenantDelete` declaration. Surfaced
   * here so introspection / audit scripts can answer "what happens on
   * org-delete?" without re-reading the resource definition.
   */
  resolvedTenantPurge?: ResolvedTenantPurge;
  openApiSchemas?: OpenApiSchemas;
  registeredAt?: string;
  /** Field-level permissions metadata (for OpenAPI data) */
  fieldPermissions?: Record<
    string,
    { type: string; roles?: readonly string[]; redactValue?: unknown }
  >;
  /** Pipeline step names (for OpenAPI data) */
  pipelineSteps?: Array<{ type: string; name: string; operations?: string[] }>;
  /** Update HTTP method(s) used for this resource */
  updateMethod?: "PUT" | "PATCH" | "both";
  /** Routes disabled for this resource */
  disabledRoutes?: string[];
  /** Rate limit config */
  rateLimit?: RateLimitConfig | false;
  /** Per-resource audit opt-in flag (read by `auditPlugin` perResource mode) */
  audit?: boolean | { operations?: ("create" | "update" | "delete")[] };
  /**
   * v2.8 declarative actions metadata — populated from
   * `ResourceConfig.actions`. Consumed by OpenAPI generation (renders
   * `POST /:id/action` with a discriminated body schema) and MCP tool
   * generation. Added in 2.8.1.
   */
  actions?: Array<{
    readonly name: string;
    readonly description?: string;
    /** Raw per-action schema (JSON Schema, Zod v4, or legacy field map) */
    readonly schema?: unknown;
    /** Per-action permission check (if different from resource-level `actionPermissions`) */
    readonly permissions?: PermissionCheck;
    /**
     * 2.15.5: mount point — `true` (default) for `POST /:id/action`,
     * `false` for `POST /action` (resource-root, no `:id` path param).
     * Consumed by registry enumeration, OpenAPI generation, and FE
     * resource manifests so callers can pick the right URL without
     * reading the action definition itself.
     */
    readonly id?: boolean;
    /** MCP tool generation flag — `false` to skip, object for overrides */
    readonly mcp?:
      | boolean
      | {
          readonly description?: string;
          readonly annotations?: Record<string, unknown>;
        };
  }>;
  /**
   * Resource-level fallback permission for actions without per-action
   * permissions. Used by OpenAPI to determine auth requirements and by
   * MCP as the fallback in `createActionToolHandler`. Added in 2.8.1.
   */
  actionPermissions?: PermissionCheck;
  /**
   * Aggregation route metadata (v2.13). Mirrors the runtime config in
   * a doc-friendly shape so OpenAPI emission and MCP tool generation
   * read from one source.
   *
   * Each entry corresponds to a `GET /:resource/aggregations/:name`
   * route. Response shape (rows array of objects keyed by groupBy +
   * measure aliases) is derived at OpenAPI emission time from
   * `groupBy` + `measures` + `lookups`.
   */
  aggregations?: Array<{
    readonly name: string;
    readonly summary?: string;
    readonly description?: string;
    readonly permissions: PermissionCheck;
    readonly groupBy?: string | readonly string[];
    /** Measure aliases keyed to their op-tag (e.g. `'count'`, `'sum:price'`). */
    readonly measures: Readonly<Record<string, string>>;
    /** Lookup alias names (`as` or `from`) — used by OpenAPI to know which dotted-path output keys nest. */
    readonly lookupAliases: readonly string[];
    /** Whether the aggregation requires a date range — surfaced in docs. */
    readonly requireDateRange?: { field: string; maxRangeDays?: number };
    /** Whether the aggregation requires named filters — surfaced in docs. */
    readonly requireFilters?: readonly string[];
    /**
     * Static result-row cap (no URL override). Mutually exclusive with
     * `defaultLimit` / `maxLimit`. Surfaced so OpenAPI docs can mention
     * the fixed cap in the description.
     */
    readonly limit?: number;
    /**
     * URL-driven default limit (caller may pass `?limit=N`). When set,
     * OpenAPI docs render `?limit` as a query parameter with this
     * default and `maxLimit` as the maximum.
     */
    readonly defaultLimit?: number;
    /**
     * URL-driven limit ceiling (only meaningful with `defaultLimit`).
     * OpenAPI docs render this as the `maximum` constraint on `?limit`.
     */
    readonly maxLimit?: number;
    /** MCP tool generation flag — `false` to skip, object for overrides. */
    readonly mcp?:
      | boolean
      | {
          readonly description?: string;
          readonly annotations?: Record<string, unknown>;
        };
  }>;
}

export interface RegistryStats {
  total?: number;
  totalResources: number;
  byTag?: Record<string, number>;
  byModule?: Record<string, number>;
  presetUsage?: Record<string, number>;
  totalRoutes?: number;
  totalEvents?: number;
}

export interface IntrospectionData {
  resources: ResourceMetadata[];
  stats: RegistryStats;
  generatedAt?: string;
}
