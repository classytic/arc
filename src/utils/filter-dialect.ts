/**
 * Filter dialects — what `ArcQueryParser` EMITS. Reading a URL (keys, operators, coercion,
 * refusals) is repo-core's shared grammar; a dialect turns its canonical clauses into one store's
 * filter shape. The default is the Mongo record dialect arc's pipeline already speaks
 * (`toRepositoryFilter` → Filter IR), so its meaning matches `parseUrl` and mongokit exactly —
 * `runQueryGrammarConformance` holds all three to the same rows.
 */

import { escapeRegex, type FilterClause } from "@classytic/repo-core/query-parser";

export interface FilterDialect {
  /** Emit the parsed clauses as one filter. Several clauses on a field are ANDed. */
  emit(clauses: readonly FilterClause[]): Record<string, unknown>;
  /** The operator tokens this dialect can emit — for audits and docs. */
  readonly tokens: readonly string[];
}

/** One clause → one field condition, in Mongo record syntax with the Filter IR's meaning. */
function mongoCondition(clause: FilterClause): unknown {
  switch (clause.op) {
    case "eq":
      return clause.value;
    // `ne` / `nin`: null and missing never match (SQL three-valued logic, the IR's rule).
    case "ne":
      return clause.value === null ? { $ne: null } : { $nin: [clause.value, null] };
    case "nin":
      return { $nin: clause.values.includes(null) ? [...clause.values] : [...clause.values, null] };
    case "in":
      return { $in: [...clause.values] };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { [`$${clause.op}`]: clause.value };
    case "exists":
      return clause.value ? { $ne: null } : null;
    case "contains":
      return { $regex: escapeRegex(clause.text), $options: "i" };
    case "startsWith":
      return { $regex: `^${escapeRegex(clause.text)}`, $options: "i" };
    case "endsWith":
      return { $regex: `${escapeRegex(clause.text)}$`, $options: "i" };
    case "ieq":
      return { $regex: `^${escapeRegex(clause.text)}$`, $options: "i" };
    case "regex":
      return clause.flags
        ? { $regex: clause.pattern, $options: clause.flags }
        : { $regex: clause.pattern };
  }
}

/** Merge conditions on one field into one operator object; `$and` when an operator repeats. */
function mergeByField(
  clauses: readonly FilterClause[],
  condition: (clause: FilterClause) => unknown,
  eqToken: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const overflow: Record<string, unknown>[] = [];
  for (const clause of clauses) {
    const next = condition(clause);
    if (!(clause.field in merged)) {
      merged[clause.field] = next;
      continue;
    }
    const left = asOperators(merged[clause.field], eqToken);
    const right = asOperators(next, eqToken);
    if (left && right && !Object.keys(right).some((op) => op in left)) {
      merged[clause.field] = { ...left, ...right };
    } else {
      overflow.push({ [clause.field]: next });
    }
  }
  return overflow.length > 0 ? { ...merged, $and: overflow } : merged;
}

function asOperators(condition: unknown, eqToken: string): Record<string, unknown> | undefined {
  if (condition === null || Array.isArray(condition) || condition instanceof Date) {
    return condition === null ? undefined : { [eqToken]: condition };
  }
  if (typeof condition === "object") return condition as Record<string, unknown>;
  return { [eqToken]: condition };
}

export const MONGO_DIALECT: FilterDialect = {
  emit: (clauses) => mergeByField(clauses, mongoCondition, "$eq"),
  tokens: ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$regex", "$options", "$and"],
};

/**
 * Store-neutral: `{ field: { <op>: value } }` with the grammar's own operator names, for a host
 * that compiles the canonical clauses itself.
 */
export const NEUTRAL_DIALECT: FilterDialect = {
  emit: (clauses) =>
    mergeByField(
      clauses,
      (clause) => {
        switch (clause.op) {
          case "in":
          case "nin":
            return { [clause.op]: clause.values };
          case "contains":
          case "startsWith":
          case "endsWith":
          case "ieq":
            return { [clause.op]: clause.text };
          case "regex":
            return clause.flags
              ? { regex: clause.pattern, flags: clause.flags }
              : { regex: clause.pattern };
          default:
            return { [clause.op]: clause.value };
        }
      },
      "eq",
    ),
  tokens: [
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "nin",
    "exists",
    "contains",
    "startsWith",
    "endsWith",
    "ieq",
    "regex",
    "flags",
    "$and",
  ],
};
