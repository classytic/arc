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
    }
  }
}
