/**
 * MCP tool input schema generation.
 *
 * One of four internal units extracted from `resourceToTools.ts` in
 * v2.11.0. Owns the translation from arc's fieldRules / adapter-generated
 * body schemas into the Zod shapes MCP tools expect.
 *
 * Exports:
 * - `buildInputSchema` — the switch on CRUD op that picks between the
 *   fieldRules path and the high-fidelity adapter-body path.
 * - `getAdapterBodies` — pulls `createBody` / `updateBody` from the
 *   adapter once so callers can reuse them for both paths.
 * - `deriveFieldRulesFromAdapter` — fallback FieldRules derivation for
 *   the list/filter path when the host didn't supply explicit rules.
 */

import { z } from "zod";
import type { ResourceDefinition } from "../../core/defineResource.js";
import { type FieldRuleEntry, fieldRulesToZod } from "./fieldRulesToZod.js";
import { jsonSchemaToZodShape } from "./jsonSchemaToZod.js";
import type { CrudOperation } from "./types.js";

export interface AdapterBodies {
  createBody?: Record<string, unknown>;
  updateBody?: Record<string, unknown>;
}

export function buildInputSchema(
  op: CrudOperation,
  fieldRules: Record<string, FieldRuleEntry> | undefined,
  opts: {
    hiddenFields?: string[];
    readonlyFields?: string[];
    extraHideFields?: string[];
    filterableFields?: readonly string[];
    allowedOperators?: readonly string[];
    /**
     * Raw JSON Schema body shapes from the adapter, used as a high-fidelity
     * source for create/update tool input schemas when no explicit fieldRules
     * are present. Bypassing the flat FieldRuleEntry intermediate layer
     * preserves nested objects, arrays, refs, and composition.
     */
    adapterBodies?: AdapterBodies;
  },
): Record<string, z.ZodTypeAny> {
  switch (op) {
    case "list":
      return fieldRulesToZod(fieldRules, { mode: "list", ...opts });
    case "get":
      return getIdShape();
    case "create": {
      if (!fieldRules && opts.adapterBodies?.createBody) {
        const shape = jsonSchemaToZodShape(
          opts.adapterBodies.createBody as Parameters<typeof jsonSchemaToZodShape>[0],
          "create",
        );
        if (shape) return shape;
      }
      return fieldRulesToZod(fieldRules, { mode: "create", ...opts });
    }
    case "update": {
      const idShape = getIdShape();
      if (!fieldRules && opts.adapterBodies?.updateBody) {
        const shape = jsonSchemaToZodShape(
          opts.adapterBodies.updateBody as Parameters<typeof jsonSchemaToZodShape>[0],
          "update",
        );
        if (shape) return { ...idShape, ...shape };
      }
      return {
        ...idShape,
        ...fieldRulesToZod(fieldRules, { mode: "update", ...opts }),
      };
    }
    case "delete":
      return getIdShape();
  }
}

function getIdShape(): Record<string, z.ZodTypeAny> {
  return { id: z.string().describe("Resource ID") };
}

/**
 * Pull the adapter's `createBody` / `updateBody` schemas, if any.
 * Returns `undefined` when the adapter doesn't generate schemas or throws.
 */
export function getAdapterBodies(resource: ResourceDefinition): AdapterBodies | undefined {
  const adapter = resource.adapter;
  if (!adapter || typeof adapter.generateSchemas !== "function") return undefined;
  try {
    const generated = adapter.generateSchemas(resource.schemaOptions, {
      idField: resource.idField,
      resourceName: resource.name,
    });
    if (!generated || typeof generated !== "object") return undefined;
    const schemas = generated as Record<string, unknown>;
    return {
      createBody: schemas.createBody as Record<string, unknown> | undefined,
      updateBody: schemas.updateBody as Record<string, unknown> | undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Derive a fieldRules-shaped object from the adapter's auto-generated body
 * schemas. Used as a fallback when the resource doesn't supply explicit
 * fieldRules — this lets MCP create/update tools accept the same body fields
 * that the REST routes already accept.
 *
 * Returns `undefined` if no usable schema can be extracted, in which case
 * `fieldRulesToZod` falls back to its own behavior (empty shape).
 */
export function deriveFieldRulesFromAdapter(
  resource: ResourceDefinition,
): Record<string, FieldRuleEntry> | undefined {
  const adapter = resource.adapter;
  if (!adapter || typeof adapter.generateSchemas !== "function") return undefined;

  let generated: unknown;
  try {
    generated = adapter.generateSchemas(resource.schemaOptions, {
      idField: resource.idField,
      resourceName: resource.name,
    });
  } catch {
    return undefined;
  }
  if (!generated || typeof generated !== "object") return undefined;

  const schemas = generated as Record<string, unknown>;
  // Prefer createBody (it has required fields), fall back to updateBody.
  const createBody = schemas.createBody as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  const updateBody = schemas.updateBody as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;

  const properties = createBody?.properties ?? updateBody?.properties;
  if (!properties || typeof properties !== "object") return undefined;

  const requiredSet = new Set<string>(createBody?.required ?? []);
  const rules: Record<string, FieldRuleEntry> = {};

  for (const [name, propSchema] of Object.entries(properties)) {
    if (!propSchema || typeof propSchema !== "object") continue;
    const prop = propSchema as Record<string, unknown>;
    const rawType = prop.type;
    // JSON Schema "type" can be a string or an array (e.g. ["string","null"]).
    const candidateTypes: string[] = Array.isArray(rawType)
      ? rawType.filter((t): t is string => typeof t === "string")
      : typeof rawType === "string"
        ? [rawType]
        : [];
    const arcType = mapJsonSchemaTypeToArcType(candidateTypes[0]);

    const rule: FieldRuleEntry = { type: arcType };
    if (requiredSet.has(name)) rule.required = true;
    if (typeof prop.description === "string") rule.description = prop.description;
    if (Array.isArray(prop.enum)) rule.enum = prop.enum.filter((v) => typeof v === "string");
    if (typeof prop.minLength === "number") rule.minLength = prop.minLength;
    if (typeof prop.maxLength === "number") rule.maxLength = prop.maxLength;
    if (typeof prop.minimum === "number") rule.min = prop.minimum;
    if (typeof prop.maximum === "number") rule.max = prop.maximum;
    if (typeof prop.pattern === "string") rule.pattern = prop.pattern;

    rules[name] = rule;
  }

  return Object.keys(rules).length > 0 ? rules : undefined;
}

function mapJsonSchemaTypeToArcType(jsonType: string | undefined): string {
  switch (jsonType) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return "string";
  }
}
