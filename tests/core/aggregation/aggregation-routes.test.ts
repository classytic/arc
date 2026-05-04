/**
 * End-to-end tests for aggregation routes registered via
 * `defineResource({ aggregations: { ... } })`.
 *
 * Stubs `repo.aggregate()` so the test stays adapter-agnostic — the
 * aggregation router doesn't care what the kit's compiler does, only
 * that it returns `{ rows }`. Real cross-kit verification happens in
 * mongokit/sqlitekit suites.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defineAggregation } from "../../../src/core/aggregation/index.js";
import { BaseController } from "../../../src/core/BaseController.js";
import { defineResource } from "../../../src/core/defineResource.js";
import { createApp } from "../../../src/factory/createApp.js";
import { allowPublic, requireRoles } from "../../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../../setup.js";

describe("aggregation routes — end-to-end", () => {
  let app: FastifyInstance;
  // biome-ignore lint/suspicious/noExplicitAny: stubbed for assertions
  let aggregateStub: any;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("OrderAgg");
    const repo = createMockRepository(Model) as Record<string, unknown>;

    // Stub repo.aggregate — the test asserts arc routes correctly to
    // the kit, NOT the kit's own aggregate compile path.
    aggregateStub = vi.fn().mockResolvedValue({
      rows: [
        { status: "delivered", count: 42, revenue: 8200 },
        { status: "pending", count: 12, revenue: 1500 },
      ],
    });
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
      schemaOptions: {
        fieldRules: {
          internalFlag: { systemManaged: true },
        },
      },
      aggregations: {
        // Public, simple
        revenueByStatus: defineAggregation({
          groupBy: "status",
          measures: { count: "count", revenue: "sum:totalPrice" },
          permissions: allowPublic(),
        }),

        // Auth required → 401 when no user
        adminOnly: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: requireRoles(["admin"]),
        }),

        // Filter requirement
        requiresCustomerFilter: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
          requireFilters: ["customerId"],
        }),

        // Date range requirement with cap
        requiresDateRange: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
          requireDateRange: { field: "createdAt", maxRangeDays: 30 },
        }),

        // maxGroups guard
        cappedGroups: defineAggregation({
          groupBy: "customerId",
          measures: { count: "count" },
          permissions: allowPublic(),
          maxGroups: 1,
        }),

        // Materialized hook bypass
        materializedRevenue: defineAggregation({
          measures: { total: "sum:totalPrice" },
          permissions: allowPublic(),
          materialized: async () => ({
            rows: [{ total: 999_000 }],
          }),
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

  it("happy path — GET /orders/aggregations/revenueByStatus → repo.aggregate(req)", async () => {
    aggregateStub.mockClear();

    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/revenueByStatus",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({ status: "delivered", count: 42, revenue: 8200 });

    expect(aggregateStub).toHaveBeenCalledTimes(1);
    const calledWith = aggregateStub.mock.calls[0][0];
    expect(calledWith.measures).toEqual({
      count: { op: "count" },
      revenue: { op: "sum", field: "totalPrice" },
    });
    expect(calledWith.groupBy).toEqual(["status"]);
  });

  it("query string filters narrow the AggRequest filter (caller wins)", async () => {
    aggregateStub.mockClear();

    await app.inject({
      method: "GET",
      url: "/orders/aggregations/revenueByStatus?status=pending&customerId=c-42",
    });

    const calledWith = aggregateStub.mock.calls[0][0];
    expect(calledWith.filter).toMatchObject({
      status: "pending",
      customerId: "c-42",
    });
  });

  it("control params (page, limit, _count) are stripped from filter", async () => {
    aggregateStub.mockClear();

    await app.inject({
      method: "GET",
      url: "/orders/aggregations/revenueByStatus?page=2&limit=10&_count=true&status=pending",
    });

    const calledWith = aggregateStub.mock.calls[0][0];
    const filter = calledWith.filter as Record<string, unknown>;
    expect(filter.page).toBeUndefined();
    expect(filter.limit).toBeUndefined();
    expect(filter._count).toBeUndefined();
    expect(filter.status).toBe("pending");
  });

  it("requireFilters — 400 when caller doesn't supply the named filter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/requiresCustomerFilter",
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/requires filter on "customerId"/);
  });

  it("requireFilters — 200 when caller supplies the named filter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/requiresCustomerFilter?customerId=c-42",
    });

    expect(res.statusCode).toBe(200);
  });

  it("requireDateRange — 400 when no range in query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/requiresDateRange",
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/bounded date range on "createdAt"/);
  });

  it("requireDateRange — 400 when range exceeds maxRangeDays", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/requiresDateRange?createdAt[gte]=2026-01-01&createdAt[lte]=2026-12-31",
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/exceeds the cap \(30 days\)/);
  });

  it("requireDateRange — 200 with valid range under the cap", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/requiresDateRange?createdAt[gte]=2026-04-01&createdAt[lte]=2026-04-15",
    });

    expect(res.statusCode).toBe(200);
  });

  it("maxGroups — 422 when result row count exceeds cap", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/cappedGroups",
    });

    // stub returns 2 rows, cap is 1
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).message).toMatch(/exceeding maxGroups \(1\)/);
  });

  it("materialized hook bypasses repo.aggregate entirely", async () => {
    aggregateStub.mockClear();

    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/materializedRevenue",
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).rows).toEqual([{ total: 999_000 }]);
    // Materialized hook ran instead of repo.aggregate
    expect(aggregateStub).not.toHaveBeenCalled();
    expect(res.headers["x-aggregation-source"]).toBe("materialized");
  });

  it("permission denial — 401 when auth required and no user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/adminOnly",
    });

    expect([401, 403]).toContain(res.statusCode);
  });

  it("unknown aggregation name — 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders/aggregations/doesNotExist",
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("aggregation routes — executionHints", () => {
  let app: FastifyInstance;
  // biome-ignore lint/suspicious/noExplicitAny: stubbed for assertions
  let aggregateStub: any;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("OrderAggHints");
    const repo = createMockRepository(Model) as Record<string, unknown>;
    aggregateStub = vi.fn().mockResolvedValue({ rows: [{ count: 1 }] });
    repo.aggregate = aggregateStub;

    const resource = defineResource({
      name: "orderhints",
      prefix: "/orders-hints",
      adapter: createMongooseAdapter(Model, repo as never),
      controller: new BaseController(repo as never, {
        resourceName: "orderhints",
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
        // timeout → executionHints.maxTimeMs
        slow: defineAggregation({
          measures: { count: "count" },
          permissions: allowPublic(),
          timeout: 5_000,
        }),
        // indexHint.leadingKeys → executionHints.indexHint as { field: 1, ... }
        hinted: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
          indexHint: { leadingKeys: ["organizationId", "status"] },
        }),
        // No hints — executionHints absent from AggRequest
        plain: defineAggregation({
          measures: { count: "count" },
          permissions: allowPublic(),
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

  it("timeout → AggRequest.executionHints.maxTimeMs (portable channel)", async () => {
    aggregateStub.mockClear();
    await app.inject({ method: "GET", url: "/orders-hints/aggregations/slow" });
    const req = aggregateStub.mock.calls[0][0];
    expect(req.executionHints).toBeDefined();
    expect(req.executionHints.maxTimeMs).toBe(5_000);
  });

  it("indexHint.leadingKeys → executionHints.indexHint as { field: 1 }", async () => {
    aggregateStub.mockClear();
    await app.inject({ method: "GET", url: "/orders-hints/aggregations/hinted" });
    const req = aggregateStub.mock.calls[0][0];
    expect(req.executionHints?.indexHint).toEqual({ organizationId: 1, status: 1 });
  });

  it("no hints → executionHints absent from request", async () => {
    aggregateStub.mockClear();
    await app.inject({ method: "GET", url: "/orders-hints/aggregations/plain" });
    const req = aggregateStub.mock.calls[0][0];
    expect(req.executionHints).toBeUndefined();
  });
});

describe("aggregation routes — adapter without aggregate()", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("OrderNoAgg");
    // Real mongokit Repository would ship aggregate, so build a thin
    // wrapper that proxies the methods the controller needs but
    // omits aggregate. Adapter feature-detect should return false.
    const baseRepo = createMockRepository(Model) as Record<string, unknown>;
    const repo: Record<string, unknown> = {
      idField: baseRepo.idField,
      getAll: baseRepo.getAll?.bind(baseRepo),
      getById: baseRepo.getById?.bind(baseRepo),
      create: baseRepo.create?.bind(baseRepo),
      update: baseRepo.update?.bind(baseRepo),
      delete: baseRepo.delete?.bind(baseRepo),
      updateMany: baseRepo.updateMany?.bind(baseRepo),
      deleteMany: baseRepo.deleteMany?.bind(baseRepo),
      claim: baseRepo.claim?.bind(baseRepo),
      claimVersion: baseRepo.claimVersion?.bind(baseRepo),
      // NO aggregate property
    };

    const resource = defineResource({
      name: "order",
      prefix: "/orders-no-agg",
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
        revenueByStatus: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
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

  it("returns 501 when adapter doesn't ship aggregate()", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders-no-agg/aggregations/revenueByStatus",
    });

    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).message).toMatch(/does not implement repo\.aggregate/);
  });
});

describe("aggregation routes — boot validation errors", () => {
  it("missing permissions → defineResource registration throws", async () => {
    const Model = createMockModel("OrderBootBad");
    const repo = createMockRepository(Model) as Record<string, unknown>;
    repo.aggregate = vi.fn().mockResolvedValue({ rows: [] });

    const resource = defineResource({
      name: "order",
      prefix: "/orders-boot",
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
        bad: {
          measures: { count: "count" },
          // permissions intentionally omitted
        } as never,
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
    ).rejects.toThrow(/missing a "permissions" check/);
  });
});
