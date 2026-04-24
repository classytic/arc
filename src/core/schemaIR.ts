/**
 * Schema IR — one canonical representation, two adapters.
 *
 * arc's action-schema handling used to live in two parallel translators:
 * `normalizeActionSchema()` in [createActionRouter.ts](./createActionRouter.ts)
 * produced JSON Schema for AJV, and `convertActionSchemaToZod()` in
 * [../integrations/mcp/action-tools.ts](../integrations/mcp/action-tools.ts)
 * produced Zod shapes for MCP. Same input shape, two implementations — the
 * exact drift pattern routerShared exists to eliminate.
 *
 * This module is the single source of truth: every caller normalizes to
 * `SchemaIR` first, then emits whichever surface they need. If a future
 * refactor adds a field to the IR (e.g. `propertyOrder`, `examples`),
 * both adapters pick it up automatically.
 *
 * **The IR preserves `additionalProperties`.** The previous implementation
 * dropped the flag during normalization, so `additionalProperties: false`
 * silently no-opped even though [createActionRouter.ts:425-428](./createActionRouter.ts#L425-L428)
 * documented it as the opt-in escape hatch for strict validation. The IR
 * carries the flag verbatim; both adapters honor it.
 */

import { z } from "zod";
import { toJsonSchema } from "../utils/schemaConverter.js";

// ============================================================================
// IR
// ============================================================================

/**
 * Canonical intermediate representation.
 *
 * Always describes an `{ type: 'object', properties, required, additionalProperties }`
 * shape — the only schema flavour arc actions and custom-route bodies need
 * to describe.
 */
export interface SchemaIR {
  readonly properties: Record<string, Record<string, unknown>>;
  readonly required: readonly string[];
  /**
   * `undefined` → schema doesn't set the flag (author didn't declare)
   * `false`     → strict — extra fields must be rejected
   * `true`      → permissive (rare, explicit)
   * `object`    → schema describing allowed extra properties (passthrough)
   */
  readonly additionalProperties?: boolean | Record<string, unknown>;
}

// ============================================================================
// Normalize
// ============================================================================

/**
 * Normalize anything the author handed us (Zod schema, plain JSON Schema,
 * or `undefined`) into a canonical `SchemaIR`.
 *
 * Accepts:
 *   - `undefined` / non-object → empty IR (no properties, no required)
 *   - Zod v4 object schema — converted via `toJsonSchema` from the shared utility
 *   - Plain JSON Schema with `type: 'object'` or `properties`
 *
 * Anything that can't be read as an object schema collapses to an empty IR
 * (no throw — the caller decides whether that's a validation error).
 *
 * @example
 * ```ts
 * normalizeSchemaIR({
 *   type: 'object',
 *   properties: { carrier: { type: 'string' } },
 *   required: ['carrier'],
 *   additionalProperties: false,
 * });
 * // → { properties: { carrier: { type: 'string' } }, required: ['carrier'], additionalProperties: false }
 * ```
 */
export function normalizeSchemaIR(raw: Record<string, unknown> | undefined): SchemaIR {
  if (!raw || typeof raw !== "object") {
    return { properties: {}, required: [] };
  }

  // Delegates Zod detection + conversion to the shared `toJsonSchema` util.
  // Plain JSON Schema passes through unchanged; Zod schemas are converted to
  // draft-7 JSON Schema (Fastify/AJV's preferred target).
  const converted = toJsonSchema(raw);
  if (
    !converted ||
    typeof converted !== "object" ||
    (converted.type !== "object" && !("properties" in converted))
  ) {
    return { properties: {}, required: [] };
  }

  const properties =
    (converted.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = Array.isArray(converted.required) ? (converted.required as string[]) : [];
  const additionalProperties = converted.additionalProperties as
    | boolean
    | Record<string, unknown>
    | undefined;

  return {
    properties,
    required,
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
  };
}

// ============================================================================
// Adapter — JSON Schema branch (for AJV via oneOf discriminator)
// ============================================================================

/**
 * Emit a JSON Schema branch from the IR, with optional extra properties
 * merged in (e.g. the `action: { const: 'approve' }` discriminator added
 * by `buildActionBodySchema`).
 *
 * Preserves `additionalProperties` verbatim — strict schemas (`false`)
 * reach AJV intact, so HTTP validation rejects unknown fields before the
 * handler runs. This closes the bug where the documented strict-mode
 * escape hatch silently no-opped because normalization dropped the flag.
 */
export function schemaIRToJsonSchemaBranch(
  ir: SchemaIR,
  extras: {
    properties?: Record<string, unknown>;
    required?: readonly string[];
  } = {},
): Record<string, unknown> {
  const mergedProperties = {
    ...(extras.properties ?? {}),
    ...ir.properties,
  };
  const mergedRequired = [
    ...(extras.required ?? []),
    ...ir.required.filter((f) => !(extras.required ?? []).includes(f)),
  ];

  return {
    type: "object",
    properties: mergedProperties,
    required: mergedRequired,
    ...(ir.additionalProperties !== undefined
      ? { additionalProperties: ir.additionalProperties }
      : {}),
  };
}

// ============================================================================
// Adapter — Zod shape (for MCP input schemas)
// ============================================================================

/**
 * Emit a flat Zod shape from the IR. The MCP SDK wraps the returned record
 * in `z.object()` internally, so we return the bare shape (same contract
 * as `ToolDefinition.inputSchema`).
 *
 * `additionalProperties: false` is honored at the MCP handler layer rather
 * than baked into the Zod shape — the SDK's input validation happens before
 * the handler runs, and flat shapes can't express `.strict()` mode.
 * `strictAdditionalProperties(ir)` returns the flag so callers can gate
 * their handler on it.
 */
export function schemaIRToZodShape(ir: SchemaIR): Record<string, z.ZodTypeAny> {
  const requiredSet = new Set(ir.required);
  const result: Record<string, z.ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(ir.properties)) {
    const desc =
      typeof prop.description === "string" && prop.description.length > 0 ? prop.description : name;
    const base = jsonSchemaPropToZod(prop);
    result[name] = requiredSet.has(name) ? base.describe(desc) : base.optional().describe(desc);
  }
  return result;
}

/**
 * Returns `true` when the IR declares `additionalProperties: false`. MCP
 * tool handlers should reject inputs with unknown keys when this is true,
 * matching HTTP's AJV-level strict enforcement.
 */
export function shouldRejectAdditionalProperties(ir: SchemaIR): boolean {
  return ir.additionalProperties === false;
}

/**
 * Convert a single JSON Schema property to a Zod type. Understands enum,
 * numeric/integer/boolean/array/object, and falls back to string for
 * unrecognized types (matches MCP's "strings for opaque fields" convention).
 *
 * Internal — use `schemaIRToZodShape` which wires this up with required/optional
 * + description handling.
 */
function jsonSchemaPropToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return z.enum(schema.enum as [string, ...string[]]);
  }
  const type = typeof schema.type === "string" ? schema.type : "string";
  switch (type) {
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.string();
  }
}
