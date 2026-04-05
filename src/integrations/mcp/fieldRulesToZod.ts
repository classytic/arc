/**
 * @classytic/arc — fieldRules → Zod Shape Converter
 *
 * Converts Arc's schemaOptions.fieldRules into flat Zod shapes
 * compatible with the MCP SDK's registerTool() inputSchema format.
 *
 * Returns `Record<string, z.ZodTypeAny>` (flat shape), NOT z.object().
 * The SDK wraps it internally.
 *
 * @example
 * ```typescript
 * import { fieldRulesToZod } from '@classytic/arc/mcp';
 *
 * const shape = fieldRulesToZod(resource.schemaOptions.fieldRules, {
 *   mode: 'create',
 *   hiddenFields: resource.schemaOptions.hiddenFields,
 * });
 * // shape = { name: z.string(), price: z.number() }
 * ```
 */

import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

export interface FieldRulesToZodOptions {
  /** create: required enforced. update: all optional. list: filters + pagination. */
  mode?: "create" | "update" | "list";
  /** Fields hidden from all schemas */
  hiddenFields?: string[];
  /** Fields excluded from create/update schemas */
  readonlyFields?: string[];
  /** Extra fields to hide (e.g., from McpResourceConfig.hideFields) */
  extraHideFields?: string[];
  /** Filterable fields — only used in list mode */
  filterableFields?: readonly string[];
  /** Allowed filter operators — generates `field[op]` entries in list mode (e.g., price[gt], price[lte]) */
  allowedOperators?: readonly string[];
}

/** Single field rule entry from Arc's schemaOptions.fieldRules */
export interface FieldRuleEntry {
  type?: string;
  required?: boolean;
  systemManaged?: boolean;
  hidden?: boolean;
  immutable?: boolean;
  immutableAfterCreate?: boolean;
  optional?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  enum?: string[];
  pattern?: string;
  description?: string;
  [key: string]: unknown;
}

// ============================================================================
// Static pagination fields (shared across all list schemas)
// ============================================================================

const PAGINATION_SHAPE: Record<string, z.ZodTypeAny> = {
  page: z.number().int().min(1).optional().describe("Page number (1-based)"),
  limit: z.number().int().min(1).max(100).optional().describe("Items per page (max 100)"),
  sort: z.string().optional().describe("Sort field, prefix with - for descending"),
  search: z.string().optional().describe("Full-text search query"),
};

// ============================================================================
// Main
// ============================================================================

/**
 * Convert Arc fieldRules to a flat Zod shape.
 *
 * @returns Flat shape `Record<string, z.ZodTypeAny>` — pass directly to defineTool() or registerTool()
 */
export function fieldRulesToZod(
  fieldRules: Record<string, FieldRuleEntry> | undefined,
  options: FieldRulesToZodOptions = {},
): Record<string, z.ZodTypeAny> {
  const { mode = "create", hiddenFields = [], readonlyFields = [], extraHideFields = [] } = options;

  if (mode === "list") {
    return buildListShape(fieldRules, options);
  }

  if (!fieldRules) return {};

  const allHidden = new Set([...hiddenFields, ...extraHideFields]);
  const allReadonly = new Set(readonlyFields);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, rule] of Object.entries(fieldRules)) {
    if (rule.systemManaged || rule.hidden || allHidden.has(name)) continue;
    if (allReadonly.has(name)) continue;
    if (mode === "update" && rule.immutable) continue;

    const field = buildFieldSchema(rule);

    if (mode === "update") {
      shape[name] = field.optional();
    } else {
      const isRequired = rule.required === true && !rule.optional;
      shape[name] = isRequired ? field : field.optional();
    }
  }

  return shape;
}

// ============================================================================
// Internal
// ============================================================================

/** Build Zod type for a single field rule */
function buildFieldSchema(rule: FieldRuleEntry): z.ZodTypeAny {
  // Enum takes priority — use z.enum() instead of z.string()
  if (rule.enum?.length) {
    const schema = z.enum(rule.enum as [string, ...string[]]);
    return rule.description ? schema.describe(rule.description) : schema;
  }

  const base = typeToZod(rule.type);

  // String constraints
  if (base instanceof z.ZodString) {
    let s = base;
    if (rule.minLength != null) s = s.min(rule.minLength);
    if (rule.maxLength != null) s = s.max(rule.maxLength);
    if (rule.pattern) {
      try {
        s = s.regex(new RegExp(rule.pattern));
      } catch {
        /* invalid regex — skip */
      }
    }
    return rule.description ? s.describe(rule.description) : s;
  }

  // Number constraints
  if (base instanceof z.ZodNumber) {
    let n = base;
    if (rule.min != null) n = n.min(rule.min);
    if (rule.max != null) n = n.max(rule.max);
    return rule.description ? n.describe(rule.description) : n;
  }

  return rule.description ? base.describe(rule.description) : base;
}

/** Map Arc field type string to base Zod type */
function typeToZod(type: string | undefined): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "date":
      return z.string().describe("ISO 8601 date string");
    case "array":
      return z.array(z.any());
    case "object":
      return z.record(z.string(), z.any());
    default:
      return z.string();
  }
}

/** Operators that apply to numeric/date fields */
const COMPARISON_OPS = new Set(["gt", "gte", "lt", "lte"]);
/** Map operator to a human-readable description suffix */
function opDescription(op: string, fieldName: string): string {
  switch (op) {
    case "gt":
      return `${fieldName} greater than`;
    case "gte":
      return `${fieldName} greater than or equal`;
    case "lt":
      return `${fieldName} less than`;
    case "lte":
      return `${fieldName} less than or equal`;
    case "ne":
      return `${fieldName} not equal to`;
    case "in":
      return `${fieldName} in comma-separated list`;
    case "nin":
      return `${fieldName} not in comma-separated list`;
    case "exists":
      return `${fieldName} exists (true/false)`;
    default:
      return `${fieldName} ${op}`;
  }
}

/** Build list/query shape with filterable fields, operators, and pagination */
function buildListShape(
  fieldRules: Record<string, FieldRuleEntry> | undefined,
  options: FieldRulesToZodOptions,
): Record<string, z.ZodTypeAny> {
  const {
    filterableFields = [],
    hiddenFields = [],
    extraHideFields = [],
    allowedOperators,
  } = options;
  const allHidden = new Set([...hiddenFields, ...extraHideFields]);

  // Start with pagination fields
  const shape: Record<string, z.ZodTypeAny> = { ...PAGINATION_SHAPE };

  if (!fieldRules) return shape;

  for (const name of filterableFields) {
    if (allHidden.has(name)) continue;
    const rule = fieldRules[name];
    if (!rule) continue;

    // Exact-match field (always present)
    const filterField = buildFieldSchema(rule);
    shape[name] = filterField.optional();

    // Operator-suffixed fields: field[gt], field[lte], etc.
    if (allowedOperators?.length) {
      const isNumericOrDate = rule.type === "number" || rule.type === "date";

      for (const op of allowedOperators) {
        // Skip comparison ops for non-numeric fields (string[gt] is meaningless)
        if (COMPARISON_OPS.has(op) && !isNumericOrDate) continue;
        // Skip 'eq' — exact match is already the base field
        if (op === "eq") continue;
        // exists is always boolean
        if (op === "exists") {
          shape[`${name}_${op}`] = z.boolean().optional().describe(opDescription(op, name));
          continue;
        }
        // in/nin accept comma-separated strings
        if (op === "in" || op === "nin") {
          shape[`${name}_${op}`] = z.string().optional().describe(opDescription(op, name));
          continue;
        }
        // Comparison ops use the same type as the field
        shape[`${name}_${op}`] = filterField.optional().describe(opDescription(op, name));
      }
    }
  }

  return shape;
}
