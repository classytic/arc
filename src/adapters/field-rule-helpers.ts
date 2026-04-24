/**
 * Field-rule helpers shared across adapters.
 *
 * `RouteSchemaOptions.fieldRules` carries portable constraint metadata
 * (`minLength`, `maxLength`, `min`, `max`, `pattern`, `enum`, `description`)
 * that every backend surfaces via AJV the same way. Each adapter builds its
 * base property schema from its own type introspection (mongoose paths,
 * drizzle columns, prisma fields), then calls `mergeFieldRuleConstraints`
 * to layer rule-driven constraints onto the properties that already exist.
 *
 * The merge is a pure post-processing step: it never adds new properties,
 * never overrides a constraint the schema already declares, and never
 * touches properties the rule doesn't mention. That keeps behavior
 * predictable regardless of which kit generated the base schema.
 */

import type { OpenApiSchemas, RouteSchemaOptions } from "../types/index.js";

type AnyObj = Record<string, unknown>;

/**
 * Merge constraint-style `fieldRules` into an `OpenApiSchemas` bag in place.
 *
 * Operates on the three schema slots that carry property maps — `createBody`,
 * `updateBody`, `response`. `listQuery` and `params` are skipped (their
 * constraint vocabulary is owned by the kit's query parser).
 *
 * Existing constraints on a property always win — the merge only fills in
 * gaps. Adapters that already walk `fieldRules` during base-schema assembly
 * can call this helper for free (the checks are no-ops when constraints
 * already exist).
 */
export function mergeFieldRuleConstraints(
  schemas: OpenApiSchemas | Record<string, unknown> | null | undefined,
  schemaOptions?: RouteSchemaOptions,
): void {
  if (!schemas || typeof schemas !== "object") return;
  const rules = schemaOptions?.fieldRules;
  if (!rules || Object.keys(rules).length === 0) return;

  for (const slot of ["createBody", "updateBody", "response"] as const) {
    const slotSchema = (schemas as AnyObj)[slot];
    if (!slotSchema || typeof slotSchema !== "object") continue;
    const properties = (slotSchema as AnyObj).properties as Record<string, AnyObj> | undefined;
    if (!properties) continue;

    for (const [field, rule] of Object.entries(rules)) {
      const prop = properties[field];
      if (!prop || typeof prop !== "object") continue;

      if (rule.minLength != null && prop.minLength == null) prop.minLength = rule.minLength;
      if (rule.maxLength != null && prop.maxLength == null) prop.maxLength = rule.maxLength;
      if (rule.min != null && prop.minimum == null) prop.minimum = rule.min;
      if (rule.max != null && prop.maximum == null) prop.maximum = rule.max;
      if (rule.pattern != null && prop.pattern == null) prop.pattern = rule.pattern;
      if (rule.enum != null && prop.enum == null) prop.enum = rule.enum as unknown[];
      if (rule.description != null && prop.description == null) {
        prop.description = rule.description as string;
      }
      if (rule.nullable === true) applyNullable(prop);
    }
  }
}

/**
 * Widen a JSON Schema property to also accept `null`.
 *
 * Handles the three ways a property can be typed:
 *   - `type: 'string'`     → `type: ['string', 'null']`
 *   - `type: [...]`        → append `'null'` if missing
 *   - `anyOf: [...]`       → append `{ type: 'null' }` branch if missing
 *
 * **Enum interaction:** when the widened prop also carries `enum: [...]`,
 * `null` is appended to the enum list too. AJV's `enum` keyword rejects
 * values not in the list regardless of the widened `type`, so
 * `{ type: ['string','null'], enum: ['a','b'] }` alone would still reject
 * `null`. The fix is `enum: ['a','b', null]`. (The `anyOf` branch dodges
 * this entirely — each branch scopes its own enum.)
 *
 * No-op when the schema already admits null (don't double-wrap) or has
 * no `type` / `anyOf` anchor to widen (e.g. Mixed — already accepts null).
 *
 * Mutates in place — callers already treat the slot schema as owned.
 * Exported so adapters that walk `fieldRules` inline (mongoose fallback,
 * drizzle post-process) can reuse the same widening logic.
 */
export function applyNullable(prop: AnyObj): void {
  // anyOf branching: `anyOf: [{...}, {...}]` → add null branch.
  // Check this first so we don't also touch a sibling `type` that's part
  // of an outer composite schema (rare but possible).
  if (Array.isArray(prop.anyOf)) {
    const hasNull = prop.anyOf.some(
      (b) =>
        b &&
        typeof b === "object" &&
        ((b as AnyObj).type === "null" || (b as AnyObj).const === null),
    );
    if (!hasNull) prop.anyOf.push({ type: "null" });
    return;
  }

  // Array tuple form: `type: ['string', 'null']`
  if (Array.isArray(prop.type)) {
    if (!prop.type.includes("null")) prop.type.push("null");
    widenEnumToIncludeNull(prop);
    return;
  }

  // Single-string form: `type: 'string'` → widen to tuple
  if (typeof prop.type === "string") {
    prop.type = [prop.type, "null"];
    widenEnumToIncludeNull(prop);
    return;
  }

  // No type anchor — leave untouched. Untyped schemas already match null.
}

/**
 * Append `null` to `enum` when present. Required because AJV's `enum`
 * keyword is independent of `type` — a value must appear in the enum
 * array verbatim even if the widened type says null is allowed.
 */
function widenEnumToIncludeNull(prop: AnyObj): void {
  if (!Array.isArray(prop.enum)) return;
  if (prop.enum.includes(null)) return;
  prop.enum = [...prop.enum, null];
}
