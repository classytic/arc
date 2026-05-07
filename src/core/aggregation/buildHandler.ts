/**
 * Per-aggregation request handler builder.
 *
 * Returns a Fastify-shaped handler that:
 *
 *   1. Resolves request scope (tenant + audit + trace) — same path the
 *      CRUD controller uses, no duplicate logic.
 *   2. Validates safety guards (`requireFilters`, `requireDateRange`).
 *   3. Compiles the runtime `AggRequest` (host base + tenant + caller).
 *   4. Routes to `materialized` hook (if declared) OR `repo.aggregate()`.
 *   5. Enforces `maxGroups` post-execution.
 *   6. Wraps repo-level errors into stable HTTP envelopes (501 / 504).
 *
 * Cross-cutting middleware (auth, permission, rate-limit, cache,
 * audit) is wired via the **router** (createAggregationRouter) using
 * the same primitives `createCrudRouter` / `createActionRouter` use —
 * this handler runs AFTER all of those checks pass.
 */

import type { ErrorContract } from "@classytic/repo-core/errors";
import type { AggRequest, AggResult } from "@classytic/repo-core/repository";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AnyRecord } from "../../types/index.js";
import {
  adapterSupportsAggregate,
  compileAggRequest,
  type NormalizedAggregation,
} from "./validate.js";

/** Captured at boot — the bits the handler needs at request time. */
export interface AggregationHandlerDeps {
  /**
   * Repository instance the resource controller wraps. Must implement
   * `aggregate?(req): Promise<AggResult>` per `StandardRepo`.
   */
  repo: unknown;
  /**
   * Tenant-options builder — same one BaseCrudController uses to thread
   * organizationId / userId / user / requestId into every repo call.
   * Reused so aggregations get auto audit attribution + trace
   * correlation without duplicating the wiring.
   */
  buildOptions: (req: FastifyRequest) => AnyRecord;
}

/**
 * Framework-agnostic execute context — passed to `executeAggregation`
 * by both the Fastify route handler and the MCP tool handler. Keeps
 * the agg execution logic decoupled from the Fastify request shape.
 */
export interface AggregationExecuteContext {
  /**
   * Caller-supplied query parameters / filter narrows. Reserved keys
   * (`page`, `limit`, etc.) are stripped automatically; everything
   * else flows into the AggRequest filter via shallow merge with
   * the host's base filter + tenant scope.
   */
  query: Record<string, unknown>;
  /**
   * Pre-built tenant + audit + trace options bag. Same shape
   * `BaseCrudController.tenantRepoOptions(req)` produces; MCP tool
   * builds an equivalent from the session's request context.
   */
  tenantOptions: AnyRecord;
}

/**
 * Framework-agnostic execute response. Status discriminates success vs
 * error — both internally and on the wire — mirroring the no-envelope
 * HTTP contract:
 *
 *   - `status === 200` → `body` is `{ rows }` (the success payload arc
 *     emits raw on the wire).
 *   - `status >= 400` → `body` is the canonical `ErrorContract` from
 *     `@classytic/repo-core/errors`. Same shape every other 4xx/5xx in
 *     arc emits, so MCP / HTTP / observability all see one contract.
 */
export interface AggregationExecuteResponse {
  status: number;
  headers?: Record<string, string>;
  body: { rows: readonly AnyRecord[] } | ErrorContract;
}

/**
 * Framework-agnostic aggregation execution. Runs safety guards,
 * compiles the AggRequest, dispatches to the materialized hook or
 * `repo.aggregate()`, and applies the post-execution `maxGroups` cap.
 *
 * Returns an envelope describing the response — Fastify wrappers
 * apply it to a reply, MCP wrappers convert it to a tool-call result.
 *
 * **Does NOT run the per-aggregation permission check.** Auth runs
 * upstream (Fastify preHandler chain or MCP `evaluatePermission`)
 * because the permission shape differs by surface (FastifyRequest vs
 * MCP session). Both surfaces fail-closed BEFORE reaching this
 * function; this is purely the runtime executor.
 */
export async function executeAggregation(
  normalized: NormalizedAggregation,
  deps: AggregationHandlerDeps,
  ctx: AggregationExecuteContext,
): Promise<AggregationExecuteResponse> {
  const { repo } = deps;
  const config = normalized.base;
  const aggregationName = normalized.name;
  const { query, tenantOptions } = ctx;

  // ── Safety guards ────────────────────────────────────────────────
  const guardError = checkRequestGuards(query, config);
  if (guardError) {
    return { status: 400, body: guardError };
  }

  // ── Compile runtime AggRequest ───────────────────────────────────
  const callerFilter = extractCallerFilter(query);
  const aggReq: AggRequest = compileAggRequest(normalized, callerFilter, tenantOptions);

  // ── Materialized escape hatch ────────────────────────────────────
  if (config.materialized) {
    const matCtx = {
      filter: aggReq.filter as AnyRecord,
      orgId: pickString(tenantOptions.organizationId),
      userId: pickString(tenantOptions.userId),
      requestId: pickString(tenantOptions.requestId),
      query,
    };
    const result = await config.materialized(matCtx);
    return {
      status: 200,
      headers: { "x-aggregation-source": "materialized" },
      body: { rows: result.rows },
    };
  }

  // ── Adapter feature-detect ───────────────────────────────────────
  if (!adapterSupportsAggregate(repo)) {
    return {
      status: 501,
      body: {
        code: "arc.adapter.capability_required",
        message:
          `Aggregation "${aggregationName}" is not supported: the resource's storage ` +
          `adapter does not implement repo.aggregate(). Use a kit that ships ` +
          `StandardRepo.aggregate (mongokit / sqlitekit), or remove the aggregations entry.`,
        status: 501,
        meta: { capability: "aggregate", aggregation: aggregationName },
      },
    };
  }

  // ── Execute aggregate ────────────────────────────────────────────
  // Timeout / indexHint ride on `aggReq.executionHints` (set in
  // compileAggRequest) — repo-core 0.4's portable channel. Mongokit
  // applies them via `applyExecutionHints()`; sqlitekit and other
  // kits ignore unsupported hints silently.
  //
  // Pass `tenantOptions` as the second arg so the kit's per-op
  // context bag receives `organizationId` / `userId` / `requestId`.
  // Without this, plugins registered via `before:aggregate` (multi-
  // tenant, soft-delete, audit) can't read tenant scope and fail
  // closed with "Missing 'organizationId' in context". The tenant
  // info also lands in `aggReq.filter` via `extractTenantFilter()`
  // for backwards compatibility with kits whose `aggregate()` is
  // still single-arg — kits with the two-arg signature get scope on
  // both channels and the merge is idempotent.
  let result: AggResult<AnyRecord>;
  try {
    const repoLike = repo as {
      aggregate: (req: AggRequest, options?: AnyRecord) => Promise<AggResult<AnyRecord>>;
    };
    result = await repoLike.aggregate(aggReq, tenantOptions);
  } catch (err) {
    return mapAggregateError(err, aggregationName);
  }

  // ── maxGroups guard ──────────────────────────────────────────────
  if (config.maxGroups !== undefined && result.rows.length > config.maxGroups) {
    return {
      status: 422,
      body: {
        code: "arc.aggregation.max_groups_exceeded",
        message:
          `Aggregation "${aggregationName}" produced ${result.rows.length} groups, ` +
          `exceeding maxGroups (${config.maxGroups}). Narrow the filter or raise the cap.`,
        status: 422,
        meta: {
          aggregation: aggregationName,
          produced: result.rows.length,
          maxGroups: config.maxGroups,
        },
      },
    };
  }

  return {
    status: 200,
    body: { rows: result.rows },
  };
}

/**
 * Build the Fastify handler for a single aggregation.
 *
 * The returned function calls the repo (or materialized hook), shapes
 * the response envelope, and writes status/headers via Fastify's
 * `reply` API. Errors throw — the router's error handler converts to
 * the standard arc response shape.
 */
/**
 * Build the Fastify handler for a single aggregation.
 *
 * Caching lives in the kit's repo-core `cachePlugin` — when the host
 * declares `cache:` on the aggregation, `compileAggRequest` translates
 * to `aggReq.cache: CacheOptions` and the kit handles SWR + tag
 * invalidation + version-bump on writes. Arc passes the request
 * through; no duplicate cache layer at the HTTP handler.
 */
export function buildAggregationHandler(
  normalized: NormalizedAggregation,
  deps: AggregationHandlerDeps,
): (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  const { buildOptions } = deps;

  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const tenantOptions = buildOptions(request);

    const result = await executeAggregation(normalized, deps, { query, tenantOptions });

    reply.status(result.status);
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
    }
    // No-envelope contract: status discriminates. On 200 the body is the
    // raw aggregation payload (`{ rows: [...] }`); on 4xx/5xx it's the
    // canonical `ErrorContract` — same shape every other arc 4xx/5xx
    // emits, so clients have one error contract across the surface.
    return result.body;
  };
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

function pickString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function checkRequestGuards(
  query: Record<string, unknown>,
  config: NormalizedAggregation["base"],
): ErrorContract | null {
  // requireFilters — every named field must appear in query (any value)
  if (config.requireFilters) {
    for (const field of config.requireFilters) {
      if (!hasFilterOnField(query, field)) {
        return {
          code: "arc.aggregation.required_filter_missing",
          message: `Aggregation requires filter on "${field}" — supply ?${field}=... or ?${field}[op]=... in the query string.`,
          status: 400,
          meta: { field },
        };
      }
    }
  }

  if (config.requireDateRange) {
    const { field, maxRangeDays } = config.requireDateRange;
    const range = parseDateRange(query, field);
    if (!range) {
      return {
        code: "arc.aggregation.required_date_range_missing",
        message:
          `Aggregation requires a bounded date range on "${field}" — supply ` +
          `?${field}[gte]=... and ?${field}[lt]=... (or ?${field}[lte]=...).`,
        status: 400,
        meta: { field },
      };
    }
    if (maxRangeDays !== undefined) {
      const days = (range.upper.getTime() - range.lower.getTime()) / 86_400_000;
      if (days > maxRangeDays) {
        return {
          code: "arc.aggregation.date_range_exceeded",
          message:
            `Aggregation date range on "${field}" exceeds the cap (${maxRangeDays} days). ` +
            `Requested range: ${days.toFixed(1)} days. Narrow the range and retry.`,
          status: 400,
          meta: { field, maxRangeDays, requestedDays: days },
        };
      }
    }
  }

  return null;
}

function hasFilterOnField(query: Record<string, unknown>, field: string): boolean {
  // qs-parsed URLs nest bracket syntax — `?field[gte]=...` becomes
  // `query.field = { gte: '...' }`. Flat-key URLs (no qs) survive
  // raw — `query['field[gte]']`. Both shapes count as "filter present."
  const direct = query[field];
  if (direct !== undefined && direct !== "") return true;
  for (const key of Object.keys(query)) {
    if (key.startsWith(`${field}[`)) return true;
  }
  return false;
}

function parseDateRange(
  query: Record<string, unknown>,
  field: string,
): { lower: Date; upper: Date } | null {
  // qs-parsed shape — bracket syntax becomes a nested object.
  let gte: string | undefined;
  let lte: string | undefined;
  const nested = query[field];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const ops = nested as Record<string, unknown>;
    gte = pickString(ops.gte) ?? pickString(ops.gt);
    lte = pickString(ops.lte) ?? pickString(ops.lt);
  }
  // Flat-key fallback for callers that bypass qs (e.g. tests, MCP).
  if (!gte) gte = pickString(query[`${field}[gte]`]) ?? pickString(query[`${field}[gt]`]);
  if (!lte) lte = pickString(query[`${field}[lte]`]) ?? pickString(query[`${field}[lt]`]);
  if (!gte || !lte) return null;
  const lower = new Date(gte);
  const upper = new Date(lte);
  if (Number.isNaN(lower.getTime()) || Number.isNaN(upper.getTime())) return null;
  if (upper <= lower) return null;
  return { lower, upper };
}

/**
 * Bracket-syntax operator shorthand → canonical Mongo operator. Mirrors
 * the `operators` map in `ArcQueryParser` so the aggregation route emits
 * the same shape the CRUD list route produces. Aggregations don't run
 * through the resource-level QueryParser (they have their own URL→IR
 * compile path), so this translation has to happen in arc itself —
 * downstream kits' filter compilers expect canonical `$gte/$lte/$in/...`
 * keys, not bare `gte/lte/in/...` shorthand.
 */
const OPERATOR_SHORTHAND: Record<string, string> = {
  eq: "$eq",
  ne: "$ne",
  gt: "$gt",
  gte: "$gte",
  lt: "$lt",
  lte: "$lte",
  in: "$in",
  nin: "$nin",
  like: "$regex",
  contains: "$regex",
  regex: "$regex",
  exists: "$exists",
  size: "$size",
  type: "$type",
};

const SHORTHAND_RANGE_OPS = new Set(["gt", "gte", "lt", "lte"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function tryCoerceDate(v: unknown): unknown {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d;
}

/**
 * Translate a qs-parsed nested-operator object (`{ field: { gte, lte } }`)
 * into Mongo-shape (`{ field: { $gte: Date, $lte: Date } }`). Only fires
 * when EVERY key is a known shorthand operator — leaves user-data
 * objects untouched so callers can still equality-match on a stored
 * sub-document.
 */
function expandShorthandOperators(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const nested = value as Record<string, unknown>;
  const keys = Object.keys(nested);
  if (keys.length === 0) return value;
  if (!keys.every((k) => !k.startsWith("$") && OPERATOR_SHORTHAND[k] !== undefined)) {
    return value;
  }
  const expanded: Record<string, unknown> = {};
  for (const [op, opVal] of Object.entries(nested)) {
    const mongoOp = OPERATOR_SHORTHAND[op];
    if (!mongoOp) continue;
    expanded[mongoOp] = SHORTHAND_RANGE_OPS.has(op) ? tryCoerceDate(opVal) : opVal;
  }
  return expanded;
}

/**
 * Strip control params (page/limit/sort/select/...) and the resource-
 * dispatch verbs from the query, leaving only filter predicates the
 * caller used to narrow the aggregation. Bracket-syntax operator
 * shorthand (`createdAt[gte]=...`) gets translated to canonical Mongo-
 * shape here so kits don't have to reimplement the URL grammar — same
 * contract `ArcQueryParser` enforces for the CRUD list route.
 *
 * The resulting record is shallow-merged into the AggRequest filter
 * via `compileAggRequest`.
 */
function extractCallerFilter(query: Record<string, unknown>): AnyRecord {
  const out: AnyRecord = {};
  const reserved = new Set([
    "page",
    "limit",
    "after",
    "sort",
    "select",
    "populate",
    "search",
    "_count",
    "_distinct",
    "_exists",
  ]);
  for (const [key, value] of Object.entries(query)) {
    if (reserved.has(key)) continue;
    if (value === undefined || value === "") continue;
    out[key] = expandShorthandOperators(value);
  }
  return out;
}

/**
 * Map a kit-thrown error to the framework-agnostic execute response.
 * Detects two well-known signals:
 *   - "unsupported" / "not implemented" → 501 with upgrade hint
 *   - timeout markers → 504
 *   - everything else → 500
 */
function mapAggregateError(err: unknown, aggregationName: string): AggregationExecuteResponse {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes("unsupported") || lower.includes("not implemented")) {
    return {
      status: 501,
      body: {
        code: "arc.adapter.capability_required",
        message:
          `Aggregation "${aggregationName}" failed: ${message}. ` +
          `The kit may not yet support this feature (e.g. lookups in aggregate). ` +
          `Upgrade the kit or remove the unsupported field.`,
        status: 501,
        meta: { aggregation: aggregationName },
      },
    };
  }

  if (lower.includes("maxtimems") || lower.includes("timeout") || lower.includes("timed out")) {
    return {
      status: 504,
      body: {
        code: "arc.gateway_timeout",
        message:
          `Aggregation "${aggregationName}" timed out: ${message}. ` +
          `Narrow the filter or raise the timeout.`,
        status: 504,
        meta: { aggregation: aggregationName },
      },
    };
  }

  return {
    status: 500,
    body: {
      code: "arc.internal_error",
      message: `Aggregation "${aggregationName}" failed: ${message}`,
      status: 500,
      meta: { aggregation: aggregationName },
    },
  };
}
