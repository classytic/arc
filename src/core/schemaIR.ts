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
  // draft-7 JSON Schema (Fastify/AJV's preferred target). `throw` mode:
  // action schemas feed route VALIDATION — an unconvertible Zod schema
  // silently collapsing to an empty IR means the action accepts anything,
  // which must be a boot error, not a quiet contract hole.
  const converted = toJsonSchema(raw, "draft-7", "throw");
  if (
    !converted ||
    typeof converted !== "object" ||
    (converted.type !== "object" && !("properties" in converted))
  ) {
    return { properties: {}, required: [] };
  }

  const properties =
    (converted.properties as Record<string, Record<string, unknown>> | undefined) ?? {};

  // Zod v4's `z.toJSONSchema()` emits fields with `.default()` as `required`
  // (because defaults make fields conceptually always-present from Zod's view).
  // At the AJV layer this is wrong: callers can omit the field and expect the
  // default to be applied at the handler layer. Strip any required entry whose
  // property carries a `default` so AJV treats omitted-with-default as valid.
  const rawRequired = Array.isArray(converted.required) ? (converted.required as string[]) : [];
  const required = rawRequired.filter((field) => !("default" in (properties[field] ?? {})));

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

/**
 * An action schema's IR WITHOUT the `action` discriminator. Arc owns `action`:
 * the router emits it (top-level enum, per-branch `const`), the MCP tool name
 * carries it, and the handler's `data` never has it. A schema that declares it
 * anyway (`z.strictObject({ action: z.literal('issue'), ... })`, one branch of
 * a contracts discriminated union) must not override arc's: a declared
 * `action` used to replace the top-level enum and, merged into the other
 * branches, their `const`, so `oneOf` stopped discriminating. Strictness
 * (`additionalProperties`) is kept as declared.
 */
export function actionSchemaIR(raw: Record<string, unknown> | undefined): SchemaIR {
  const ir = normalizeSchemaIR(raw);
  if (!("action" in ir.properties)) return ir;
  const { action: _owned, ...properties } = ir.properties;
  return { ...ir, properties, required: ir.required.filter((f) => f !== "action") };
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
 *
 * `default` is stripped from each property schema. Zod v4's `z.toJSONSchema()`
 * emits `default` for `.default()` fields, but AJV with `useDefaults: true`
 * cannot apply defaults inside `oneOf` branches and throws a strict-mode error
 * (`strict mode: default is ignored for: <path>`). The action router applies
 * each action's own top-level defaults itself once the action is known
 * (`collectActionDefaults` in createActionRouter.ts). OpenAPI passes
 * `keepDefaults` so each branch documents its own defaults.
 */
export function schemaIRToJsonSchemaBranch(
  ir: SchemaIR,
  extras: {
    properties?: Record<string, unknown>;
    required?: readonly string[];
  } = {},
  /** Keep `default` on the properties (OpenAPI docs only; AJV rejects it inside `oneOf`). */
  keepDefaults = false,
): Record<string, unknown> {
  const mergedProperties: Record<string, Record<string, unknown>> = {};
  for (const [key, prop] of Object.entries({ ...(extras.properties ?? {}), ...ir.properties })) {
    if (!keepDefaults && typeof prop === "object" && prop !== null && "default" in prop) {
      const { default: _dropped, ...rest } = prop as Record<string, unknown>;
      mergedProperties[key] = rest;
    } else {
      mergedProperties[key] = prop as Record<string, unknown>;
    }
  }
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

// The Zod adapter (`schemaIRToZodShape`) lives in [schemaIRZod.ts](./schemaIRZod.ts)
// — its own module, so this file (statically imported by createActionRouter,
// which every actions-bearing resource loads at boot) never touches zod at
// runtime. zod is an OPTIONAL peer: a top-level import here previously made
// `actions:` crash at boot for hosts without zod, even with plain-JSON-Schema
// action bodies and no MCP. Only MCP code (which hard-requires zod via the
// SDK) imports the zod adapter.

/**
 * Returns `true` when the IR declares `additionalProperties: false`. MCP
 * tool handlers should reject inputs with unknown keys when this is true,
 * matching HTTP's AJV-level strict enforcement.
 */
export function shouldRejectAdditionalProperties(ir: SchemaIR): boolean {
  return ir.additionalProperties === false;
}
