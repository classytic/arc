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

  it("bracket-shorthand operators translate to canonical Mongo-shape", async () => {
    // Regression: arc 2.14.x and earlier shallow-merged the qs-parsed
    // nested object `{ createdAt: { gte, lte } }` straight into
    // AggRequest.filter. Mongokit < 3.13.1 then matched it as `$eq` of
    // the literal object instead of a range — silent broken behavior.
    // Arc owns URL→IR for aggregations (CRUD goes via QueryParser which
    // does the same translation), so the expansion belongs HERE so kits
    // receive a canonical, kit-portable filter shape.
    aggregateStub.mockClear();

    const from = "2026-01-01T00:00:00.000Z";
    const to = "2026-12-31T23:59:59.999Z";
    await app.inject({
      method: "GET",
      url:
        `/orders/aggregations/revenueByStatus?status=pending` +
        `&createdAt[gte]=${encodeURIComponent(from)}` +
        `&createdAt[lte]=${encodeURIComponent(to)}` +
        `&priority[in]=high,urgent`,
    });

    const calledWith = aggregateStub.mock.calls[0][0];
    const filter = calledWith.filter as Record<string, unknown>;
    expect(filter.status).toBe("pending");
    // Range operators → canonical $gte/$lte with ISO strings coerced to Date
    const createdAt = filter.createdAt as Record<string, unknown>;
    expect(createdAt.$gte).toBeInstanceOf(Date);
    expect(createdAt.$lte).toBeInstanceOf(Date);
    expect((createdAt.$gte as Date).toISOString()).toBe(from);
    expect((createdAt.$lte as Date).toISOString()).toBe(to);
    // Non-range operators preserve their value verbatim under $-prefix
    const priority = filter.priority as Record<string, unknown>;
    expect(priority.$in).toBeDefined();
    // Bare shorthand keys (no `$`) must not leak through
    expect((createdAt as { gte?: unknown }).gte).toBeUndefined();
    expect((createdAt as { lte?: unknown }).lte).toBeUndefined();
  });

  it("non-operator nested objects are NOT misinterpreted as shorthand", async () => {
    // Guard against false positives: equality-matching on an embedded
    // sub-document. arc must only expand objects whose keys are ALL
    // known operators — anything else passes through untouched.
    aggregateStub.mockClear();

    await app.inject({
      method: "GET",
      url: "/orders/aggregations/revenueByStatus?address[city]=NYC",
    });

    const calledWith = aggregateStub.mock.calls[0][0];
    const filter = calledWith.filter as Record<string, unknown>;
    const address = filter.address as Record<string, unknown>;
    // `city` is not a known operator → no `$` translation, original
    // shape preserved for kits to handle as embedded-doc match.
    expect(address.city).toBe("NYC");
    expect(address.$city).toBeUndefined();
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

describe("aggregation routes — tenant scope threading (2.14.3 regression)", () => {
  // Pre-2.14.3: defineResource wired aggregation `buildOptions` as
  // `req => ctrl.tenantRepoOptions(req)` and passed the raw FastifyRequest
  // straight through. `tenantRepoOptions` reads `req.metadata?._scope`,
  // which is only populated by `createRequestContext()` in the CRUD path,
  // so resources declaring `tenantField` WITHOUT `multiTenantPreset` (the
  // preset independently stashes `_tenantFields` on the raw request) saw
  // `organizationId` drop and the kit fail with "Missing organizationId
  // in context". 2.14.3 wraps the conversion at the seam so both surfaces
  // see the same IRequestContext shape.
  let app: FastifyInstance;
  // biome-ignore lint/suspicious/noExplicitAny: stubbed for assertions
  let aggregateStub: any;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("OrderAggTenant");
    const repo = createMockRepository(Model) as Record<string, unknown>;
    aggregateStub = vi.fn().mockResolvedValue({ rows: [] });
    repo.aggregate = aggregateStub;

    const resource = defineResource({
      name: "ordertenant",
      prefix: "/orders-tenant",
      adapter: createMongooseAdapter(Model, repo as never),
      // tenantField on the controller WITHOUT a multiTenantPreset.
      // Path 1 (read scope from metadata._scope) is the only org-id
      // source the controller has under this configuration.
      controller: new BaseController(repo as never, {
        resourceName: "ordertenant",
        tenantField: "organizationId",
      }),
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

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        // Stand-in for the auth adapter — sets req.scope on every
        // request so tenantRepoOptions has something to project.
        f.addHook("onRequest", async (req) => {
          (req as unknown as { scope: unknown }).scope = {
            kind: "member",
            userId: "u-1",
            userRoles: ["admin"],
            organizationId: "org-test-123",
            orgRoles: ["owner"],
          };
        });
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("threads organizationId from req.scope into AggRequest.filter (no preset)", async () => {
    aggregateStub.mockClear();

    const res = await app.inject({
      method: "GET",
      url: "/orders-tenant/aggregations/byStatus",
    });

    expect(res.statusCode).toBe(200);
    expect(aggregateStub).toHaveBeenCalledTimes(1);
    // Arc threads tenant via the SECOND arg of repo.aggregate(req,
    // tenantOptions). It does NOT inject `organizationId` into
    // `aggReq.filter` because arc is DB-agnostic — the kit's
    // multi-tenant plugin owns the type contract (string / ObjectId /
    // UUID / …). Before 2.15.2 arc dual-injected and produced a
    // typed clash (string vs ObjectId) that AND-ed to zero matches.
    const [aggReq, tenantOptions] = aggregateStub.mock.calls[0];
    expect(aggReq.filter?.organizationId).toBeUndefined();
    expect(tenantOptions?.organizationId).toBe("org-test-123");
  });

  it("caller filters compose with tenant scope (tenant via options, caller in filter)", async () => {
    aggregateStub.mockClear();

    await app.inject({
      method: "GET",
      url: "/orders-tenant/aggregations/byStatus?status=delivered",
    });

    const [aggReq, tenantOptions] = aggregateStub.mock.calls[0];
    // Tenant flows via the options arg (kit's plugin will read it).
    expect(tenantOptions?.organizationId).toBe("org-test-123");
    // Caller filters land in `aggReq.filter`.
    expect(aggReq.filter.status).toBe("delivered");
    // Arc deliberately keeps tenant out of the filter slot.
    expect(aggReq.filter.organizationId).toBeUndefined();
  });
});

describe("aggregation routes — scope-variant coverage (2.15.0 sweep)", () => {
  // The 2.14.3 fix wraps FastifyRequest → IRequestContext at the
  // aggregation seam. The original regression test only covered a
  // `member` scope. This block sweeps the other RequestScope kinds
  // arc supports — making sure the conversion is correct under
  // service callers, public callers, and audit-attribution flow.
  let app: FastifyInstance;
  // biome-ignore lint/suspicious/noExplicitAny: stubbed for assertions
  let aggregateStub: any;
  // Scope reference set by a closure so each test can re-arm.
  let currentScope: unknown = null;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("OrderAggScopeSweep");
    const repo = createMockRepository(Model) as Record<string, unknown>;
    aggregateStub = vi.fn().mockResolvedValue({ rows: [] });
    repo.aggregate = aggregateStub;

    const resource = defineResource({
      name: "ordersweep",
      prefix: "/orders-sweep",
      adapter: createMongooseAdapter(Model, repo as never),
      controller: new BaseController(repo as never, {
        resourceName: "ordersweep",
        tenantField: "organizationId",
      }),
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

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        f.addHook("onRequest", async (req) => {
          // Allow each test to swap the scope before injecting the
          // request. A null scope simulates an unauthenticated caller.
          if (currentScope) {
            (req as unknown as { scope: unknown }).scope = currentScope;
          }
        });
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("service scope — organizationId flows from kind:'service' via tenantOptions", async () => {
    aggregateStub.mockClear();
    currentScope = {
      kind: "service",
      clientId: "svc-cron-runner",
      organizationId: "org-sweep-svc",
      scopes: ["aggregations:read"],
    };
    await app.inject({ method: "GET", url: "/orders-sweep/aggregations/byStatus" });
    // Tenant flows via the SECOND arg of repo.aggregate, not the filter.
    // Arc is DB-agnostic — type-coercion is the kit's responsibility.
    const [aggReq, tenantOptions] = aggregateStub.mock.calls[0];
    expect(tenantOptions?.organizationId).toBe("org-sweep-svc");
    expect(aggReq.filter?.organizationId).toBeUndefined();
  });

  it("elevated scope — organizationId flows from kind:'elevated' via tenantOptions", async () => {
    aggregateStub.mockClear();
    currentScope = {
      kind: "elevated",
      userId: "u-platform-admin",
      userRoles: ["superadmin"],
      organizationId: "org-target-by-platform-admin",
      orgRoles: [],
      elevatedFrom: "platform",
    };
    await app.inject({ method: "GET", url: "/orders-sweep/aggregations/byStatus" });
    const [aggReq, tenantOptions] = aggregateStub.mock.calls[0];
    expect(tenantOptions?.organizationId).toBe("org-target-by-platform-admin");
    expect(aggReq.filter?.organizationId).toBeUndefined();
  });

  it("public scope — no tenant filter in AggRequest (allowPublic aggregation, no auth)", async () => {
    aggregateStub.mockClear();
    currentScope = { kind: "public" };
    const res = await app.inject({
      method: "GET",
      url: "/orders-sweep/aggregations/byStatus",
    });
    expect(res.statusCode).toBe(200);
    const aggReq = aggregateStub.mock.calls[0][0];
    // No organizationId on a public scope — controller must NOT inject
    // an undefined value as a filter (would scope away every row).
    if (aggReq.filter !== undefined) {
      expect(aggReq.filter.organizationId).toBeUndefined();
    }
  });

  it("audit attribution — userId/requestId flow into tenantOptions, never into the filter", async () => {
    // tenantRepoOptions returns userId / user / requestId in the same
    // bag as organizationId. None of those audit keys may leak into
    // the AggRequest filter — they are operation context, not query
    // predicates. As of 2.15.2, organizationId itself ALSO stays out
    // of the filter (arc is DB-agnostic — kit owns the type contract).
    aggregateStub.mockClear();
    currentScope = {
      kind: "member",
      userId: "u-audit-target",
      userRoles: [],
      organizationId: "org-audit",
      orgRoles: ["member"],
    };
    await app.inject({ method: "GET", url: "/orders-sweep/aggregations/byStatus" });
    const [aggReq, tenantOptions] = aggregateStub.mock.calls[0];
    // tenant flows via the options arg (userId may also be there
    // when req.user is set by the auth middleware — controller reads
    // it from req.user, NOT from scope.userId).
    expect(tenantOptions?.organizationId).toBe("org-audit");
    // filter stays clean — no tenant, no audit IDs
    if (aggReq.filter !== undefined) {
      expect(aggReq.filter.organizationId).toBeUndefined();
      expect(aggReq.filter.userId).toBeUndefined();
      expect(aggReq.filter.user).toBeUndefined();
      expect(aggReq.filter.requestId).toBeUndefined();
    }
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
