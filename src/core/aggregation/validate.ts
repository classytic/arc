/**
 * Boot-time validation + normalization for resource aggregations.
 *
 * Runs once at `defineResource()` time (NOT per-request). Every
 * misconfig surfaces as a thrown `ArcConfigError` BEFORE traffic ever
 * hits the route — we want loud failures at startup, not at the first
 * dashboard request in production.
 *
 * Validations:
 *
 *   1. **Permissions declared** — `aggregations[name].permissions` is
 *      required (no default-allow).
 *   2. **Measures non-empty** — `measures: {}` is a wiring bug.
 *   3. **Adapter ships `aggregate()`** — kit feature-detect; refusal
 *      fails loud.
 *   4. **Field references** — `groupBy`, measure fields, `sort` keys,
 *      and joined-alias paths cross-checked against schema +
 *      `LookupSpec` aliases. Hidden / system-managed fields rejected
 *      to prevent unintended exposure via aggregation cardinality.
 *   5. **Index hint** — when set, recorded for later (per-kit
 *      introspection in a future milestone).
 *
 * Normalization:
 *
 *   1. **Measure shorthand → IR** — `'sum:totalPrice'` becomes
 *      `{ op: 'sum', field: 'totalPrice' }`.
 *   2. **`groupBy` string → string[]** — internal callers always see
 *      array form so the request handler doesn't branch on shape.
 */

import type { LookupSpec } from "@classytic/repo-core/lookup";
import type {
  AggDateBucket,
  AggDateBucketUnit,
  AggExecutionHints,
  AggMeasure,
  AggRequest,
  AggTopN,
} from "@classytic/repo-core/repository";
import type { AnyRecord, RouteSchemaOptions } from "../../types/index.js";
import type {
  AggMeasureInput,
  AggMeasureShorthand,
  AggregationConfig,
  AggregationsMap,
} from "./types.js";

/** Thrown on aggregation misconfig at boot time. */
export class ArcAggregationConfigError extends Error {
  override readonly name = "ArcAggregationConfigError";
}

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
  };
}

/**
 * Validate + normalize all aggregations on a resource. Throws on first
 * misconfig with the offending aggregation name in the message — hosts
 * see exactly which entry needs fixing.
 *
 * Adapter feature-detection runs only when an `adapter` is present;
 * boot order means the controller's `repository` may be the
 * `RepositoryLike` shape. Best-effort `'aggregate' in repo` check covers
 * mongokit / sqlitekit; missing `aggregate()` deferred to request time
 * with a clear 501 (handled in the request handler).
 */
export function validateAggregations(
  resourceName: string,
  aggregations: AggregationsMap,
  schemaOptions: RouteSchemaOptions | undefined,
): NormalizedAggregation[] {
  const out: NormalizedAggregation[] = [];
  const blockedFields = collectBlockedFields(schemaOptions);

  for (const [name, config] of Object.entries(aggregations)) {
    if (!isValidAggregationName(name)) {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation key "${name}" is invalid — ` +
          `keys map to URL segments and must be alphanumeric or underscore/hyphen.`,
      );
    }

    if (typeof config.permissions !== "function") {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation "${name}" is missing a "permissions" check. ` +
          `Aggregations must declare permissions explicitly — no default-allow. ` +
          `Use a permission helper from @classytic/arc/permissions.`,
      );
    }

    if (!config.measures || Object.keys(config.measures).length === 0) {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation "${name}" has no measures. ` +
          `An empty "measures" map is a wiring bug — at least one measure is required.`,
      );
    }

    const lookupAliases = collectLookupAliases(config.lookups);
    const measures = compileMeasures(resourceName, name, config.measures);
    const groupBy = normalizeGroupBy(config.groupBy);
    const bucketAliases = config.dateBuckets ? Object.keys(config.dateBuckets) : [];

    if (config.dateBuckets) {
      validateDateBuckets({
        resourceName,
        aggregationName: name,
        dateBuckets: config.dateBuckets,
        groupBy,
        measures,
        lookupAliases,
        blockedFields,
      });
    }

    validateFieldReferences({
      resourceName,
      aggregationName: name,
      groupBy,
      measures,
      sort: config.sort,
      having: config.having,
      lookupAliases,
      blockedFields,
      bucketAliases,
    });

    if (config.topN) {
      validateTopNConfig(resourceName, name, config.topN, groupBy, measures, bucketAliases);
    }

    out.push({
      name,
      base: config,
      compiled: {
        filter: config.filter,
        lookups: config.lookups,
        groupBy: groupBy.length > 0 ? groupBy : undefined,
        dateBuckets: config.dateBuckets,
        measures,
        having: config.having,
        sort: config.sort,
        limit: config.limit,
        topN: config.topN,
      },
    });
  }

  return out;
}

/**
 * Adapter feature-detect for `aggregate()`. Called at boot when the
 * repository instance is available. Returns `true` when the kit ships
 * `aggregate`; `false` when missing.
 *
 * `materialized`-only aggregations bypass this check at the request
 * handler — they never call `repo.aggregate`.
 */
export function adapterSupportsAggregate(repo: unknown): boolean {
  if (!repo || typeof repo !== "object") return false;
  const r = repo as Record<string, unknown>;
  return typeof r.aggregate === "function";
}

/** Compile to canonical `AggRequest` for `repo.aggregate()` at request time. */
export function compileAggRequest(
  normalized: NormalizedAggregation,
  callerFilter: AnyRecord,
  tenantOptions: AnyRecord,
): AggRequest {
  const baseFilter = normalized.compiled.filter ?? {};
  const tenantFilter = extractTenantFilter(tenantOptions);

  // Compose: tenant FIRST (LEFT-most for index alignment) → host base → caller
  const filter: AnyRecord = {
    ...tenantFilter,
    ...baseFilter,
    ...callerFilter,
  };

  const executionHints = buildExecutionHints(normalized.base);
  const cache = buildCacheOptions(normalized.base);

  const req: AggRequest = {
    measures: normalized.compiled.measures,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(normalized.compiled.lookups ? { lookups: normalized.compiled.lookups } : {}),
    ...(normalized.compiled.groupBy ? { groupBy: normalized.compiled.groupBy } : {}),
    ...(normalized.compiled.dateBuckets ? { dateBuckets: normalized.compiled.dateBuckets } : {}),
    ...(normalized.compiled.having ? { having: normalized.compiled.having } : {}),
    ...(normalized.compiled.sort ? { sort: normalized.compiled.sort } : {}),
    ...(normalized.compiled.limit !== undefined ? { limit: normalized.compiled.limit } : {}),
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
 * Boot validation for `topN`. Mirrors the contract mongokit + sqlitekit
 * enforce at request time — both kits check the same three rules and
 * throw with kit-prefixed messages. Running them at boot gives hosts
 * the misconfig surface BEFORE the first dashboard request, with the
 * offending aggregation name included for debugging. Same logic /
 * messages stay aligned across the kits and arc.
 */
function validateTopNConfig(
  resource: string,
  aggregation: string,
  topN: AggTopN,
  groupBy: readonly string[],
  measures: Record<string, AggMeasure>,
  bucketAliases: readonly string[],
): void {
  if (!Number.isInteger(topN.limit) || topN.limit <= 0) {
    throw new ArcAggregationConfigError(
      `Resource "${resource}" aggregation "${aggregation}" topN.limit must be a positive integer — got ${String(topN.limit)}.`,
    );
  }
  if (!topN.sortBy || Object.keys(topN.sortBy).length === 0) {
    throw new ArcAggregationConfigError(
      `Resource "${resource}" aggregation "${aggregation}" topN.sortBy must declare at least one ranking field.`,
    );
  }
  const partitionList = Array.isArray(topN.partitionBy) ? topN.partitionBy : [topN.partitionBy];
  if (partitionList.length === 0) {
    throw new ArcAggregationConfigError(
      `Resource "${resource}" aggregation "${aggregation}" topN.partitionBy must declare at least one partition column.`,
    );
  }
  const validKeys = new Set<string>([...groupBy, ...bucketAliases, ...Object.keys(measures)]);
  for (const key of partitionList) {
    if (!validKeys.has(key)) {
      throw new ArcAggregationConfigError(
        `Resource "${resource}" aggregation "${aggregation}" topN.partitionBy "${key}" ` +
          `is not a groupBy field, dateBucket alias, or measure alias. ` +
          `Available: ${[...validKeys].join(", ") || "(none — declare groupBy, dateBuckets, or measures)"}.`,
      );
    }
  }
}

interface DateBucketValidationInput {
  resourceName: string;
  aggregationName: string;
  dateBuckets: Record<string, AggDateBucket>;
  groupBy: readonly string[];
  measures: Record<string, AggMeasure>;
  lookupAliases: Set<string>;
  blockedFields: Set<string>;
}

const VALID_BUCKET_UNITS: ReadonlySet<AggDateBucketUnit> = new Set([
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
]);

const CUSTOM_BIN_UNIT_BLOCKLIST: ReadonlySet<string> = new Set(["quarter", "year"]);

/**
 * Validate `dateBuckets`. Catches the two classes of misconfig kits
 * already throw on at runtime — alias collisions and field-rule
 * violations — at boot, with the offending aggregation name in the
 * message.
 *
 * Rules (parity with mongokit's `validateBucketAliases` + sqlitekit's
 * `compileDateBucket` field-rule pass):
 *   1. Bucket alias MUST NOT collide with a groupBy field or measure
 *      alias — output row would have an ambiguous key.
 *   2. Bucket `field` (resolves to a base column or joined-alias path)
 *      must NOT be hidden / systemManaged.
 *   3. Custom-bin form (`{ every, unit }`): `every` is a positive
 *      integer; `unit` is in the supported set (minute/hour/day/week/
 *      month — quarter and year aren't valid in custom-bin form).
 */
function validateDateBuckets(input: DateBucketValidationInput): void {
  const {
    resourceName,
    aggregationName,
    dateBuckets,
    groupBy,
    measures,
    lookupAliases,
    blockedFields,
  } = input;

  const groupBySet = new Set(groupBy);
  const measureAliases = new Set(Object.keys(measures));

  for (const [alias, bucket] of Object.entries(dateBuckets)) {
    if (groupBySet.has(alias)) {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation "${aggregationName}" dateBucket alias "${alias}" ` +
          `collides with a groupBy field. Pick a unique alias.`,
      );
    }
    if (measureAliases.has(alias)) {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation "${aggregationName}" dateBucket alias "${alias}" ` +
          `collides with a measure alias. Pick a unique alias.`,
      );
    }

    // Field-rule check — same surface as groupBy / measure.field.
    assertBucketFieldAllowed({
      resourceName,
      aggregationName,
      alias,
      field: bucket.field,
      lookupAliases,
      blockedFields,
    });

    // Interval shape check.
    if (typeof bucket.interval === "string") {
      if (!VALID_BUCKET_UNITS.has(bucket.interval)) {
        throw new ArcAggregationConfigError(
          `Resource "${resourceName}" aggregation "${aggregationName}" dateBucket "${alias}" ` +
            `interval "${bucket.interval}" is not a recognized unit. ` +
            `Use one of: ${[...VALID_BUCKET_UNITS].join(", ")}.`,
        );
      }
      continue;
    }

    // Custom-bin object form.
    const { every, unit } = bucket.interval;
    if (!Number.isInteger(every) || every <= 0) {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation "${aggregationName}" dateBucket "${alias}" ` +
          `interval.every must be a positive integer — got ${String(every)}.`,
      );
    }
    if (!VALID_BUCKET_UNITS.has(unit) || CUSTOM_BIN_UNIT_BLOCKLIST.has(unit)) {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation "${aggregationName}" dateBucket "${alias}" ` +
          `interval.unit "${unit}" is not valid in custom-bin form. ` +
          `Use minute / hour / day / week / month (quarter and year aren't supported as custom bins).`,
      );
    }
  }
}

interface BucketFieldCheckInput {
  resourceName: string;
  aggregationName: string;
  alias: string;
  field: string;
  lookupAliases: Set<string>;
  blockedFields: Set<string>;
}

function assertBucketFieldAllowed(input: BucketFieldCheckInput): void {
  const { resourceName, aggregationName, alias, field, lookupAliases, blockedFields } = input;
  const dot = field.indexOf(".");
  if (dot > 0) {
    // Dotted path: either a lookup-aliased ref (`customer.name`) or a nested
    // embedded-document field (`totals.grandTotal.amount`). When the head
    // segment matches a declared lookup we trust the join; otherwise it's a
    // nested doc path on the base resource and we only enforce blocked-field
    // policy on the head segment.
    const a = field.slice(0, dot);
    if (lookupAliases.has(a)) return;
    if (blockedFields.has(a)) {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation "${aggregationName}" dateBucket "${alias}" ` +
          `references field "${field}" whose root "${a}" is marked hidden or systemManaged ` +
          `in schemaOptions.fieldRules. Bucketing on hidden fields would leak temporal info.`,
      );
    }
    return;
  }
  if (blockedFields.has(field)) {
    throw new ArcAggregationConfigError(
      `Resource "${resourceName}" aggregation "${aggregationName}" dateBucket "${alias}" ` +
        `references field "${field}", but the field is marked hidden or systemManaged ` +
        `in schemaOptions.fieldRules. Bucketing on hidden fields would leak temporal info.`,
    );
  }
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

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function isValidAggregationName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

function compileMeasures(
  resource: string,
  aggregation: string,
  measures: Record<string, AggMeasureInput>,
): Record<string, AggMeasure> {
  const out: Record<string, AggMeasure> = {};
  for (const [alias, input] of Object.entries(measures)) {
    out[alias] = expandMeasure(input, resource, aggregation, alias);
  }
  return out;
}

function expandMeasure(
  input: AggMeasureInput,
  resource: string,
  aggregation: string,
  alias: string,
): AggMeasure {
  let measure: AggMeasure;
  if (typeof input === "object" && input !== null) {
    measure = input;
  } else if (typeof input === "string") {
    const expanded = parseMeasureShorthand(input as AggMeasureShorthand);
    if (!expanded) {
      throw new ArcAggregationConfigError(
        `Resource "${resource}" aggregation "${aggregation}" measure "${alias}" ` +
          `has invalid shorthand "${input}". ` +
          `Use 'count', 'count:field', 'sum:field', 'avg:field', 'min:field', ` +
          `'max:field', 'countDistinct:field', or 'percentile:field:p' (p ∈ [0, 1]).`,
      );
    }
    measure = expanded;
  } else {
    throw new ArcAggregationConfigError(
      `Resource "${resource}" aggregation "${aggregation}" measure "${alias}" ` +
        `is not a string or object: got ${typeof input}.`,
    );
  }
  validateMeasure(measure, resource, aggregation, alias);
  return measure;
}

function parseMeasureShorthand(s: string): AggMeasure | null {
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

/**
 * Per-measure boot validation. Currently only `percentile` carries a
 * numeric constraint — `p ∈ [0, 1]` matches mongokit's request-time
 * check (and SQL's `PERCENTILE_CONT` semantics). Running it at boot
 * surfaces the misconfig with the offending aggregation + measure
 * alias instead of a kit-side error at first traffic.
 */
function validateMeasure(
  measure: AggMeasure,
  resource: string,
  aggregation: string,
  alias: string,
): void {
  if (measure.op === "percentile") {
    if (!Number.isFinite(measure.p) || measure.p < 0 || measure.p > 1) {
      throw new ArcAggregationConfigError(
        `Resource "${resource}" aggregation "${aggregation}" measure "${alias}" ` +
          `has invalid percentile p=${String(measure.p)} — must be a finite number in [0, 1] ` +
          `(e.g. 0.5 for median, 0.95 for P95).`,
      );
    }
  }
}

function normalizeGroupBy(groupBy: string | readonly string[] | undefined): string[] {
  if (!groupBy) return [];
  if (typeof groupBy === "string") return [groupBy];
  return [...groupBy];
}

function collectLookupAliases(lookups: readonly LookupSpec[] | undefined): Set<string> {
  const aliases = new Set<string>();
  if (!lookups) return aliases;
  for (const lookup of lookups) {
    aliases.add(lookup.as ?? lookup.from);
  }
  return aliases;
}

function collectBlockedFields(schemaOptions: RouteSchemaOptions | undefined): Set<string> {
  const blocked = new Set<string>();
  const fieldRules = schemaOptions?.fieldRules;
  if (!fieldRules) return blocked;
  for (const [field, rules] of Object.entries(fieldRules)) {
    if (!rules) continue;
    if (rules.hidden || rules.systemManaged) blocked.add(field);
  }
  return blocked;
}

interface FieldRefValidationInput {
  resourceName: string;
  aggregationName: string;
  groupBy: readonly string[];
  measures: Record<string, AggMeasure>;
  sort: Record<string, 1 | -1> | undefined;
  having: AnyRecord | undefined;
  lookupAliases: Set<string>;
  blockedFields: Set<string>;
  bucketAliases: readonly string[];
}

/**
 * Reject:
 *   - groupBy / measure.field / sort key referencing a hidden /
 *     systemManaged field
 *   - dotted-path references (`alias.field`) where `alias` doesn't
 *     match a `LookupSpec.as` (or `from` default)
 *
 * Sort keys may also reference measure aliases, groupBy fields, or
 * dateBucket aliases (all auto-valid — already validated upstream) —
 * those branches accept without further checks.
 */
function validateFieldReferences(input: FieldRefValidationInput): void {
  const { groupBy, measures, sort, bucketAliases } = input;

  for (const key of groupBy) {
    assertFieldAllowed("groupBy", key, input);
  }

  for (const [alias, measure] of Object.entries(measures)) {
    if ("field" in measure && measure.field) {
      assertFieldAllowed(`measures.${alias}`, measure.field, input);
    }
  }

  if (sort) {
    const measureAliases = new Set(Object.keys(measures));
    const groupBySet = new Set(groupBy);
    const bucketSet = new Set(bucketAliases);
    for (const key of Object.keys(sort)) {
      if (measureAliases.has(key) || groupBySet.has(key) || bucketSet.has(key)) continue;
      assertFieldAllowed(`sort.${key}`, key, input);
    }
  }
}

function assertFieldAllowed(context: string, ref: string, input: FieldRefValidationInput): void {
  const { resourceName, aggregationName, lookupAliases, blockedFields } = input;
  const dot = ref.indexOf(".");
  if (dot > 0) {
    // Dotted path: either a lookup-aliased ref (`customer.name`) or a nested
    // embedded-document field (`totals.grandTotal.amount`). When the head
    // segment matches a declared lookup we trust the join; otherwise it's a
    // nested doc path on the base resource and we only enforce blocked-field
    // policy on the head segment.
    const alias = ref.slice(0, dot);
    if (lookupAliases.has(alias)) return;
    if (blockedFields.has(alias)) {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation "${aggregationName}" references ` +
          `field "${ref}" in ${context} whose root "${alias}" is marked hidden or ` +
          `systemManaged in schemaOptions.fieldRules. Aggregating hidden ` +
          `fields would leak cardinality information.`,
      );
    }
    return;
  }
  if (blockedFields.has(ref)) {
    throw new ArcAggregationConfigError(
      `Resource "${resourceName}" aggregation "${aggregationName}" references ` +
        `field "${ref}" in ${context}, but the field is marked hidden or ` +
        `systemManaged in schemaOptions.fieldRules. Aggregating hidden ` +
        `fields would leak cardinality information.`,
    );
  }
}

function extractTenantFilter(tenantOptions: AnyRecord): AnyRecord {
  // Tenant options bag (from BaseCrudController.tenantRepoOptions)
  // contains organizationId / tenantField, plus userId / user / requestId.
  // For aggregation filter composition we only want fields that are
  // semantic tenant scope — userId / user / requestId are kit options,
  // NOT filter predicates. Conservative pass: forward only string-valued
  // entries that aren't part of the canonical option bag.
  const out: AnyRecord = {};
  const optionOnlyKeys = new Set(["userId", "user", "session", "requestId"]);
  for (const [key, value] of Object.entries(tenantOptions)) {
    if (optionOnlyKeys.has(key)) continue;
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}
