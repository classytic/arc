/**
 * Schema Converter — Detect-First, Convert-Only-When-Needed
 *
 * Converts Zod v4 schemas to JSON Schema using Zod's native `z.toJSONSchema()`.
 * Plain JSON Schema objects pass through with zero overhead.
 *
 * Zod is an **optional** peer dependency — loaded lazily at module init;
 * `ensureSchemaConverter()` awaits readiness (arc's resource plugin does this
 * before converting). When a Zod schema shows up and can't be converted
 * (zod missing, zod v3, conversion throw), VALIDATION paths fail fast at
 * boot with an actionable error; DOC paths warn and degrade — see
 * {@link UnconvertibleMode}. Hosts that never pass Zod pay nothing.
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

import { arcLog } from "../logger/index.js";
import type { OpenApiSchemas } from "../types/index.js";

const log = arcLog("schema");

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

// Resolve Zod at module load (async, non-blocking; no top-level await so the
// module stays ESM+CJS safe). The settled promise is exported below as
// `ensureSchemaConverter()` so async registration paths can AWAIT readiness
// instead of relying on "the promise will probably have settled by now".
const zodReady: Promise<void> = import("zod")
  .then(({ z }) => {
    if (typeof z?.toJSONSchema === "function") {
      // Zod's `toJSONSchema` is typed against its internal $ZodType. We
      // accept any "schema-shaped" record at the arc boundary and re-cast
      // through `unknown` so neither the schema nor the options bag leaks
      // `any` outward — call site receives `Record<string, unknown>`.
      _toJSONSchema = (schema, opts) =>
        z.toJSONSchema(
          schema as unknown as Parameters<typeof z.toJSONSchema>[0],
          opts as unknown as Parameters<typeof z.toJSONSchema>[1],
        ) as Record<string, unknown>;
    }
  })
  .catch(() => {
    // Zod not installed — toJsonSchema() warns/throws when a Zod schema
    // actually shows up (a host that never passes Zod never hears about it).
  });

/**
 * Await Zod-converter readiness. Arc's resource plugin awaits this once
 * before any schema conversion, closing the (theoretical) race between the
 * lazy `import("zod")` above and boot-time route registration. Resolves
 * immediately when zod isn't installed — absence is handled per-schema.
 */
export function ensureSchemaConverter(): Promise<void> {
  return zodReady;
}

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

/**
 * Zod v3 schemas carry `_def` but NOT v4's `_zod` marker. They can't be
 * converted (`z.toJSONSchema()` is v4-only) — detect them so the failure is
 * an actionable "upgrade to zod v4" instead of a cryptic AJV boot error
 * three layers away.
 */
function isZodV3Schema(input: unknown): boolean {
  if (input === null || typeof input !== "object") return false;
  const obj = input as Record<string, unknown>;
  return "_def" in obj && !("_zod" in obj);
}

// ============================================================================
// Converter
// ============================================================================

/**
 * How `toJsonSchema` reacts when a Zod schema CANNOT be converted (zod not
 * installed/loaded, zod v3, or `z.toJSONSchema()` threw):
 *
 * - `'throw'` — fail fast with an actionable error. Used by
 *   `convertRouteSchema` (VALIDATION path): a schema that silently degrades
 *   to `{ type: 'object' }` is validation switched off — the worst outcome
 *   for a wire contract, worse than a boot failure.
 * - `'warn'` (default) — log loudly, degrade to a permissive `{ type:
 *   'object' }`. Used by doc-generation paths (OpenAPI extraction of
 *   Better Auth endpoints etc.), where the schema is third-party and a doc
 *   gap must not take the app down.
 */
export type UnconvertibleMode = "warn" | "throw";

function unconvertible(
  mode: UnconvertibleMode,
  message: string,
  cause?: unknown,
): Record<string, unknown> {
  if (mode === "throw") {
    throw new Error(`[arc/schema] ${message}`, cause ? { cause } : undefined);
  }
  log.warn(
    `${message} — degrading to permissive { type: 'object' } (validation disabled for this slot)`,
  );
  return { type: "object" };
}

/**
 * Convert any schema input to JSON Schema.
 *
 * Detection order:
 * 1. `null`/`undefined` → `undefined`
 * 2. Already JSON Schema → pass through as-is (zero overhead)
 * 3. Zod v4 schema → `z.toJSONSchema(schema, { target })`
 * 4. Zod v3 schema → unconvertible (actionable "upgrade to v4" error/warn)
 * 5. Unrecognized object → return as-is (treat as opaque schema)
 *
 * @param input  Schema (Zod, plain JSON Schema, or opaque object)
 * @param target Output target — defaults to `draft-7` for Fastify compatibility.
 *               Pass `openapi-3.0`/`openapi-3.1` for OpenAPI document generation.
 * @param mode   Failure policy for unconvertible Zod schemas — see
 *               {@link UnconvertibleMode}. Defaults to `'warn'`.
 */
export function toJsonSchema(
  input: unknown,
  target: JsonSchemaTarget = DEFAULT_FASTIFY_TARGET,
  mode: UnconvertibleMode = "warn",
): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object") return undefined;

  // Fast path: already a plain JSON Schema → passthrough
  if (isJsonSchema(input)) return input as Record<string, unknown>;

  // Zod v4 schema → native conversion
  if (isZodSchema(input)) {
    if (!_toJSONSchema) {
      return unconvertible(
        mode,
        "A Zod schema was passed but zod v4 is not installed (or not yet loaded). " +
          "Install zod >=4 — arc converts via zod's native z.toJSONSchema().",
      );
    }
    try {
      const converted = _toJSONSchema(input, { target });
      // Strip `$schema` meta — Fastify's AJV warns about unknown draft URIs under
      // strictSchema when the bundled AJV draft doesn't match. Harmless for OpenAPI too.
      if ("$schema" in converted) {
        delete converted.$schema;
      }
      return converted;
    } catch (cause) {
      return unconvertible(
        mode,
        `z.toJSONSchema() failed for a Zod schema (target: ${target}): ${
          cause instanceof Error ? cause.message : String(cause)
        }. Zod-only features with no JSON Schema equivalent (.refine/.transform/custom checks) ` +
          "cannot express wire validation — enforce those in the handler or a pipeline step.",
        cause,
      );
    }
  }

  // Zod v3 — convertible only by v4's z.toJSONSchema; fail with the real fix.
  if (isZodV3Schema(input)) {
    return unconvertible(
      mode,
      "A Zod v3 schema was passed (has `_def` but no v4 `_zod` marker). " +
        "arc requires zod >=4 for schema conversion — upgrade zod, or pass plain JSON Schema.",
    );
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
 * Used for both custom routes and customSchemas (CRUD overrides).
 *
 * Defaults to `draft-7` so Fastify v5's bundled AJV 8 accepts the output.
 * Pass `openapi-3.0` (or `openapi-3.1`) when generating OpenAPI documents.
 */
export function convertRouteSchema(
  schema: Record<string, unknown>,
  target: JsonSchemaTarget = DEFAULT_FASTIFY_TARGET,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...schema };

  // Validation schemas fail FAST on unconvertible Zod input: silently
  // degrading a body/response schema to `{ type: 'object' }` is validation
  // switched off — a wire-contract hole, not a graceful fallback. The
  // OpenAPI target keeps 'warn' (doc generation must not take the app
  // down over a third-party schema).
  const mode: UnconvertibleMode = target === DEFAULT_FASTIFY_TARGET ? "throw" : "warn";

  // Convert top-level schema fields (body, querystring, params, headers)
  for (const field of ["body", "querystring", "params", "headers"] as const) {
    if (result[field] !== undefined) {
      result[field] = toJsonSchema(result[field], target, mode) ?? result[field];
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
      convertedResponse[statusCode] = toJsonSchema(responseSchema, target, mode) ?? responseSchema;
    }
    result.response = convertedResponse;
  }

  return result;
}
