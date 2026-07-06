/**
 * Schema IR → Zod adapter — the MCP-facing half of [schemaIR.ts](./schemaIR.ts).
 *
 * Lives in its OWN module (not schemaIR.ts) because it is the only part that
 * needs zod at runtime. schemaIR.ts is statically imported by
 * `createActionRouter`, which every actions-bearing resource loads at boot —
 * a top-level `import { z } from "zod"` there made zod a de-facto REQUIRED
 * dependency for any host using `actions:`, despite zod being an optional
 * peer (boot crash when absent, even with plain-JSON-Schema action bodies
 * and no MCP). Only MCP code imports this module, and the MCP integration
 * already hard-requires zod (the SDK does), so the top-level import is
 * correct HERE and a bug THERE.
 */

import { z } from "zod";
import type { SchemaIR } from "./schemaIR.js";

/**
 * Emit a flat Zod shape from the IR. The MCP SDK wraps the returned record
 * in `z.object()` internally, so we return the bare shape (same contract
 * as `ToolDefinition.inputSchema`).
 *
 * `additionalProperties: false` is honored at the MCP handler layer rather
 * than baked into the Zod shape — the SDK's input validation happens before
 * the handler runs, and flat shapes can't express `.strict()` mode.
 * `shouldRejectAdditionalProperties(ir)` (schemaIR.ts) returns the flag so
 * callers can gate their handler on it.
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
