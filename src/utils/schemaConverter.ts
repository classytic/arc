/**
 * Schema Converter — Detect-First, Convert-Only-When-Needed
 *
 * Converts Zod v4 schemas to JSON Schema using Zod's native `z.toJSONSchema()`.
 * Plain JSON Schema objects pass through with zero overhead.
 *
 * Zod is an **optional** peer dependency — loaded lazily at module init.
 * If Zod is not installed, Zod schemas pass through unconverted with a warning.
 *
 * ## Targets
 *
 * Zod v4's `toJSONSchema` supports multiple output targets; arc picks per consumer:
 *
 * - **`draft-7`** (default) — for Fastify route schemas. Fastify v5 bundles AJV 8
 *   configured for draft-07, which uses **numeric** `exclusiveMinimum`/`exclusiveMaximum`.
 *   The `openapi-3.0` target emits the **boolean** form inherited from draft-04
 *   (`exclusiveMinimum: true` alongside `minimum`), which AJV rejects at route
 *   registration with `schema is invalid: data/properties/X/exclusiveMinimum must be number`.
 *   Using `draft-7` fixes `.positive() / .negative() / .gt() / .lt()` out of the box.
 * - **`openapi-3.0`** — for OpenAPI doc generation (arc emits OpenAPI 3.0.3). Keeps
 *   the boolean exclusive form that 3.0 tooling expects.
 */

import type { OpenApiSchemas } from "../types/index.js";

/**
 * Supported JSON Schema output targets for Zod v4's `toJSONSchema()`.
 * - `draft-7`: Fastify/AJV validation (default)
 * - `draft-2020-12`: AJV 2020 (opt-in, requires ajv/dist/2020)
 * - `openapi-3.0`: OpenAPI 3.0 document generation
 * - `openapi-3.1`: OpenAPI 3.1 document generation
 */
export type JsonSchemaTarget = "draft-7" | "draft-2020-12" | "openapi-3.0" | "openapi-3.1";

/** Default target for Fastify-consumed schemas (matches Fastify v5's default AJV draft). */
const DEFAULT_FASTIFY_TARGET: JsonSchemaTarget = "draft-7";

/** Default target for OpenAPI document generation (matches arc's emitted OpenAPI version). */
const DEFAULT_OPENAPI_TARGET: JsonSchemaTarget = "openapi-3.0";

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
 * 3. Zod v4 schema → `z.toJSONSchema(schema, { target })`
 * 4. Unrecognized object → return as-is (treat as opaque schema)
 *
 * @param input Schema (Zod, plain JSON Schema, or opaque object)
 * @param target Output target — defaults to `draft-7` for Fastify compatibility.
 *               Pass `openapi-3.0`/`openapi-3.1` for OpenAPI document generation.
 */
export function toJsonSchema(
  input: unknown,
  target: JsonSchemaTarget = DEFAULT_FASTIFY_TARGET,
): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object") return undefined;

  // Fast path: already a plain JSON Schema → passthrough
  if (isJsonSchema(input)) return input as Record<string, unknown>;

  // Zod v4 schema → native conversion
  if (isZodSchema(input)) {
    if (!_toJSONSchema) {
      // Zod not installed but a Zod schema was passed — can't convert
      // Zod not installed — return input as-is (best effort)
      return input as Record<string, unknown>;
    }
    try {
      const converted = _toJSONSchema(input, { target });
      // Strip `$schema` meta — Fastify's AJV warns about unknown draft URIs under
      // strictSchema when the bundled AJV draft doesn't match. Harmless for OpenAPI too.
      if ("$schema" in converted) {
        delete converted.$schema;
      }
      return converted;
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
 *
 * Defaults to the `openapi-3.0` target since this function feeds OpenAPI doc
 * generation, not Fastify route validation.
 */
export function convertOpenApiSchemas(
  schemas: OpenApiSchemas,
  target: JsonSchemaTarget = DEFAULT_OPENAPI_TARGET,
): OpenApiSchemas {
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
      result[field] = toJsonSchema(value, target) ?? value;
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
 *
 * Defaults to `draft-7` so Fastify v5's bundled AJV 8 accepts the output.
 * Pass `openapi-3.0` (or `openapi-3.1`) when generating OpenAPI documents.
 */
export function convertRouteSchema(
  schema: Record<string, unknown>,
  target: JsonSchemaTarget = DEFAULT_FASTIFY_TARGET,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...schema };

  // Convert top-level schema fields (body, querystring, params, headers)
  for (const field of ["body", "querystring", "params", "headers"] as const) {
    if (result[field] !== undefined) {
      result[field] = toJsonSchema(result[field], target) ?? result[field];
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
      convertedResponse[statusCode] = toJsonSchema(responseSchema, target) ?? responseSchema;
    }
    result.response = convertedResponse;
  }

  return result;
}
