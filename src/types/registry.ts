/**
 * Registry & Metadata Types — what `ResourceRegistry` produces and what
 * the introspection plugin exposes.
 */

import type { PermissionCheck } from "../permissions/types.js";
import "./base.js";
import type { OpenApiSchemas, RateLimitConfig, ResourcePermissions } from "./resource.js";

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
    schema?: Record<string, unknown>;
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
  openApiSchemas?: OpenApiSchemas;
  registeredAt?: string;
  /** Field-level permissions metadata (for OpenAPI docs) */
  fieldPermissions?: Record<
    string,
    { type: string; roles?: readonly string[]; redactValue?: unknown }
  >;
  /** Pipeline step names (for OpenAPI docs) */
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
    readonly schema?: Record<string, unknown>;
    /** Per-action permission check (if different from resource-level `actionPermissions`) */
    readonly permissions?: PermissionCheck;
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
