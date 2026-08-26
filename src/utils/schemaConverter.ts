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
 * TARGET — `draft-7` for Fastify route schemas, `openapi-3.0` for docs. Fastify
 * v5's AJV 8 is draft-07 and wants NUMERIC `exclusiveMinimum`; the
 * `openapi-3.0` target emits the draft-04 boolean form, which AJV rejects at
 * registration (`exclusiveMinimum must be number`). Using `draft-7` makes
 * `.positive()` / `.gt()` work unmodified.
 *
 * IO DIRECTION — a Zod schema has two shapes and getting this wrong REJECTS
 * LEGAL TRAFFIC:
 *
 * ```ts
 * z.object({ title: z.string(), status: z.string().default("draft") })
 * // io: "output" → required: ["title", "status"]  ← omitting `status` is rejected
 * // io: "input"  → required: ["title"]            ← correct; the default fills it
 * ```
 *
 * `.transform()` is worse in output mode: unrepresentable, so it degrades to
 * `{}` — no validation at all. Arc therefore converts by direction: REQUESTS
 * (`body`/`querystring`/`params`/`headers`) use `io: "input"`, validating what
 * the client sends before defaults and transforms; RESPONSES (and the `entity`
 * shape) use `io: "output"`, describing what the server returns.
 *
 * Consequence: plain `z.object()` emits `additionalProperties: false` only in
 * output mode, because it STRIPS unknown keys rather than rejecting them — so
 * extra keys are legal input. Use `z.strictObject()` when the wire contract
 * must reject them; it holds in both modes.
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

/**
 * Which of a Zod schema's two shapes to emit. See the module docblock — this is
 * the difference between accepting and rejecting a legal request.
 */
export type SchemaIo = "input" | "output";

/** Default target for Fastify-consumed schemas (matches Fastify v5's default AJV draft). */
const DEFAULT_FASTIFY_TARGET: JsonSchemaTarget = "draft-7";

/** Default target for OpenAPI document generation (matches arc's emitted OpenAPI version). */
const DEFAULT_OPENAPI_TARGET: JsonSchemaTarget = "openapi-3.0";

/**
 * Map arc's target onto one Zod actually branches on.
 *
 * Zod's `target` is typed `"draft-04" | "draft-07" | "draft-2020-12" |
 * "openapi-3.0" | ({} & string)` — that last member accepts ANY string without
 * narrowing, so an unrecognized value is not rejected, it just matches none of
 * the internal `target === ...` branches and silently gets draft-2020-12
 * behaviour. `"draft-7"` is safe (Zod normalizes the alias to `"draft-07"`),
 * but `"openapi-3.1"` is neither official nor normalized. Mapping it explicitly
 * keeps the fallback intentional rather than accidental — and it is the right
 * dialect, since OpenAPI 3.1 aligned its Schema Object with JSON Schema 2020-12.
 */
function zodTarget(target: JsonSchemaTarget): string {
  return target === "openapi-3.1" ? "draft-2020-12" : target;
}

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
 * @param io     Which shape to emit — see {@link SchemaIo} and the module
 *               docblock. Defaults to `'output'`, matching Zod's own default;
 *               arc's request-side call sites pass `'input'` explicitly.
 */
export function toJsonSchema(
  input: unknown,
  target: JsonSchemaTarget = DEFAULT_FASTIFY_TARGET,
  mode: UnconvertibleMode = "warn",
  io: SchemaIo = "output",
): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object") return undefined;

  // Fast path: already a plain JSON Schema → passthrough.
  //
  // Still strip `$schema`. The Zod branch below removes it because Fastify's AJV
  // cannot resolve an unknown draft URI as a registered ref — and a plain JSON
  // Schema carrying one fails IDENTICALLY. That happens whenever a caller
  // pre-converts (`z.toJSONSchema(mySchema)`) before handing the result to a
  // route, which is a natural thing to write and lands here instead of in the Zod
  // branch, so the normalization was skipped precisely when it was needed. The
  // symptom is a BOOT failure — `no schema with key or ref
  // ".../2020-12/schema"` — that names a URI the author never typed, so it reads
  // as an arc bug rather than "drop this key".
  //
  // Cloned, never mutated in place: the input may be a module-level constant
  // shared across several routes (or exported for a contract test), and deleting
  // a key from it would edit the caller's own object as a side effect of asking
  // for a conversion.
  if (isJsonSchema(input)) {
    const plain = input as Record<string, unknown>;
    if ("$schema" in plain) {
      const { $schema: _dropped, ...rest } = plain;
      return rest;
    }
    return plain;
  }

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
      // `unrepresentable`: strict `throw` mode (action-route VALIDATION) keeps
      // Zod's default `'throw'` so an unconvertible action schema stays a loud
      // boot error — a silent contract hole there is a bug. Non-strict paths
      // (OpenAPI doc generation, e.g. better-auth's endpoint schemas, which use
      // `.transform`/`.refine` internally) use `'any'`: an unrepresentable node
      // emits `{}` for THAT field instead of throwing, so the rest of the schema
      // survives and no spurious "validation disabled" warning fires. Docs
      // fidelity is best-effort; the transform still runs at the auth layer.
      const converted = _toJSONSchema(input, {
        target: zodTarget(target),
        io,
        unrepresentable: mode === "throw" ? "throw" : "any",
      });
      // Strip `$schema` meta — Fastify's AJV warns about unknown draft URIs under
      // strictSchema when the bundled AJV draft doesn't match. Harmless for OpenAPI too.
      if ("$schema" in converted) {
        delete converted.$schema;
      }
      return converted;
    } catch (cause) {
      return unconvertible(
        mode,
        `z.toJSONSchema() failed for a Zod schema (target: ${target}, io: ${io}): ${
          cause instanceof Error ? cause.message : String(cause)
        }. Types with no JSON Schema equivalent cannot express wire validation. ` +
          "For `z.date()` / `z.bigint()` on a REQUEST schema, use the wire-shaped form " +
          "(`z.iso.datetime()` / `z.string()`) and convert in a hook — JSON has no date or " +
          "bigint. For `.refine()` / `.transform()` / custom checks, enforce them in the " +
          "handler or a pipeline step.",
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
  // Direction per slot: what the caller SENDS converts as input (defaults are
  // not yet applied, transforms have not run); what the server RETURNS converts
  // as output. Documenting a create body in output shape would list
  // default-bearing fields as required — telling every client to send a value
  // the server would have supplied.
  const schemaFields = {
    entity: "output",
    createBody: "input",
    updateBody: "input",
    params: "input",
    listQuery: "input",
    response: "output",
  } as const satisfies Record<string, SchemaIo>;

  for (const [field, io] of Object.entries(schemaFields) as [
    keyof typeof schemaFields,
    SchemaIo,
  ][]) {
    const value = schemas[field];
    if (value !== undefined) {
      result[field] = toJsonSchema(value, target, "warn", io) ?? value;
    }
  }

  // Copy any extra fields as-is
  for (const [key, value] of Object.entries(schemas)) {
    if (!(key in schemaFields)) {
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

  // Request slots convert as INPUT — they validate the raw payload BEFORE any
  // default is filled in or transform runs. Converting them as output (the Zod
  // default, and what arc did before) marks every `.default()` field `required`,
  // so a request that legitimately omits one is rejected with a 400 that names a
  // property the client was never supposed to send.
  for (const field of ["body", "querystring", "params", "headers"] as const) {
    if (result[field] !== undefined) {
      result[field] = toJsonSchema(result[field], target, mode, "input") ?? result[field];
    }
  }

  // Convert response schemas (keyed by status code, e.g. { 200: zodSchema, 201: zodSchema }).
  // These stay OUTPUT — they describe what the handler returns, post-transform.
  if (
    result.response !== undefined &&
    typeof result.response === "object" &&
    result.response !== null
  ) {
    const responseObj = result.response as Record<string, unknown>;
    const convertedResponse: Record<string, unknown> = {};
    for (const [statusCode, responseSchema] of Object.entries(responseObj)) {
      convertedResponse[statusCode] =
        toJsonSchema(responseSchema, target, mode, "output") ?? responseSchema;
    }
    result.response = convertedResponse;
  }

  return result;
}
