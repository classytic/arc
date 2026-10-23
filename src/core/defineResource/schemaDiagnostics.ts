/**
 * Define-time detection of a `{ body: X }` wrapper where arc expects the schema ITSELF.
 *
 * An action's `schema` (and every `body` / `querystring` / `params` slot) is the JSON Schema or Zod
 * schema. `{ body: X }` there has no `type` / `properties`, so arc reads it as an empty schema and
 * the endpoint accepts ANY input: no error, no log, no validation. Warn by default; `strictSchemas`
 * (or `ARC_STRICT_SCHEMAS=true`) makes it a define-time error.
 */

import { isJsonSchema, isZodSchema } from "../../utils/schemaConverter.js";
import type { ResourceDiagnostic } from "./diagnostics.js";

const SLOT_KEYS = ["body", "querystring", "params", "headers", "response"] as const;
export const SCHEMA_SLOT_WRAPPER = "schema.slot_wrapper";

/** Slot names present on `value` when it is a slot-wrapper object, not a schema; else `[]`. */
export function findSlotWrapper(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return [];
  if (isZodSchema(value) || isJsonSchema(value)) return [];
  return SLOT_KEYS.filter((key) => key in (value as Record<string, unknown>));
}

interface SchemaSources {
  name: string;
  actions?: Record<string, unknown> | undefined;
  routes?: ReadonlyArray<unknown> | undefined;
  customSchemas?: Record<string, unknown> | undefined;
}

export function collectSchemaSlotDiagnostics(
  config: SchemaSources,
  strict: boolean,
): ResourceDiagnostic[] {
  const out: ResourceDiagnostic[] = [];
  const flag = (where: string, found: string[], fix: string): void => {
    out.push({
      severity: strict ? "error" : "warn",
      code: SCHEMA_SLOT_WRAPPER,
      message:
        `[Arc] Resource '${config.name}': ${where} is a \`{ ${found.join(", ")} }\` wrapper, not a schema. ` +
        "It has no `type` / `properties`, so arc treats it as an empty schema and the endpoint " +
        `accepts ANY input. ${fix}`,
    });
  };

  for (const [name, entry] of Object.entries(config.actions ?? {})) {
    const schema = (entry as { schema?: unknown } | undefined)?.schema;
    const found = findSlotWrapper(schema);
    if (found.length > 0) {
      flag(
        `action '${name}' schema`,
        found,
        "An action's `schema` IS its body schema: pass the schema directly (`schema: X`, not `schema: { body: X }`).",
      );
    }
  }

  const slots = (where: string, schema: unknown): void => {
    if (schema === null || typeof schema !== "object") return;
    for (const slot of ["body", "querystring", "params", "headers"]) {
      const found = findSlotWrapper((schema as Record<string, unknown>)[slot]);
      if (found.length > 0) {
        flag(
          `${where}.${slot}`,
          found,
          `Slots take the schema itself (\`${slot}: X\`), not a nested \`{ ${found[0]}: X }\`.`,
        );
      }
    }
  };
  for (const route of config.routes ?? []) {
    const r = route as { method?: unknown; path?: unknown; schema?: unknown };
    slots(`route ${String(r.method)} ${String(r.path)} schema`, r.schema);
  }
  for (const [op, schema] of Object.entries(config.customSchemas ?? {})) {
    slots(`customSchemas.${op}`, schema);
  }
  return out;
}
