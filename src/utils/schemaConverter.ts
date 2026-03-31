/**
 * Schema Converter — Detect-First, Convert-Only-When-Needed
 *
 * Converts Zod v4 schemas to JSON Schema using Zod's native `z.toJSONSchema()`.
 * Plain JSON Schema objects pass through with zero overhead.
 *
 * Zod is an **optional** peer dependency — loaded lazily at module init.
 * If Zod is not installed, Zod schemas pass through unconverted with a warning.
 *
 * @example
 * ```typescript
 * import { toJsonSchema } from '@classytic/arc/utils';
 *
 * // Zod v4 schema → auto-converted via z.toJSONSchema()
 * const schema = toJsonSchema(z.object({ name: z.string() }));
 *
 * // Plain JSON Schema → passes through as-is
 * const same = toJsonSchema({ type: 'object', properties: { name: { type: 'string' } } });
 * ```
 */

import type { OpenApiSchemas } from "../types/index.js";

// ============================================================================
// Lazy Zod Import — loaded once at module init, only if installed
// ============================================================================

type ToJSONSchemaFn = (schema: unknown, opts?: unknown) => Record<string, unknown>;
let _toJSONSchema: ToJSONSchemaFn | null = null;

// Fire-and-forget: resolve Zod at module load (async but non-blocking).
// By the time any route handler calls toJsonSchema(), the promise will have settled.
// Safe for both ESM and CJS (no top-level await).
import("zod")
  .then(({ z }) => {
    if (typeof z?.toJSONSchema === "function") {
      _toJSONSchema = (schema, opts) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        z.toJSONSchema(schema as any, opts as any) as Record<string, unknown>;
    }
  })
  .catch(() => {
    // Zod not installed — schema conversion will pass through Zod objects as-is
  });

// ============================================================================
// Detection — O(1) checks
// ============================================================================

/**
 * Check if an object is already a plain JSON Schema.
 * Returns true if it has JSON Schema markers (`type`, `properties`, `$ref`,
 * `allOf`, `anyOf`, `oneOf`, `items`, `enum`) and does NOT have Zod markers.
 */
export function isJsonSchema(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object") return false;
  const obj = input as Record<string, unknown>;

  // Zod markers — if present, this is a Zod schema, not JSON Schema
  if ("_def" in obj || "_zod" in obj) return false;

  // JSON Schema markers
  return (
    "type" in obj ||
    "properties" in obj ||
    "$ref" in obj ||
    "allOf" in obj ||
    "anyOf" in obj ||
    "oneOf" in obj ||
    "items" in obj ||
    "enum" in obj
  );
}

/**
 * Check if an object is a Zod schema (has `_zod` marker from Zod v4).
 */
export function isZodSchema(input: unknown): boolean {
  return (
    input !== null && typeof input === "object" && "_zod" in (input as Record<string, unknown>)
  );
}

// ============================================================================
// Converter
// ============================================================================

/**
 * Convert any schema input to JSON Schema.
 *
 * Detection order:
 * 1. `null`/`undefined` → `undefined`
 * 2. Already JSON Schema → pass through as-is (zero overhead)
 * 3. Zod v4 schema → `z.toJSONSchema(schema, { target: 'openapi-3.0' })`
 * 4. Unrecognized object → return as-is (treat as opaque schema)
 */
export function toJsonSchema(input: unknown): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object") return undefined;

  // Fast path: already a plain JSON Schema → passthrough
  if (isJsonSchema(input)) return input as Record<string, unknown>;

  // Zod v4 schema → native conversion
  if (isZodSchema(input)) {
    if (!_toJSONSchema) {
      // Zod not installed but a Zod schema was passed — can't convert
      console.warn(
        "[Arc] Zod schema detected but zod is not installed. " + "Install zod v4: npm install zod",
      );
      return input as Record<string, unknown>;
    }
    try {
      return _toJSONSchema(input, { target: "openapi-3.0" });
    } catch {
      return { type: "object" };
    }
  }

  // Unrecognized — return as-is (don't break opaque schemas)
  return input as Record<string, unknown>;
}

// ============================================================================
// Batch Converters
// ============================================================================

/**
 * Convert all schema fields in an OpenApiSchemas object.
 * JSON Schema values pass through unchanged. Only Zod schemas are converted.
 */
export function convertOpenApiSchemas(schemas: OpenApiSchemas): OpenApiSchemas {
  const result: OpenApiSchemas = {};
  const schemaFields = [
    "entity",
    "createBody",
    "updateBody",
    "params",
    "listQuery",
    "response",
  ] as const;

  for (const field of schemaFields) {
    const value = schemas[field];
    if (value !== undefined) {
      result[field] = toJsonSchema(value) ?? value;
    }
  }

  // Copy any extra fields as-is
  for (const [key, value] of Object.entries(schemas)) {
    if (!schemaFields.includes(key as (typeof schemaFields)[number])) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Convert schema values in a Fastify route schema record.
 *
 * Handles `body`, `querystring`, `params`, `headers` (top-level conversion)
 * and `response` (iterates by status code — each value converted individually).
 *
 * JSON Schema values pass through unchanged. Only Zod schemas are converted.
 *
 * Used for both additionalRoutes and customSchemas (CRUD overrides).
 */
export function convertRouteSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...schema };

  // Convert top-level schema fields (body, querystring, params, headers)
  for (const field of ["body", "querystring", "params", "headers"] as const) {
    if (result[field] !== undefined) {
      result[field] = toJsonSchema(result[field]) ?? result[field];
    }
  }

  // Convert response schemas (keyed by status code, e.g. { 200: zodSchema, 201: zodSchema })
  if (
    result.response !== undefined &&
    typeof result.response === "object" &&
    result.response !== null
  ) {
    const responseObj = result.response as Record<string, unknown>;
    const convertedResponse: Record<string, unknown> = {};
    for (const [statusCode, responseSchema] of Object.entries(responseObj)) {
      convertedResponse[statusCode] = toJsonSchema(responseSchema) ?? responseSchema;
    }
    result.response = convertedResponse;
  }

  return result;
}
