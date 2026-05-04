/**
 * `components.schemas` generator.
 *
 * Two responsibilities:
 *   1. Spread the canonical wire schemas (`ErrorContract`,
 *      `ErrorDetail`, `DeleteResult`) so paths can `$ref` them.
 *   2. Build a `<Resource>` model schema + `<Resource>Input` /
 *      `<Resource>Update` request-body schemas per registered resource.
 *
 * The legacy `Error` schema (which carried `{ success, error, code,
 * requestId, timestamp }`) is GONE — arc 2.13 emits `ErrorContract`,
 * with no `success` discriminator and no top-level `error` string.
 * Hosts that depended on the legacy shape must migrate.
 */

import type { RegistryEntry } from "../../types/index.js";
import { CANONICAL_SCHEMAS } from "./canonical-schemas.js";
import { formatFieldPermDescription } from "./field-permissions.js";
import type { SchemaObject } from "./types.js";

/**
 * Generate component schema definitions from pre-stored registry
 * schemas.
 *
 * Schemas are generated at resource definition time and stored in the
 * registry. Response schema priority:
 *   1. If resource provides explicit `openApiSchemas.response`, use it
 *      as-is.
 *   2. Otherwise, auto-generate from `createBody` + `_id` + timestamps.
 *   3. Fallback to a placeholder doc with just `_id` + timestamps.
 *
 * Note: this emits OpenAPI documentation only — does NOT affect Fastify
 * serialization.
 */
export function generateSchemas(resources: RegistryEntry[]): Record<string, SchemaObject> {
  const schemas: Record<string, SchemaObject> = {
    // Canonical wire-shape schemas — referenced by every CRUD path.
    ...CANONICAL_SCHEMAS,
  };

  for (const resource of resources) {
    const storedSchemas = resource.openApiSchemas;
    const fieldPerms = resource.fieldPermissions;

    // === RESPONSE SCHEMA (for GET responses) ===
    // Priority 1: Explicit response schema provided by user
    if (storedSchemas?.response) {
      schemas[resource.name] = {
        type: "object",
        description: resource.displayName,
        ...(storedSchemas.response as SchemaObject),
      };
    }
    // Priority 2: Auto-generate from createBody
    else if (storedSchemas?.createBody) {
      schemas[resource.name] = {
        type: "object",
        description: resource.displayName,
        properties: {
          _id: { type: "string", description: "Unique identifier" },
          ...((storedSchemas.createBody as SchemaObject).properties ?? {}),
          createdAt: { type: "string", format: "date-time", description: "Creation timestamp" },
          updatedAt: { type: "string", format: "date-time", description: "Last update timestamp" },
        },
      };
    }
    // Fallback: Placeholder schema
    else {
      schemas[resource.name] = {
        type: "object",
        description: resource.displayName,
        properties: {
          _id: { type: "string", description: "Unique identifier" },
          createdAt: { type: "string", format: "date-time", description: "Creation timestamp" },
          updatedAt: { type: "string", format: "date-time", description: "Last update timestamp" },
        },
      };
    }

    // Annotate fields with permission info
    const resourceSchema = schemas[resource.name];
    if (fieldPerms && resourceSchema?.properties) {
      const props = resourceSchema.properties;
      for (const [field, perm] of Object.entries(fieldPerms)) {
        const propSchema = props[field];
        if (propSchema) {
          // Add permission description to existing field
          const desc = propSchema.description ?? "";
          const permDesc = formatFieldPermDescription(perm);
          propSchema.description = desc ? `${desc} (${permDesc})` : permDesc;
        } else if (perm.type === "hidden") {
          // Hidden fields won't appear in schema — note in schema description
        }
      }
    }

    // === INPUT SCHEMAS (for POST/PATCH requests) ===
    if (storedSchemas?.createBody) {
      schemas[`${resource.name}Input`] = {
        type: "object",
        description: `${resource.displayName} create input`,
        ...(storedSchemas.createBody as SchemaObject),
      };

      if (storedSchemas.updateBody) {
        schemas[`${resource.name}Update`] = {
          type: "object",
          description: `${resource.displayName} update input`,
          ...(storedSchemas.updateBody as SchemaObject),
        };
      }
    } else {
      schemas[`${resource.name}Input`] = {
        type: "object",
        description: `${resource.displayName} input`,
      };
    }
  }

  return schemas;
}
