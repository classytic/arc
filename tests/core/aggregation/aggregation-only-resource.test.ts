/**
 * Boot + runtime behaviour for aggregation-only resources.
 *
 * Regression-locks the v2.16 fix: when `disableDefaultRoutes: true` and
 * no user controller is supplied, the controller auto-builder returns
 * `undefined` (controller.ts:50). Pre-fix the aggregation router pulled
 * its repository off `resource.controller.repository`, so the kit's
 * `aggregate()` was unreachable and every aggregation 501'd silently.
 *
 * Coverage:
 *  - With an adapter that ships `aggregate`, the route routes through
 *    `repo.aggregate(req, options)` even without a controller.
 *  - `materialized` hooks dispatch independent of the adapter — a
 *    resource with no repo and only materialized aggregations works.
 *  - Boot guard: declaring aggregations without repo AND without
 *    `materialized` throws a clear `ArcAggregationConfigError` at
 *    register time — no silent 501 at first dashboard request.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defineAggregation } from "../../../src/core/aggregation/index.js";
import { defineResource } from "../../../src/core/defineResource.js";
import { createApp } from "../../../src/factory/createApp.js";
import { allowPublic } from "../../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../../setup.js";

describe("aggregation-only resources (no CRUD, no user controller)", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  it("dispatches through repo.aggregate() when no controller is supplied", async () => {
    const Model = createMockModel("RevenueOnly");
    const repo = createMockRepository(Model) as Record<string, unknown>;
    const aggregateStub = vi.fn().mockResolvedValue({
      rows: [{ status: "active", count: 7 }],
    });
    repo.aggregate = aggregateStub;

    const resource = defineResource({
      name: "revenue-only",
      prefix: "/revenue-only",
      adapter: createMongooseAdapter(Model, repo as never),
      disableDefaultRoutes: true,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      aggregations: {
        byStatus: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
        }),
      },
    });

    const app: FastifyInstance = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/revenue-only/aggregations/byStatus",
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).rows).toEqual([{ status: "active", count: 7 }]);
      expect(aggregateStub).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("materialized hooks dispatch without any repo", async () => {
    const resource = defineResource({
      name: "materialized-only",
      prefix: "/mat-only",
      // No adapter, no controller — materialized hook owns dispatch.
      disableDefaultRoutes: true,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      aggregations: {
        ownDispatch: defineAggregation({
          measures: { count: "count" },
          permissions: allowPublic(),
          materialized: async () => ({ rows: [{ count: 99 }] }),
        }),
      },
    });

    const app: FastifyInstance = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/mat-only/aggregations/ownDispatch",
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-aggregation-source"]).toBe("materialized");
      expect(JSON.parse(res.body).rows).toEqual([{ count: 99 }]);
    } finally {
      await app.close();
    }
  });

  it("throws at boot when aggregations declared without repo or materialized", async () => {
    const resource = defineResource({
      name: "no-dispatch",
      prefix: "/no-dispatch",
      disableDefaultRoutes: true,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      aggregations: {
        cantRun: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
          // No materialized hook AND no adapter — undispatchable.
        }),
      },
    });

    await expect(
      createApp({
        preset: "testing",
        auth: false,
        logger: false,
        plugins: async (f) => {
          await f.register(resource.toPlugin());
        },
      }),
    ).rejects.toThrow(/declares aggregations \[cantRun\].*no repository/i);
  });
});
