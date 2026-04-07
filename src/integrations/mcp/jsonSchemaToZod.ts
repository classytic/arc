/**
 * @classytic/arc — JSON Schema → Zod shape converter
 *
 * Converts an adapter-emitted JSON Schema body shape (`createBody` / `updateBody`)
 * to a flat Zod shape compatible with the MCP SDK's `registerTool({ inputSchema })`
 * contract.
 *
 * Why this exists:
 *   - The MCP SDK expects a flat `Record<string, ZodType>` shape (it wraps it in
 *     z.object() internally).
 *   - When users don't supply explicit `schemaOptions.fieldRules`, MCP would
 *     otherwise see an empty schema and silently strip every body field — that's
 *     a real DX footgun.
 *   - Adapters (Mongoose, MongoKit's buildCrudSchemasFromModel, custom) already
 *     emit JSON Schema describing the body. We translate it to Zod so MCP tools
 *     can validate input the same way REST routes do.
 *
 * Supported JSON Schema features:
 *   - Primitives: string, number, integer, boolean, null (skipped)
 *   - Constraints: minLength, maxLength, minimum, maximum, pattern, enum, format
 *   - Arrays: typed items + nested object items
 *   - Nested objects with `properties` (recursive)
 *   - Type unions: ["string", "null"] → string (null skipped)
 *   - Composition: oneOf / anyOf / allOf → first viable branch
 *   - $ref → permissive (z.unknown()) — refs are not resolved
 *   - Unknown types → z.unknown() (lenient — let the controller validate)
 *
 * NOT supported (intentionally — keeps the surface small + deterministic):
 *   - Conditional schemas (if/then/else)
 *   - dependencies / dependentRequired
 *   - Custom keywords beyond standard JSON Schema
 */

import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: readonly string[];
  items?: unknown;
  enum?: readonly unknown[];
  format?: string;
  pattern?: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  oneOf?: readonly unknown[];
  anyOf?: readonly unknown[];
  allOf?: readonly unknown[];
  $ref?: string;
  default?: unknown;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Convert a JSON Schema **object** body to a flat Zod shape.
 * Returns `undefined` if the input has no usable properties.
 *
 * @param schema  Top-level JSON Schema (must be `type: 'object'` with `properties`)
 * @param mode    'create' enforces required fields, 'update' makes everything optional
 */
export function jsonSchemaToZodShape(
  schema: JsonSchema | undefined,
  mode: "create" | "update" = "create",
): Record<string, z.ZodTypeAny> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  if (!schema.properties || typeof schema.properties !== "object") return undefined;

  const requiredSet = new Set<string>(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, propSchema] of Object.entries(schema.properties)) {
    if (!propSchema || typeof propSchema !== "object") continue;
    const prop = propSchema as JsonSchema;
    const fieldZod = jsonSchemaPropertyToZod(prop);
    if (!fieldZod) continue;

    // In update mode, every field is optional. In create mode, only fields
    // listed in `required` are mandatory.
    const isRequired = mode === "create" && requiredSet.has(name);
    shape[name] = isRequired ? fieldZod : fieldZod.optional();
  }

  return Object.keys(shape).length > 0 ? shape : undefined;
}

// ============================================================================
// Internal — single-property converter (recursive)
// ============================================================================

/**
 * Convert one JSON Schema node to a Zod type.
 * Handles primitives, arrays, nested objects, type unions, and composition.
 */
function jsonSchemaPropertyToZod(prop: JsonSchema): z.ZodTypeAny | null {
  // $ref → permissive (we don't resolve external refs in this converter)
  if (prop.$ref) {
    return applyDescription(z.unknown(), prop);
  }

  // Composition keywords — pick the first viable branch
  if (Array.isArray(prop.oneOf) && prop.oneOf.length > 0) {
    for (const branch of prop.oneOf) {
      const z1 = jsonSchemaPropertyToZod(branch as JsonSchema);
      if (z1) return applyDescription(z1, prop);
    }
  }
  if (Array.isArray(prop.anyOf) && prop.anyOf.length > 0) {
    for (const branch of prop.anyOf) {
      const z1 = jsonSchemaPropertyToZod(branch as JsonSchema);
      if (z1) return applyDescription(z1, prop);
    }
  }
  if (Array.isArray(prop.allOf) && prop.allOf.length > 0) {
    // For allOf, pick the most specific (last) branch that converts.
    // True intersection of Zod types is heavy; the last branch usually carries
    // the structural shape while earlier branches add constraints.
    for (let i = prop.allOf.length - 1; i >= 0; i--) {
      const branch = prop.allOf[i];
      const z1 = jsonSchemaPropertyToZod(branch as JsonSchema);
      if (z1) return applyDescription(z1, prop);
    }
  }

  // Enum — pick the first variant; Zod requires non-empty
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const stringValues = prop.enum.filter((v): v is string => typeof v === "string");
    if (stringValues.length > 0) {
      const enumSchema = z.enum(stringValues as [string, ...string[]]);
      return applyDescription(enumSchema, prop);
    }
    // Numeric enum → number (Zod has no numeric enum type at the shape level)
    return applyDescription(z.number(), prop);
  }

  // Resolve `type` — handles both string and array forms; "null" is skipped
  // and treated as "field is nullable but emits its non-null variant".
  const typeCandidates = pickEffectiveType(prop.type);

  for (const t of typeCandidates) {
    switch (t) {
      case "string":
        return applyStringConstraints(z.string(), prop);
      case "number":
      case "integer":
        return applyNumberConstraints(z.number(), prop);
      case "boolean":
        return applyDescription(z.boolean(), prop);
      case "array":
        return applyDescription(arrayToZod(prop), prop);
      case "object":
        return applyDescription(objectToZod(prop), prop);
      case "null":
        // skip — handled by union processing above
        continue;
      default:
        // Unknown — fall through
        break;
    }
  }

  // No usable type info — accept anything (controller / DB validates)
  return applyDescription(z.unknown(), prop);
}

function pickEffectiveType(rawType: string | string[] | undefined): string[] {
  if (!rawType) return [];
  if (Array.isArray(rawType)) {
    // Filter "null" out and keep order; if only "null" remains, return empty.
    return rawType.filter((t) => t !== "null");
  }
  return rawType === "null" ? [] : [rawType];
}

function arrayToZod(prop: JsonSchema): z.ZodTypeAny {
  const items = prop.items;
  if (items && typeof items === "object") {
    const itemZod = jsonSchemaPropertyToZod(items as JsonSchema);
    if (itemZod) return z.array(itemZod);
  }
  // Untyped or mixed array — accept anything
  return z.array(z.unknown());
}

function objectToZod(prop: JsonSchema): z.ZodTypeAny {
  // If the object declares a properties bag, recurse to build a typed object.
  if (prop.properties && typeof prop.properties === "object") {
    const requiredSet = new Set<string>(prop.required ?? []);
    const innerShape: Record<string, z.ZodTypeAny> = {};
    for (const [k, v] of Object.entries(prop.properties)) {
      if (!v || typeof v !== "object") continue;
      const inner = jsonSchemaPropertyToZod(v as JsonSchema);
      if (!inner) continue;
      innerShape[k] = requiredSet.has(k) ? inner : inner.optional();
    }
    if (Object.keys(innerShape).length > 0) {
      return z.object(innerShape);
    }
  }
  // No declared properties — accept any object
  return z.record(z.string(), z.unknown());
}

function applyStringConstraints(base: z.ZodString, prop: JsonSchema): z.ZodTypeAny {
  let s = base;
  if (typeof prop.minLength === "number") s = s.min(prop.minLength);
  if (typeof prop.maxLength === "number") s = s.max(prop.maxLength);
  if (typeof prop.pattern === "string") {
    try {
      s = s.regex(new RegExp(prop.pattern));
    } catch {
      // invalid regex → ignore the constraint
    }
  }
  // JSON Schema `format` hints — only apply where Zod has a built-in
  if (prop.format === "email") s = s.email();
  if (prop.format === "uuid") s = s.uuid();
  if (prop.format === "uri" || prop.format === "url") s = s.url();
  return applyDescription(s, prop);
}

function applyNumberConstraints(base: z.ZodNumber, prop: JsonSchema): z.ZodTypeAny {
  let n = base;
  if (typeof prop.minimum === "number") n = n.min(prop.minimum);
  if (typeof prop.maximum === "number") n = n.max(prop.maximum);
  return applyDescription(n, prop);
}

function applyDescription<T extends z.ZodTypeAny>(zodType: T, prop: JsonSchema): z.ZodTypeAny {
  if (typeof prop.description === "string" && prop.description.length > 0) {
    return zodType.describe(prop.description);
  }
  return zodType;
}
