/**
 * Arc Architecture Schema (AAS) — Dynamic Resource Loader
 *
 * JSON-serializable definition framework for AI agents to procedurally
 * generate complete REST API backends without writing imperative code.
 *
 * @example
 * ```typescript
 * const loader = new ArcDynamicLoader({
 *   adapterResolver: (name) => createMongooseAdapter({ model: models[name], repository: repos[name] }),
 * });
 *
 * const resources = loader.load({
 *   app: "my-saas",
 *   resources: [
 *     {
 *       name: "product",
 *       permissions: "publicRead",
 *       presets: ["softDelete"],
 *       fields: {
 *         name: { type: "string", required: true, description: "Product name" },
 *         price: { type: "number", required: true, min: 0 },
 *         category: { type: "string", enum: ["electronics", "books", "clothing"] },
 *       },
 *       filterable: ["category"],
 *       sortable: ["name", "price", "createdAt"],
 *     },
 *   ],
 * });
 *
 * // Each resource has schemaOptions, queryParser, and is MCP-ready
 * for (const r of resources) await app.register(r.toPlugin());
 * ```
 */

import type { DataAdapter } from "../adapters/interface.js";
import { defineResource } from "../core/defineResource.js";
import {
  adminOnly,
  authenticated,
  fullPublic,
  ownerWithAdminBypass,
  publicRead,
  publicReadAdminWrite,
  readOnly,
} from "../permissions/index.js";
import type { PermissionCheck } from "../permissions/types.js";
import type { CrudRouteKey, ResourcePermissions } from "../types/index.js";
import { ArcQueryParser } from "../utils/queryParser.js";

// ============================================================================
// Schema Types (JSON-serializable)
// ============================================================================

export interface ArcArchitectureSchema {
  /** Application name */
  app: string;
  /** Resources to provision */
  resources: ArcResourceSchema[];
}

/** Field type — maps to JSON Schema / Zod types */
export type ArcFieldType = "string" | "number" | "boolean" | "date" | "object" | "array";

/** Per-field definition — matches Arc's FieldRuleEntry for MCP compatibility */
export interface ArcFieldSchema {
  type: ArcFieldType;
  required?: boolean;
  description?: string;
  enum?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** System-managed fields (createdAt, updatedAt) — excluded from create/update schemas */
  systemManaged?: boolean;
  /** Immutable after creation (e.g. slug, organizationId) */
  immutable?: boolean;
}

/** Permission preset name — matches Arc's built-in presets */
export type ArcPermissionPreset =
  | "publicRead"
  | "publicReadAdminWrite"
  | "authenticated"
  | "adminOnly"
  | "ownerWithAdminBypass"
  | "fullPublic"
  | "readOnly";

/** Fine-grained per-operation permission */
export interface ArcPermissionMap {
  list?: "public" | "auth" | "admin";
  get?: "public" | "auth" | "admin";
  create?: "auth" | "admin";
  update?: "auth" | "admin" | "owner";
  delete?: "auth" | "admin" | "owner";
}

export interface ArcResourceSchema {
  /** Resource name (e.g., 'product', 'user') — used for URL prefix and tool names */
  name: string;
  /** Display name for docs and MCP descriptions (defaults to capitalized name) */
  displayName?: string;
  /** Custom URL prefix (defaults to `/${name}s`) */
  prefix?: string;
  /** Adapter resolution key — passed to adapterResolver */
  adapterPattern?: string;
  /** Permission preset name or fine-grained per-operation map */
  permissions: ArcPermissionPreset | ArcPermissionMap;
  /** Presets to apply (e.g., 'softDelete', 'slugLookup', 'bulk') */
  presets?: string[];
  /** Field definitions — drives schemaOptions.fieldRules for validation and MCP tool schemas */
  fields?: Record<string, ArcFieldSchema | ArcFieldType>;
  /** Fields allowed for filtering in list operations (drives queryParser + MCP) */
  filterable?: string[];
  /** Fields allowed for sorting (drives queryParser + MCP) */
  sortable?: string[];
  /** CRUD operations to disable (e.g., ['delete'] for append-only resources) */
  disabledRoutes?: string[];
  /** Tenant field name for multi-tenant resources */
  tenantField?: string;
}

// ============================================================================
// Loader Context
// ============================================================================

export interface DynamicLoaderContext {
  /** Resolve a data adapter for a resource — receives name and optional pattern key */
  adapterResolver: (resourceName: string, pattern?: string) => DataAdapter;
  /** Resolve custom permission checks beyond built-in presets */
  permissionResolver?: (policy: string) => PermissionCheck;
}

// ============================================================================
// Validation
// ============================================================================

const VALID_FIELD_TYPES = new Set<string>([
  "string",
  "number",
  "boolean",
  "date",
  "object",
  "array",
]);

function validateSchema(schema: ArcArchitectureSchema): void {
  if (!schema.app || typeof schema.app !== "string") {
    throw new Error("AAS: 'app' name is required");
  }
  if (!Array.isArray(schema.resources) || schema.resources.length === 0) {
    throw new Error("AAS: 'resources' must be a non-empty array");
  }
  for (const r of schema.resources) {
    if (!r.name || typeof r.name !== "string") {
      throw new Error("AAS: each resource must have a 'name' string");
    }
    if (!r.permissions) {
      throw new Error(`AAS: resource "${r.name}" must have 'permissions'`);
    }
    // Validate field types
    if (r.fields) {
      for (const [fieldName, fieldDef] of Object.entries(r.fields)) {
        const type = typeof fieldDef === "string" ? fieldDef : fieldDef.type;
        if (!VALID_FIELD_TYPES.has(type)) {
          throw new Error(
            `AAS: resource "${r.name}" field "${fieldName}" has invalid type "${type}". ` +
              `Valid types: ${[...VALID_FIELD_TYPES].join(", ")}`,
          );
        }
      }
    }
  }
}

// ============================================================================
// ArcDynamicLoader
// ============================================================================

/**
 * Load an Arc Architecture Schema (JSON) and produce fully configured ResourceDefinitions.
 *
 * Each resource gets:
 * - Adapter from the resolver
 * - Permissions from presets or fine-grained map
 * - schemaOptions.fieldRules for validation and MCP tool schemas
 * - ArcQueryParser with allowedFilterFields/allowedSortFields for MCP auto-derive
 * - Presets applied
 */
export class ArcDynamicLoader {
  private context: DynamicLoaderContext;

  constructor(context: DynamicLoaderContext) {
    this.context = context;
  }

  /**
   * Load an AAS definition and return fully constructed ResourceDefinitions.
   * Validates the schema before processing — throws on malformed input.
   */
  load(schema: ArcArchitectureSchema) {
    validateSchema(schema);

    return schema.resources.map((r) => {
      const adapter = this.context.adapterResolver(r.name, r.adapterPattern);
      const fieldRules = this.buildFieldRules(r.fields);
      const queryParser = this.buildQueryParser(r);

      return defineResource({
        name: r.name,
        displayName: r.displayName,
        prefix: r.prefix,
        adapter,
        queryParser,
        presets: r.presets,
        permissions: this.resolvePermissions(r.permissions) as ResourcePermissions,
        disabledRoutes: r.disabledRoutes as CrudRouteKey[] | undefined,
        tenantField: r.tenantField,
        schemaOptions: fieldRules
          ? ({
              fieldRules,
              filterableFields: r.filterable,
            } as Record<string, unknown>)
          : undefined,
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Field Rules
  // ──────────────────────────────────────────────────────────────────────────

  private buildFieldRules(
    fields?: Record<string, ArcFieldSchema | ArcFieldType>,
  ): Record<string, ArcFieldSchema> | undefined {
    if (!fields) return undefined;

    const rules: Record<string, ArcFieldSchema> = {};
    for (const [name, def] of Object.entries(fields)) {
      rules[name] = typeof def === "string" ? { type: def } : def;
    }
    return rules;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Query Parser
  // ──────────────────────────────────────────────────────────────────────────

  private buildQueryParser(r: ArcResourceSchema): ArcQueryParser | undefined {
    if (!r.filterable && !r.sortable) return undefined;

    return new ArcQueryParser({
      allowedFilterFields: r.filterable,
      allowedSortFields: r.sortable,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Permissions
  // ──────────────────────────────────────────────────────────────────────────

  private resolvePermissions(policy: ArcResourceSchema["permissions"]) {
    if (typeof policy === "string") {
      return this.resolvePreset(policy);
    }
    return this.resolveFinGrained(policy);
  }

  private resolvePreset(preset: ArcPermissionPreset) {
    switch (preset) {
      case "publicRead":
        return publicRead();
      case "publicReadAdminWrite":
        return publicReadAdminWrite();
      case "authenticated":
        return authenticated();
      case "adminOnly":
        return adminOnly();
      case "ownerWithAdminBypass":
        return ownerWithAdminBypass();
      case "fullPublic":
        return fullPublic();
      case "readOnly":
        return readOnly();
      default:
        // Custom preset via resolver
        if (this.context.permissionResolver) {
          const resolved = this.context.permissionResolver(preset);
          if (resolved) return resolved;
        }
        throw new Error(`Unknown permission preset: "${preset}"`);
    }
  }

  private resolveFinGrained(policy: ArcPermissionMap) {
    const pick = (preset: Record<string, PermissionCheck>, op: string): PermissionCheck =>
      preset[op] ?? authenticated()[op as keyof ReturnType<typeof authenticated>]!;

    const map: Record<string, (op: string) => PermissionCheck> = {
      public: (op) => pick(publicRead() as Record<string, PermissionCheck>, op),
      auth: (op) => pick(authenticated() as Record<string, PermissionCheck>, op),
      admin: (op) => pick(adminOnly() as Record<string, PermissionCheck>, op),
      owner: (op) => pick(ownerWithAdminBypass() as Record<string, PermissionCheck>, op),
    };

    const permissions: Record<string, PermissionCheck> = {};
    const ops = {
      list: policy.list,
      get: policy.get,
      create: policy.create,
      update: policy.update,
      delete: policy.delete,
    };

    for (const [op, level] of Object.entries(ops)) {
      if (level && map[level]) {
        permissions[op] = map[level](op);
      }
    }

    return permissions;
  }
}
