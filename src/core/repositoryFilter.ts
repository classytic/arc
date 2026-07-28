/**
 * Repository-boundary filter normalization — make arc's policy-filter dialect
 * portable across EVERY kit.
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
 * IR, which EVERY kit compiles (MongoKit via `compileFilterToMongo`, SQLiteKit /
 * PGKit via `recordToFilter`'s IR pass-through). That is the same IR the
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
 * converted to the portable repo-core {@link Filter} IR so it compiles
 * identically on Mongo, SQLite, Postgres, and custom adapters.
 */
export function toRepositoryFilter(record: AnyRecord): AnyRecord | Filter {
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
