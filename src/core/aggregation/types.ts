/**
 * Public types for arc resource aggregations.
 *
 * Hosts declare aggregations in `defineResource({ aggregations: { ... } })`.
 * Arc generates one `GET /:resource/aggregations/:name` route per entry,
 * threading the same auth + tenant + audit + cache middleware that CRUD
 * uses. The portable `AggRequest` IR (from `@classytic/repo-core/repository`)
 * is composed at request time from the host's declarative spec + the
 * caller's URL-narrowing filters.
 *
 * **Big-data safety knobs** are first-class. Aggregations on
 * billion-row tables need explicit timeouts, group caps, required date
 * ranges, and tenant-aligned indexes — none of which are runtime
 * concerns the framework can guess. Hosts opt into each guard;
 * defaults are conservative (no caps, no required filters) so small-data
 * use cases stay frictionless.
 */

import type { LookupSpec } from "@classytic/repo-core/lookup";
import type { AggDateBucket, AggMeasure, AggTopN } from "@classytic/repo-core/repository";
import type { PermissionCheck } from "../../permissions/types.js";
import type { AnyRecord } from "../../types/index.js";

/**
 * Sugar for measures: `'count'` / `'count:field'` / `'sum:price'` /
 * `'avg:rating'` / `'min:created'` / `'max:updated'` /
 * `'countDistinct:userId'` / `'percentile:latency:0.95'`.
 *
 * Compiles to the canonical `AggMeasure` IR at boot. Hosts who want
 * the full IR can pass an `AggMeasure` object directly.
 *
 * **Percentile.** `'percentile:<field>:<p>'` where `p` is a numeric
 * literal in `[0, 1]` (e.g. `'percentile:latency:0.95'` for P95).
 * Mongokit (≥3.13) compiles to `$percentile`; sqlitekit throws
 * `UnsupportedOperationError` (no native percentile in SQLite).
 */
export type AggMeasureShorthand =
  | "count"
  | `count:${string}`
  | `countDistinct:${string}`
  | `sum:${string}`
  | `avg:${string}`
  | `min:${string}`
  | `max:${string}`
  | `percentile:${string}:${number}`;

/** Either canonical IR or shorthand string — both compile to `AggMeasure`. */
export type AggMeasureInput = AggMeasure | AggMeasureShorthand;

/**
 * Cache config for an aggregation. Translates directly to the kit-side
 * `CacheOptions` (TanStack-shaped) which the unified
 * `@classytic/repo-core/cache` plugin reads from `req.cache`.
 *
 * Caching only fires when the kit's repo has the `cachePlugin` wired —
 * arc declares the policy; the kit handles SWR + tag invalidation +
 * version-bump on writes. Hosts without the plugin installed silently
 * fall through to a non-cached call.
 */
export interface AggregationCacheConfig {
  /** Seconds the entry is fresh — no revalidation while inside this window. */
  staleTime?: number;
  /** Seconds the entry stays in cache past stale before eviction. Default: 60. */
  gcTime?: number;
  /**
   * Stale-while-revalidate. When stale entries serve immediately and a
   * background refresh updates the cache. Default: `true` for
   * aggregations (dashboards almost always benefit from stale-serve).
   */
  swr?: boolean;
  /**
   * Group invalidation tags. Pass to `repo.cache?.invalidateByTags(tags)`
   * after a write to clear matching entries. The model name is
   * auto-tagged by the plugin — you only declare cross-cutting tags
   * (e.g. `'pricing'` to invalidate every aggregation that depends on
   * pricing across multiple resources).
   */
  tags?: readonly string[];
}

/**
 * Per-aggregation rate limit. Layers on top of any global rate limit
 * via `@fastify/rate-limit` route-level config.
 */
export interface AggregationRateLimit {
  /** Max requests per window. */
  max: number;
  /** Window in milliseconds. */
  windowMs: number;
}

/**
 * Required date-range narrowing. Caller MUST send a bounded range on
 * this field, and the range MUST NOT exceed `maxRangeDays`.
 *
 * Prevents "all-time" scans on billion-row collections — the single
 * biggest performance footgun for live aggregation endpoints.
 */
export interface AggregationDateRangeRequirement {
  /** Field whose range the caller must narrow (e.g. `'createdAt'`). */
  field: string;
  /**
   * Cap on the queryable range. A request asking for >N days is
   * rejected 400. Omit for "any range, but bounded" (lower + upper
   * required, no cap).
   */
  maxRangeDays?: number;
}

/**
 * Boot-time index hint. Arc warns when the kit's schema doesn't have
 * an index whose leading keys match — flags the misconfig before
 * traffic hits the DB.
 *
 * Documented intent, NOT runtime-enforced. Kits with their own index
 * introspection (mongokit reads Mongoose schema, sqlitekit reads
 * Drizzle indexes) can act on the hint; kits without introspection
 * silently accept it.
 */
export interface AggregationIndexHint {
  /** Leading-key columns the host expects the planner to use. */
  leadingKeys: readonly string[];
}

/**
 * Runtime context passed to the `materialized` hook.
 *
 * The hook returns pre-computed data instead of running the live
 * aggregation. Hosts use this for ultra-frequent dashboards backed by
 * rollup tables maintained out-of-band (cron / CDC).
 */
export interface AggregationMaterializedContext {
  /** Compiled filter (host base + tenant + caller). */
  filter: AnyRecord;
  /** Tenant id when the resource is tenant-scoped. */
  orgId?: string;
  /** Authenticated user id, when present. */
  userId?: string;
  /** Fastify request id for tracing. */
  requestId?: string;
  /** Raw URL query params (post-validation). */
  query: Record<string, unknown>;
}

/** Materialized hook return shape — same envelope as `AggResult`. */
export interface AggregationMaterializedResult<TRow = AnyRecord> {
  rows: readonly TRow[];
}

/**
 * Single named aggregation declaration. Composes into `AggRequest` at
 * request time, with safety knobs layered on at the arc-handler level.
 */
export interface AggregationConfig {
  /**
   * Pre-aggregate filter on the BASE rows (before lookups). Always
   * ANDed with auto-injected tenant scope + caller URL-narrowing
   * filters. Use for host-defined invariants (e.g. `archived: false`).
   */
  filter?: AnyRecord;

  /**
   * Cross-table joins. Each `LookupSpec` reuses the IR
   * `@classytic/repo-core/lookup` defines for `lookupPopulate()`.
   * Same compile path the kit already ships.
   *
   * **Kit support is incremental.** A kit's `aggregate()` may not yet
   * compile lookups — boot validation against the adapter version
   * surfaces this loud, so hosts pin the kit major they need.
   */
  lookups?: readonly LookupSpec[];

  /**
   * Group key(s). Dotted paths into joined aliases supported when
   * `lookups` is set: `'category.parent'` groups by the joined
   * `category` row's `parent` field.
   */
  groupBy?: string | readonly string[];

  /**
   * Time-bucket group keys for time-series aggregations. Each entry
   * promotes a date column into a synthetic group key bucketed at
   * the chosen interval. The map key becomes a column on the output
   * row holding the canonical ISO-shaped bucket label
   * (`'2026-04'` for month, `'2026-W15'` for ISO week, etc.).
   *
   * Bucketed keys participate in grouping the same way `groupBy`
   * columns do — `sort: { month: 1 }`, `having`, pagination, and
   * `topN.partitionBy` all treat them as first-class.
   *
   * Aliases must NOT collide with a `groupBy` field name or measure
   * alias — boot validation throws on collision.
   *
   * @example "Daily revenue for the last quarter"
   * ```ts
   * dailyRevenue: defineAggregation({
   *   dateBuckets: { day: { field: 'createdAt', interval: 'day' } },
   *   measures: { revenue: 'sum:totalPrice' },
   *   sort: { day: 1 },
   *   permissions: requireRoles(['admin']),
   * }),
   * ```
   *
   * @example "15-minute traffic buckets (custom-bin form)"
   * ```ts
   * traffic: defineAggregation({
   *   dateBuckets: {
   *     slot: { field: 'ts', interval: { every: 15, unit: 'minute' } },
   *   },
   *   measures: { hits: 'count' },
   *   permissions: allowPublic(),
   * }),
   * ```
   */
  dateBuckets?: Record<string, AggDateBucket>;

  /** Named aggregations. At least one entry required. */
  measures: Record<string, AggMeasureInput>;

  /**
   * Post-aggregate filter referencing measure aliases.
   * Example: `{ revenue: { gt: 1000 } }` → `HAVING revenue > 1000`.
   */
  having?: AnyRecord;

  /** Order grouped rows by groupBy field, measure alias, or joined-alias path. */
  sort?: Record<string, 1 | -1>;

  /** Hard cap on result rows. Applied at the IR level (LIMIT / `$limit`). */
  limit?: number;

  /**
   * Top-N-per-group filter. Keeps only the top `limit` rows per
   * partition, ranked by `sortBy`. The classic "top 3 products per
   * category" / "top 5 customers per region" dashboard primitive.
   *
   * Composes with `having` / `sort` — applies AFTER group + measures +
   * having, so `partitionBy` and `sortBy` may reference groupBy fields,
   * dateBucket aliases, or measure aliases. The top-level `sort` orders
   * the final row set across partitions.
   *
   * **Per-kit support.** Mongokit compiles to `$setWindowFields` (Mongo 5+,
   * runs in-engine — scales). Sqlitekit post-processes in JS (fine for
   * typical dashboards; prefer mongokit for >100k groups). See
   * `AggTopN` for full semantics.
   */
  topN?: AggTopN;

  // ── Required: permissions ──────────────────────────────────────────

  /**
   * Permission check. **REQUIRED.** Aggregations are read-shape but
   * different from list (different threat model — measures may expose
   * cardinality info even when individual rows are hidden). Boot error
   * if missing.
   */
  permissions: PermissionCheck;

  // ── Big-data safety knobs ──────────────────────────────────────────

  /**
   * DB-level execution cap (ms). Mongokit threads to `maxTimeMS`;
   * sqlitekit threads to per-statement timeout where supported.
   * Default: kit's default (typically none).
   */
  timeout?: number;

  /**
   * Reject 422 if the result row count exceeds this cap. Better than
   * silent truncation — caller knows the dashboard is incomplete.
   * Default: no cap (use `limit` for truncation semantics).
   */
  maxGroups?: number;

  /**
   * Caller MUST provide filters on these fields (else 400 at request).
   * Use to require a tenant-side narrowing the host can't infer
   * (segment id, customer id, etc.).
   */
  requireFilters?: readonly string[];

  /**
   * Caller MUST send a bounded date range on this field. Prevents
   * all-time scans on billion-row collections.
   */
  requireDateRange?: AggregationDateRangeRequirement;

  /**
   * Documented index expectation. Arc warns at boot when the kit
   * exposes index introspection and no matching index exists. NOT
   * runtime-enforced — purely a misconfig signal.
   */
  indexHint?: AggregationIndexHint;

  // ── Caching ───────────────────────────────────────────────────────

  /**
   * Per-aggregation cache. Tenant-scoped keys; invalidates with the
   * resource's cache namespace + any explicit `tags`.
   */
  cache?: AggregationCacheConfig;

  // ── Rate limiting ────────────────────────────────────────────────

  /**
   * Per-route rate limit. Wired to `@fastify/rate-limit` when the
   * plugin is registered.
   */
  rateLimit?: AggregationRateLimit;

  // ── Materialized view escape hatch ────────────────────────────────

  /**
   * Pre-computed read replacement. When set, arc skips
   * `repo.aggregate()` and calls this function instead. Same wire
   * shape, same permissions, different data source.
   *
   * Use for homepage-counter dashboards backed by host-managed rollup
   * tables (cron / CDC). The hook receives the compiled context
   * (filter + scope) so the host can route the lookup to the right
   * pre-aggregated bucket.
   */
  materialized?: (ctx: AggregationMaterializedContext) => Promise<AggregationMaterializedResult>;

  // ── Documentation ─────────────────────────────────────────────────

  /** Optional summary rendered in OpenAPI + MCP tool description. */
  summary?: string;

  /** Optional longer description for OpenAPI / MCP. */
  description?: string;

  /**
   * MCP tool generation control. Mirrors `actions[name].mcp` semantics.
   *
   *   - `undefined` (default) — generate an MCP tool for this aggregation
   *   - `false` — skip MCP tool generation (REST route still works)
   *   - `{ description?, annotations? }` — generate with overrides
   */
  mcp?:
    | boolean
    | {
        readonly description?: string;
        readonly annotations?: Record<string, unknown>;
      };
}

/** Map of name → declaration. Keys become URL segments under `/aggregations/<name>`. */
export type AggregationsMap = Record<string, AggregationConfig>;
