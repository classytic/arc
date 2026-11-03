/**
 * Declared field types for the aggregation route's URL filter coercion.
 *
 * A URL carries every value as a string. Without types the aggregation route guessed from the
 * value's shape: a range operand that LOOKS like a date (`2026-11-01`) became a `Date`, so a
 * string field holding civil dates (`civilDate[gte]=2026-11-01`) compared a Date against
 * strings and matched nothing, while a number field got string operands (`amount[gte]=10`) and
 * matched nothing either. With a declared type the operand is coerced BY THE FIELD:
 *
 *   - `string`  — kept as sent (never a Date)
 *   - `date`    — a `Date` when it parses (else kept, as before)
 *   - `number`  — a number when it is a finite numeric string (else kept)
 *   - `boolean` — `true` / `false` from `"true"` / `"false"` (else kept)
 *
 * A field with no declared type keeps the legacy behaviour exactly (range operands that look
 * like ISO dates become Dates; everything else stays a string).
 *
 * Sources, most specific first: the aggregation's own `fieldTypes`, then the types derived from
 * the resource's generated entity schema (`adapter.generateSchemas()`, the same JSON Schema the
 * OpenAPI document and MCP tools use). Only unambiguous JSON Schema shapes are mapped:
 * `format: "date-time"` is a date; `format: "date"` is NOT mapped (a Mongo `Date` emitted with
 * `dateAs: "date"` and a civil-date string column look the same), so it keeps the legacy guess.
 */

import type { AnyRecord } from "../../types/index.js";

/** The coercion classes a URL filter operand can be cast to. */
export type AggregationFieldType = "string" | "number" | "boolean" | "date";

export type AggregationFieldTypes = Readonly<Record<string, AggregationFieldType>>;

const isRecord = (v: unknown): v is AnyRecord => !!v && typeof v === "object" && !Array.isArray(v);

/** One JSON Schema property → a field type, or `undefined` when ambiguous / not scalar. */
function typeOfProperty(prop: unknown): AggregationFieldType | undefined {
  if (!isRecord(prop)) return undefined;
  // Nullable shapes: `anyOf` / `oneOf` [X, { type: "null" }] → X when exactly one non-null branch.
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = prop[key];
    if (Array.isArray(branches)) {
      const nonNull = branches.filter((b) => !(isRecord(b) && b.type === "null"));
      return nonNull.length === 1 ? typeOfProperty(nonNull[0]) : undefined;
    }
  }
  const declared = Array.isArray(prop.type) ? prop.type.filter((t) => t !== "null") : [prop.type];
  if (declared.length !== 1) return undefined;
  switch (declared[0]) {
    case "string":
      if (prop.format === "date-time") return "date";
      if (prop.format === "date") return undefined;
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
}

function collect(schema: unknown, prefix: string, out: Record<string, AggregationFieldType>): void {
  if (!isRecord(schema) || !isRecord(schema.properties)) return;
  for (const [name, prop] of Object.entries(schema.properties)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (path in out) continue;
    const type = typeOfProperty(prop);
    if (type) out[path] = type;
    else if (isRecord(prop) && isRecord(prop.properties)) collect(prop, path, out);
  }
}

/**
 * Field types from a resource's generated OpenAPI schemas. Reads `entity`, then `response`, then
 * `createBody` (the first that declares a field wins). Returns `{}` when none is available.
 */
export function fieldTypesFromOpenApiSchemas(
  schemas: unknown,
): Record<string, AggregationFieldType> {
  const out: Record<string, AggregationFieldType> = {};
  if (!isRecord(schemas)) return out;
  for (const key of ["entity", "response", "createBody"]) collect(schemas[key], "", out);
  return out;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** The legacy shape guess, kept for fields with no declared type. */
export function guessDate(v: unknown): unknown {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d;
}

/** Coerce one URL operand by the field's declared type. Unparseable input is returned unchanged. */
export function coerceByType(v: unknown, type: AggregationFieldType): unknown {
  if (typeof v !== "string") return v;
  switch (type) {
    case "string":
      return v;
    case "date": {
      const d = new Date(v);
      return v.trim() === "" || Number.isNaN(d.getTime()) ? v : d;
    }
    case "number": {
      const n = Number(v);
      return v.trim() === "" || !Number.isFinite(n) ? v : n;
    }
    case "boolean":
      return v === "true" ? true : v === "false" ? false : v;
  }
}
