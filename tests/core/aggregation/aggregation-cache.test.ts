/**
 * Aggregation cache integration boundary.
 *
 * After the v2.13 refactor, arc no longer maintains its own SWR wrap
 * for aggregation routes — caching lives in the kit's repo-core
 * `cachePlugin`. Arc's job at the cache boundary is exactly this:
 * translate the declarative `cache:` config into `aggReq.cache`
 * (TanStack-shaped `CacheOptions`) so the kit plugin handles SWR,
 * tag invalidation, and version-bump on writes.
 *
 * These tests verify the translation contract — the kit's plugin
 * tests live in `@classytic/repo-core` and verify the SWR flow itself.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defineAggregation } from "../../../src/core/aggregation/index.js";
import { BaseController } from "../../../src/core/BaseController.js";
import { defineResource } from "../../../src/core/defineResource.js";
import { createApp } from "../../../src/factory/createApp.js";
import { allowPublic } from "../../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../../setup.js";

describe("aggregation cache — config-to-AggRequest translation", () => {
  let app: FastifyInstance;
  // biome-ignore lint/suspicious/noExplicitAny: stubbed for assertions
  let aggregateStub: any;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("OrderAggCacheBoundary");
    const repo = createMockRepository(Model) as Record<string, unknown>;
    aggregateStub = vi.fn().mockResolvedValue({ rows: [{ status: "delivered", count: 10 }] });
    repo.aggregate = aggregateStub;

    const resource = defineResource({
      name: "order",
      prefix: "/orders",
      adapter: createMongooseAdapter(Model, repo as never),
      controller: new BaseController(repo as never, {
        resourceName: "order",
        tenantField: false,
      }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      aggregations: {
        cachedDefault: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
          cache: { staleTime: 30, gcTime: 60 },
        }),
        cachedTagged: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
          cache: {
            staleTime: 60,
            gcTime: 600,
            tags: ["orders", "pricing"],
            swr: false,
          },
        }),
        uncached: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
        }),
        materialized: defineAggregation({
          measures: { count: "count" },
          permissions: allowPublic(),
          cache: { staleTime: 30 },
          materialized: async () => ({ rows: [{ count: 999 }] }),
        }),
      },
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("declarative cache: { staleTime, gcTime } → req.cache forwarded to repo.aggregate", async () => {
    aggregateStub.mockClear();

    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/cachedDefault?status=delivered",
    });

    expect(res.statusCode).toBe(200);
    expect(aggregateStub).toHaveBeenCalledTimes(1);
    const req = aggregateStub.mock.calls[0][0];
    expect(req.cache).toBeDefined();
    expect(req.cache.staleTime).toBe(30);
    expect(req.cache.gcTime).toBe(60);
    // arc defaults swr=true for aggregations (dashboards almost always benefit).
    expect(req.cache.swr).toBe(true);
  });

  it("tags + swr override flow through verbatim", async () => {
    aggregateStub.mockClear();

    await app.inject({
      method: "GET",
      url: "/orders/aggregations/cachedTagged",
    });

    const req = aggregateStub.mock.calls[0][0];
    expect(req.cache.staleTime).toBe(60);
    expect(req.cache.gcTime).toBe(600);
    expect(req.cache.tags).toEqual(["orders", "pricing"]);
    expect(req.cache.swr).toBe(false);
  });

  it("no cache config → no cache slot on req (kit plugin falls through)", async () => {
    aggregateStub.mockClear();

    await app.inject({
      method: "GET",
      url: "/orders/aggregations/uncached",
    });

    const req = aggregateStub.mock.calls[0][0];
    expect(req.cache).toBeUndefined();
  });

  it("materialized hook bypasses repo.aggregate entirely (cache config irrelevant)", async () => {
    aggregateStub.mockClear();

    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/materialized",
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).rows).toEqual([{ count: 999 }]);
    expect(aggregateStub).not.toHaveBeenCalled();
    expect(res.headers["x-aggregation-source"]).toBe("materialized");
  });

  it("arc no longer sets x-cache header — observability flows through the kit plugin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/cachedDefault",
    });
    // Hit/miss observability is the kit plugin's `log.onHit/onMiss`
    // callback territory — arc doesn't reinvent the header.
    expect(res.headers["x-cache"]).toBeUndefined();
  });
});
