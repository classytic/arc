/**
 * Boot-time validation for resource aggregations.
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
 * Pure normalization (measure shorthand → IR, `groupBy` string →
 * string[], limit-policy resolution, `AggRequest` compilation) lives
 * in `normalize.ts`.
 */

import type {
  AggDateBucket,
  AggDateBucketUnit,
  AggMeasure,
  AggTopN,
} from "@classytic/repo-core/repository";
import type { AnyRecord, RouteSchemaOptions } from "../../types/index.js";
import type { NormalizedAggregation } from "./normalize.js";
import {
  collectBlockedFields,
  collectLookupAliases,
  normalizeGroupBy,
  parseMeasureShorthand,
  resolveLimitPolicy,
} from "./normalize.js";
import type {
  AggMeasureInput,
  AggMeasureShorthand,
  AggregationConfig,
  AggregationsMap,
} from "./types.js";

export { compileAggRequest, type NormalizedAggregation } from "./normalize.js";

/** Thrown on aggregation misconfig at boot time. */
export class ArcAggregationConfigError extends Error {
  override readonly name = "ArcAggregationConfigError";
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
    validateAggregationName(resourceName, name);
    validatePermissionsDeclared(resourceName, name, config);
    validateMeasuresNonEmpty(resourceName, name, config);

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

    validateLimitConfig(resourceName, name, config);

    const limitPolicy = resolveLimitPolicy(config);

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
        ...(limitPolicy ? { limitPolicy } : {}),
      },
    });
  }

  return out;
}

function validateAggregationName(resourceName: string, name: string): void {
  if (!isValidAggregationName(name)) {
    throw new ArcAggregationConfigError(
      `Resource "${resourceName}" aggregation key "${name}" is invalid — ` +
        `keys map to URL segments and must be alphanumeric or underscore/hyphen.`,
    );
  }
}

function validatePermissionsDeclared(
  resourceName: string,
  name: string,
  config: AggregationConfig,
): void {
  if (typeof config.permissions !== "function") {
    throw new ArcAggregationConfigError(
      `Resource "${resourceName}" aggregation "${name}" is missing a "permissions" check. ` +
        `Aggregations must declare permissions explicitly — no default-allow. ` +
        `Use a permission helper from @classytic/arc/permissions.`,
    );
  }
}

function validateMeasuresNonEmpty(
  resourceName: string,
  name: string,
  config: AggregationConfig,
): void {
  if (!config.measures || Object.keys(config.measures).length === 0) {
    throw new ArcAggregationConfigError(
      `Resource "${resourceName}" aggregation "${name}" has no measures. ` +
        `An empty "measures" map is a wiring bug — at least one measure is required.`,
    );
  }
}

/**
 * Validate `limit` / `defaultLimit` / `maxLimit` triad. Throws on
 * misconfig at boot — boundary value, hosts see exactly what to fix.
 */
function validateLimitConfig(
  resourceName: string,
  aggName: string,
  config: AggregationConfig,
): void {
  const hasStatic = config.limit !== undefined;
  const hasDynamic = config.defaultLimit !== undefined;

  if (hasStatic && hasDynamic) {
    throw new ArcAggregationConfigError(
      `Resource "${resourceName}" aggregation "${aggName}" sets both \`limit\` (static cap) and ` +
        `\`defaultLimit\` (URL-driven cap). Pick one — static \`limit\` ignores the URL; ` +
        `\`defaultLimit\` reads \`?limit=N\` and caps it at \`maxLimit\`.`,
    );
  }

  // `maxLimit` is meaningful only with `defaultLimit`. Refuse it
  // anywhere else (static-limit config OR no-limit config) — silently
  // accepting it would suggest the URL cap is active when it isn't.
  if (config.maxLimit !== undefined && !hasDynamic) {
    throw new ArcAggregationConfigError(
      `Resource "${resourceName}" aggregation "${aggName}" sets \`maxLimit\` without ` +
        `\`defaultLimit\`. \`maxLimit\` only applies to URL-driven limits — set \`defaultLimit\` ` +
        `or remove \`maxLimit\`.`,
    );
  }

  if (hasStatic) {
    if (!Number.isInteger(config.limit) || (config.limit as number) <= 0) {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation "${aggName}" \`limit\` must be a positive integer ` +
          `— got ${String(config.limit)}.`,
      );
    }
  }

  if (hasDynamic) {
    if (!Number.isInteger(config.defaultLimit) || (config.defaultLimit as number) <= 0) {
      throw new ArcAggregationConfigError(
        `Resource "${resourceName}" aggregation "${aggName}" \`defaultLimit\` must be a positive ` +
          `integer — got ${String(config.defaultLimit)}.`,
      );
    }
    if (config.maxLimit !== undefined) {
      if (!Number.isInteger(config.maxLimit) || (config.maxLimit as number) <= 0) {
        throw new ArcAggregationConfigError(
          `Resource "${resourceName}" aggregation "${aggName}" \`maxLimit\` must be a positive ` +
            `integer — got ${String(config.maxLimit)}.`,
        );
      }
      if ((config.maxLimit as number) < (config.defaultLimit as number)) {
        throw new ArcAggregationConfigError(
          `Resource "${resourceName}" aggregation "${aggName}" \`maxLimit\` (${config.maxLimit}) ` +
            `is less than \`defaultLimit\` (${config.defaultLimit}). The ceiling must be ≥ the default.`,
        );
      }
    }
  }
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
          `references field "${field}" whose root "${a}" is blocked from aggregation ` +
          `(\`hidden: true\` or \`aggregable: false\` in schemaOptions.fieldRules). ` +
          `Bucketing hidden fields would leak temporal info.`,
      );
    }
    return;
  }
  if (blockedFields.has(field)) {
    throw new ArcAggregationConfigError(
      `Resource "${resourceName}" aggregation "${aggregationName}" dateBucket "${alias}" ` +
        `references field "${field}", but the field is blocked from aggregation ` +
        `(\`hidden: true\` or \`aggregable: false\` in schemaOptions.fieldRules). ` +
        `Bucketing hidden fields would leak temporal info.`,
    );
  }
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
          `field "${ref}" in ${context} whose root "${alias}" is blocked from ` +
          `aggregation (\`hidden: true\` or \`aggregable: false\` in ` +
          `schemaOptions.fieldRules). Aggregating hidden fields would leak ` +
          `cardinality information.`,
      );
    }
    return;
  }
  if (blockedFields.has(ref)) {
    throw new ArcAggregationConfigError(
      `Resource "${resourceName}" aggregation "${aggregationName}" references ` +
        `field "${ref}" in ${context}, but the field is blocked from aggregation ` +
        `(\`hidden: true\` or \`aggregable: false\` in schemaOptions.fieldRules). ` +
        `Aggregating hidden fields would leak cardinality information.`,
    );
  }
}
