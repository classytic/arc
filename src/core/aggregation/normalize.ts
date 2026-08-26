/**
 * Pure normalization for resource aggregations — data-in/data-out, no
 * validation side effects. `validate.ts` owns every thrown
 * `ArcAggregationConfigError`; these helpers only reshape config:
 *
 *   1. **Measure shorthand → IR** — `'sum:totalPrice'` becomes
 *      `{ op: 'sum', field: 'totalPrice' }`.
 *   2. **`groupBy` string → string[]** — internal callers always see
 *      array form so the request handler doesn't branch on shape.
 *   3. **Lookup-alias / blocked-field collection** — derived sets the
 *      validators cross-check field references against.
 *   4. **Limit-policy resolution + request-time IR compilation** —
 *      `compileAggRequest` builds the canonical `AggRequest`.
 */

import type { LookupSpec } from "@classytic/repo-core/lookup";
import type {
  AggDateBucket,
  AggExecutionHints,
  AggMeasure,
  AggRequest,
  AggTopN,
} from "@classytic/repo-core/repository";
import type { AnyRecord, RouteSchemaOptions } from "../../types/index.js";
import type { AggregationConfig } from "./types.js";

/**
 * Normalized internal shape — same fields as `AggregationConfig` but
 * with shorthand measures expanded to IR. Internal use only; public
 * config keeps the sugar for ergonomics.
 */
export interface NormalizedAggregation {
  readonly name: string;
  readonly base: AggregationConfig; // original, for permissions / cache / safety knobs
  readonly compiled: {
    /** AggRequest skeleton — caller filter is ANDed at request time. */
    filter?: AnyRecord;
    lookups?: readonly LookupSpec[];
    groupBy?: readonly string[];
    dateBuckets?: Record<string, AggDateBucket>;
    measures: Record<string, AggMeasure>;
    having?: AnyRecord;
    sort?: Record<string, 1 | -1>;
    limit?: number;
    topN?: AggTopN;
    /**
     * URL-driven limit policy. Present when the host declared
     * `defaultLimit` (which opts the aggregation into reading
     * `?limit=N` from the URL). Absent when the host uses the static
     * `limit` form (or no limit at all).
     */
    limitPolicy?: { defaultLimit: number; maxLimit: number };
  };
}

/**
 * Framework cap on URL-driven aggregation limits when the host opts
 * in to `defaultLimit` without explicit `maxLimit`. Set to the same
 * order of magnitude as a "large dashboard page" — bigger than every
 * realistic grouped tile, smaller than "we returned the whole table."
 */
const AGG_FRAMEWORK_MAX_LIMIT = 1000;

export function parseMeasureShorthand(s: string): AggMeasure | null {
  if (s === "count") return { op: "count" };
  const colon = s.indexOf(":");
  if (colon < 0) return null;
  const op = s.slice(0, colon);
  const rest = s.slice(colon + 1);
  if (!rest) return null;

  // Percentile takes a third segment: `percentile:<field>:<p>`. Split
  // on the LAST colon so field names containing `:` (rare but legal)
  // round-trip cleanly. Other ops never have a third segment — the
  // single-colon split below handles them.
  if (op === "percentile") {
    const lastColon = rest.lastIndexOf(":");
    if (lastColon < 0) return null;
    const field = rest.slice(0, lastColon);
    const pStr = rest.slice(lastColon + 1);
    if (!field || !pStr) return null;
    const p = Number(pStr);
    if (!Number.isFinite(p)) return null;
    return { op: "percentile", field, p };
  }

  switch (op) {
    case "count":
      return { op: "count", field: rest };
    case "countDistinct":
      return { op: "countDistinct", field: rest };
    case "sum":
      return { op: "sum", field: rest };
    case "avg":
      return { op: "avg", field: rest };
    case "min":
      return { op: "min", field: rest };
    case "max":
      return { op: "max", field: rest };
    default:
      return null;
  }
}

export function normalizeGroupBy(groupBy: string | readonly string[] | undefined): string[] {
  if (!groupBy) return [];
  if (typeof groupBy === "string") return [groupBy];
  return [...groupBy];
}

export function collectLookupAliases(lookups: readonly LookupSpec[] | undefined): Set<string> {
  const aliases = new Set<string>();
  if (!lookups) return aliases;
  for (const lookup of lookups) {
    aliases.add(lookup.as ?? lookup.from);
  }
  return aliases;
}

/**
 * Collect fields that aggregation MUST NOT reference.
 *
 * Default rule: only `hidden: true` blocks. `hidden` means the field is
 * omitted from list/get responses, so exposing it via aggregation would
 * leak data the client can't otherwise see. `systemManaged` is a write
 * rule (server stamps the value, clients can't PATCH it) — those fields
 * are still visible per-row, so aggregating them leaks nothing.
 *
 * Two opt-in overrides via `ArcFieldRule.aggregable`:
 *   - `aggregable: false` — explicit deny on a visible field (rare; use
 *     when the per-row value is fine but the across-row distribution is
 *     itself sensitive).
 *   - `aggregable: true` — explicit allow, even on a `hidden` field
 *     (escape hatch — caller asserts cardinality leak isn't a concern).
 */
export function collectBlockedFields(schemaOptions: RouteSchemaOptions | undefined): Set<string> {
  const blocked = new Set<string>();
  const fieldRules = schemaOptions?.fieldRules;
  if (!fieldRules) return blocked;
  for (const [field, rules] of Object.entries(fieldRules)) {
    if (!rules) continue;
    if (rules.aggregable === true) continue; // explicit allow
    if (rules.aggregable === false) {
      blocked.add(field); // explicit deny
      continue;
    }
    if (rules.hidden) blocked.add(field);
  }
  return blocked;
}

/**
 * Resolve the URL-driven limit policy into a concrete `{ default, max }`
 * pair. Returns `undefined` when the host uses the static `limit` form
 * (or no limit at all) — the request handler reads the absence to know
 * "do not parse `?limit=N` from the URL."
 */
export function resolveLimitPolicy(
  config: AggregationConfig,
): { defaultLimit: number; maxLimit: number } | undefined {
  if (config.defaultLimit === undefined) return undefined;
  return {
    defaultLimit: config.defaultLimit,
    maxLimit: config.maxLimit ?? AGG_FRAMEWORK_MAX_LIMIT,
  };
}

/**
 * Resolve the effective per-request `limit` — three cases:
 *
 *   1. Host declared static `limit` → URL `?limit` ignored, static wins.
 *   2. Host declared `defaultLimit` → parse `?limit=N`, cap at
 *      `maxLimit`, fall back to default on absent / invalid input.
 *   3. Host declared neither → returns `undefined` (no limit applied,
 *      preserves pre-2.16.1 behavior).
 */
function resolveAggRequestLimit(
  normalized: NormalizedAggregation,
  query: Record<string, unknown>,
): number | undefined {
  const policy = normalized.compiled.limitPolicy;
  if (!policy) return normalized.compiled.limit;

  const raw = query.limit;
  if (raw === undefined || raw === "") return policy.defaultLimit;

  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return policy.defaultLimit;

  return Math.min(Math.floor(parsed), policy.maxLimit);
}

/** Compile to canonical `AggRequest` for `repo.aggregate()` at request time. */
export function compileAggRequest(
  normalized: NormalizedAggregation,
  callerFilter: AnyRecord,
  tenantOptions: AnyRecord,
  query?: Record<string, unknown>,
): AggRequest {
  const baseFilter = normalized.compiled.filter ?? {};

  // Tenant scope is DELIBERATELY NOT merged into `aggReq.filter`. Arc
  // is DB-agnostic — it knows the orgId as a JS string from request
  // scope, but it has no idea whether the kit stores it as an
  // ObjectId (mongokit `fieldType: 'objectId'`), a UUID (pgkit), a
  // text column (sqlitekit), or something else. The kit's
  // multi-tenant plugin owns that type contract.
  //
  // Arc threads tenant through `tenantOptions` — the second arg of
  // `repo.aggregate(req, options)`. The kit's `before:aggregate` hook
  // reads `context.organizationId` from there, casts to its native
  // type, and injects into the right slot (`context.query` /
  // `context.filters`). Mongokit's `_injectPolicyScopeIntoAgg` then
  // merges that into `req.filter` for the actual `$match`.
  //
  // Earlier 2.15.x called `extractTenantFilter(tenantOptions)` here
  // and produced a string clause. Mongokit's plugin produced the
  // matching ObjectId clause. The two AND-ed to zero matches because
  // Mongo doesn't auto-coerce string ↔ ObjectId in `$match`. Lesson:
  // type-coercion belongs in the kit, not the framework.
  void tenantOptions;
  const filter: AnyRecord = {
    ...baseFilter,
    ...callerFilter,
  };

  const executionHints = buildExecutionHints(normalized.base);
  const cache = buildCacheOptions(normalized.base);
  const limit = query ? resolveAggRequestLimit(normalized, query) : normalized.compiled.limit;

  const req: AggRequest = {
    measures: normalized.compiled.measures,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(normalized.compiled.lookups ? { lookups: normalized.compiled.lookups } : {}),
    ...(normalized.compiled.groupBy ? { groupBy: normalized.compiled.groupBy } : {}),
    ...(normalized.compiled.dateBuckets ? { dateBuckets: normalized.compiled.dateBuckets } : {}),
    ...(normalized.compiled.having ? { having: normalized.compiled.having } : {}),
    ...(normalized.compiled.sort ? { sort: normalized.compiled.sort } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(normalized.compiled.topN ? { topN: normalized.compiled.topN } : {}),
    ...(executionHints ? { executionHints } : {}),
    ...(cache ? { cache } : {}),
  };

  return req;
}

/**
 * Translate the host's declarative `cache:` config into the TanStack-
 * shaped `CacheOptions` repo-core's unified cache plugin reads from
 * `req.cache`. The plugin handles SWR semantics, version-bump
 * invalidation, and tag side-index — arc just declares the policy.
 *
 * No translation needed when the host disabled cache (returns
 * undefined, kit falls through to a non-cached call).
 */
function buildCacheOptions(config: AggregationConfig): AggregationConfig["cache"] | undefined {
  const c = config.cache;
  if (!c) return undefined;
  // Default `swr: true` for aggregations — dashboards almost always
  // benefit from stale-serve + bg-refresh. Hosts can override via
  // explicit `swr: false`.
  return {
    ...(c.staleTime !== undefined ? { staleTime: c.staleTime } : {}),
    ...(c.gcTime !== undefined ? { gcTime: c.gcTime } : {}),
    ...(c.tags ? { tags: c.tags } : {}),
    swr: c.swr ?? true,
  } as AggregationConfig["cache"];
}

/**
 * Map arc's declarative knobs onto repo-core's portable `AggExecutionHints`.
 * Kits that don't honor a given hint silently ignore it (per IR contract);
 * mongokit threads `maxTimeMs` → `maxTimeMS` and `indexHint` → `aggregate.option({ hint })`.
 */
function buildExecutionHints(config: AggregationConfig): AggExecutionHints | undefined {
  const hints: AggExecutionHints = {};
  if (typeof config.timeout === "number" && config.timeout > 0) {
    hints.maxTimeMs = config.timeout;
  }
  if (config.indexHint && config.indexHint.leadingKeys.length > 0) {
    // Mongo's `hint` accepts `{ field: 1 }` — synthesize the canonical
    // ascending-leading-keys shape. Sqlitekit ignores; future kits map
    // into their dialect.
    const hintObj: Record<string, 1> = {};
    for (const key of config.indexHint.leadingKeys) hintObj[key] = 1;
    hints.indexHint = hintObj;
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}
