/**
 * Cross-surface authorization conformance (arc 2.30).
 *
 * The regression wall that keeps "partial enforcement" from ever coming back:
 * run the SAME permission through more than one arc surface and prove it enforces
 * identically. Reviews kept finding aggregation (and MCP) drifting from CRUD —
 * this makes that a one-call assertion for arc AND for host resources.
 *
 * `runAuthorizationConformance` boots a throwaway Fastify app with one resource
 * whose `list` op AND an `aggregation` share the given permission, backed by a
 * capturing mock repo (no DB). It returns, per surface, the HTTP status and the
 * exact filter arc handed the repository — so the caller asserts:
 *   - deny → both surfaces fail closed with the SAME status;
 *   - allow + `policy` → the row policy reaches BOTH the list query and the
 *     aggregation `$match`, identically.
 *
 * Runner-agnostic: it returns data, it does not assert. Pair with your test
 * framework's expectations (see `tests/core/authorization-conformance.test.ts`).
 */

import Fastify from "fastify";
import { defineAggregation } from "../core/aggregation/index.js";
import { BaseController } from "../core/BaseController.js";
import { defineResource } from "../core/defineResource.js";
import type { PermissionCheck } from "../permissions/types.js";
import type { AnyRecord } from "../types/index.js";
import { createMockRepository } from "./mocks.js";

/** One surface's observed enforcement: the HTTP status + the filter arc passed the repo. */
export interface SurfaceObservation {
  /** HTTP status the surface returned (200 = allowed, 401/403 = denied). */
  status: number;
  /** The filter arc handed the repository for this surface (undefined if never reached). */
  filter: AnyRecord | undefined;
}

/** Result of {@link runAuthorizationConformance} — one observation per surface. */
export interface AuthorizationConformance {
  /** `GET /confs` — the CRUD list surface. */
  list: SurfaceObservation;
  /**
   * `GET /confs/:id` — the SINGLE-RECORD surface. Its `filter` is the compound
   * `buildIdFilter` output (route id AND policy AND tenant), so a policy that
   * tried to redirect/widen the target would show here — the surface the
   * filter-overwrite class of bug lives on.
   */
  get: SurfaceObservation;
  /** `GET /confs/aggregations/tally` — the aggregation surface. */
  aggregation: SurfaceObservation;
  /** Close the throwaway app. Always call (e.g. in `finally`). */
  close(): Promise<void>;
}

/**
 * Boot a one-resource app gated by `permission` on both list + an aggregation,
 * hit both surfaces anonymously, and report what arc enforced on each.
 */
export async function runAuthorizationConformance(opts: {
  /** The permission under test — applied to `list` and the aggregation alike. */
  permission: PermissionCheck;
  /** Rows the mock repo returns for list (aggregation returns a count). */
  rows?: AnyRecord[];
}): Promise<AuthorizationConformance> {
  const rows = opts.rows ?? [{ _id: "1" }];
  let listFilter: AnyRecord | undefined;
  let getFilter: AnyRecord | undefined;
  let aggFilter: AnyRecord | undefined;

  const repo = createMockRepository<AnyRecord>({
    getAll: (async (params: { filters?: AnyRecord } = {}) => {
      listFilter = params.filters;
      return {
        method: "offset",
        data: rows,
        total: rows.length,
        page: 1,
        limit: 20,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      };
    }) as never,
    // The single-record read path: AccessControl.buildIdFilter → getOne(compound).
    // Capturing the compound filter here is what proves a policy can't redirect
    // or widen the route's target id (the filter-overwrite regression surface).
    getOne: (async (filter: AnyRecord) => {
      getFilter = filter;
      return rows[0] ?? null;
    }) as never,
    aggregate: (async (req: { filter?: AnyRecord } = {}) => {
      aggFilter = req.filter;
      return { rows: [{ tally: rows.length }] };
    }) as never,
    capabilities: {
      count: false,
      exists: false,
      distinct: false,
      aggregate: true,
      transactions: false,
      lookup: false,
      softDelete: false,
    } as never,
  });

  const resource = defineResource<AnyRecord>({
    name: "conf",
    prefix: "/confs",
    // Pure mock repo (no model) — arc only needs the repository contract here.
    adapter: { repository: repo } as never,
    controller: new BaseController(repo as never, { resourceName: "conf", tenantField: false }),
    permissions: {
      list: opts.permission,
      get: opts.permission,
      create: opts.permission,
      update: opts.permission,
      delete: opts.permission,
    },
    aggregations: {
      tally: defineAggregation({
        measures: { tally: { op: "count" } },
        permissions: opts.permission,
      }),
    },
  });

  const app = Fastify({ logger: false });
  await app.register(resource.toPlugin());
  await app.ready();

  const list = await app.inject({ method: "GET", url: "/confs" });
  const get = await app.inject({ method: "GET", url: "/confs/1" });
  const aggregation = await app.inject({ method: "GET", url: "/confs/aggregations/tally" });

  return {
    list: { status: list.statusCode, filter: listFilter },
    get: { status: get.statusCode, filter: getFilter },
    aggregation: { status: aggregation.statusCode, filter: aggFilter },
    close: () => app.close(),
  };
}
