/**
 * Repository-boundary filter normalization — make arc's policy-filter dialect
 * explicit Filter IR across every kit.
 *
 * ## The problem this solves
 *
 * Arc's permission helpers emit row-level policy filters in a Mongo-style
 * `$`-operator dialect: `requireOwnership` → `{ ownerId }`, multiTenant →
 * `{ organizationId }`, `requireGrant` → `{ $or: [{ ownerId }, { _id: { $in } }] }`,
 * and `conjoinPolicyFilters` → `{ $and: [...] }` for AND-composition. Arc's
 * default query parser also emits this dialect (`?price[gte]=40` →
 * `{ price: { $gte: 40 } }`).
 *
 * Historically arc `Object.assign`'d these `$`-records straight into the
 * compound filter handed to `repository.getOne` / `getAll`. That works for
 * MongoKit (it compiles `$`-records natively) but BREAKS non-Mongo kits: the
 * SQLiteKit / PGKit query path runs the record through repo-core's
 * `recordToFilter`, which is the BARE-operator query-shorthand normalizer and
 * treats `$and` / `$or` / `$in` as literal field names — so a composed policy
 * either throws (`$and` → "no column `$and`") or silently matches nothing
 * (`$in` → literal compare).
 *
 * ## The fix
 *
 * repo-core already owns the canonical converter for exactly this dialect:
 * {@link policyRecordToFilter} ("the arc-policy-filter dialect — `$`-prefixed,
 * with logical operators"). It turns a `$`-record into the portable {@link Filter}
 * IR, which each kit compiles when its storage model supports the operation and
 * otherwise rejects explicitly. That is the same IR the
 * in-memory matcher (`matchesRecordFilter`) already uses, so DB-level and
 * in-memory enforcement agree by construction.
 *
 * {@link toRepositoryFilter} converts a compound filter to that IR **only when it
 * actually contains `$`-operators**. The overwhelmingly common case — flat
 * equality filters (`{ _id, organizationId }`) — is returned byte-for-byte
 * unchanged, so there is zero behavior change (and zero perf cost) for it. Only
 * the `$and`/`$or`/`$gte`/… paths take the IR branch.
 */

import type { Filter } from "@classytic/repo-core/filter";
import { policyRecordToFilter } from "@classytic/repo-core/filter";
import { arcLog } from "../logger/index.js";
import type { AnyRecord } from "../types/index.js";

const NATIVE_FILTER_DIALECT: unique symbol = Symbol.for(
  "@classytic/arc/native-filter-dialect",
) as never;

export type NativePolicyFilter<Dialect extends string = string> = AnyRecord & {
  readonly [NATIVE_FILTER_DIALECT]: Dialect;
};

/**
 * Mark a server-owned policy as intentionally adapter-native. This is an
 * explicit escape hatch for semantics absent from repo-core's universal IR
 * (for example MongoDB `$elemMatch`). Never apply it to client input.
 */
export function nativePolicyFilter<const Dialect extends string>(
  dialect: Dialect,
  record: AnyRecord,
): NativePolicyFilter<Dialect> {
  return Object.freeze({
    ...record,
    [NATIVE_FILTER_DIALECT]: dialect,
  }) as NativePolicyFilter<Dialect>;
}

function nativeDialects(value: unknown, found = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") return found;
  const dialect = (value as { [NATIVE_FILTER_DIALECT]?: unknown })[NATIVE_FILTER_DIALECT];
  if (typeof dialect === "string") found.add(dialect);
  if (Array.isArray(value)) {
    for (const entry of value) nativeDialects(entry, found);
  } else {
    for (const entry of Object.values(value as AnyRecord)) nativeDialects(entry, found);
  }
  return found;
}

function stripNativeMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNativeMarkers);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const out: AnyRecord = {};
  for (const [key, entry] of Object.entries(value as AnyRecord))
    out[key] = stripNativeMarkers(entry);
  return out;
}

const log = arcLog("repository-filter");
let warnedUnconvertible = false;

/** True for a `{ $op: ... }` operator object (all keys `$`-prefixed). */
function isOperatorObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value) || value instanceof Date) return false;
  const keys = Object.keys(value as object);
  return keys.length > 0 && keys.some((k) => k.startsWith("$"));
}

/**
 * Does this compound filter contain any `$`-operator (top-level logical like
 * `$and`/`$or`, or a field operator object like `{ $in: [...] }`)? If not, it is
 * pure flat equality and portable as-is.
 */
export function filterHasDollarOperator(record: AnyRecord): boolean {
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("$")) return true;
    if (isOperatorObject(value)) return true;
  }
  return false;
}

/**
 * Normalize a compound query/policy filter for the repository layer. Flat
 * equality records pass through unchanged; anything carrying `$`-operators is
 * converted to repo-core {@link Filter} IR so semantics stay explicit. Common
 * operators compile identically across kits; capability-specific operators
 * such as array-element matching fail loudly on adapters that cannot model them.
 */
export function toRepositoryFilter(record: AnyRecord): AnyRecord | Filter {
  const dialects = nativeDialects(record);
  if (dialects.size > 0) {
    if (dialects.size > 1) {
      throw new Error(
        `Cannot compose native policy-filter dialects: ${[...dialects].sort().join(", ")}`,
      );
    }
    return stripNativeMarkers(record) as AnyRecord;
  }
  if (!filterHasDollarOperator(record)) return record;
  try {
    return policyRecordToFilter(record);
  } catch (err) {
    // `policyRecordToFilter` fails loud on operators outside arc's policy
    // dialect (e.g. a URL filter using Mongo `$elemMatch` / `$all`). Arc's OWN
    // security-policy operators ($and/$or/$in/$eq/comparisons) are all within
    // the supported set, so they always convert; only exotic client query
    // operators reach here. Fall back to the raw record — MongoKit compiles it
    // natively (unchanged behavior); a non-Mongo kit that can't was already
    // unable to, so this is never a regression. Never a 500 from normalization.
    if (!warnedUnconvertible) {
      warnedUnconvertible = true;
      log.warn(
        "A `$`-operator filter could not be normalized to portable Filter IR " +
          "(operator outside arc's policy dialect). Passing the raw record to the " +
          "repository — MongoKit handles it; non-Mongo kits may not. " +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    return record;
  }
}
