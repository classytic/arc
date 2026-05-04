/**
 * MCP tool generation for aggregations.
 *
 * Verifies `buildAggregationTools()` produces one MCP tool per
 * declared aggregation, with the right name, description, input
 * schema, and that the handler runs the same `executeAggregation`
 * pipeline (permission check + safety guards + repo.aggregate).
 */

import { describe, expect, it, vi } from "vitest";
import { defineAggregation } from "../../../src/core/aggregation/index.js";
import { buildAggregationTools } from "../../../src/integrations/mcp/aggregation-tools.js";
import { allowPublic, requireRoles } from "../../../src/permissions/index.js";

function makeStubRepo() {
  return {
    aggregate: vi.fn().mockResolvedValue({
      rows: [
        { status: "delivered", count: 42 },
        { status: "pending", count: 12 },
      ],
    }),
  };
}

function makeAdminSession() {
  return {
    user: { id: "u-admin", roles: ["admin"] },
    scope: { kind: "member", organizationId: "org-1", userId: "u-admin" },
    requestId: "r-1",
  };
}

function buildOptionsFromSession(session: unknown): Record<string, unknown> {
  const s = session as ReturnType<typeof makeAdminSession>;
  return {
    organizationId: s.scope.organizationId,
    userId: s.scope.userId,
    user: s.user,
    requestId: s.requestId,
  };
}

describe("MCP — aggregation tool generation", () => {
  it("emits one tool per declared aggregation", () => {
    const tools = buildAggregationTools({
      resourceName: "order",
      displayName: "Order",
      aggregations: {
        revenueByStatus: defineAggregation({
          groupBy: "status",
          measures: { count: "count", revenue: "sum:totalPrice" },
          permissions: requireRoles(["admin"]),
        }),
        topCustomers: defineAggregation({
          groupBy: "customerId",
          measures: { ltv: "sum:totalPrice" },
          permissions: requireRoles(["admin"]),
        }),
      },
      schemaOptions: undefined,
      repo: makeStubRepo(),
      buildOptionsFromSession,
    });

    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual([
      "aggregation_revenueByStatus_order",
      "aggregation_topCustomers_order",
    ]);
  });

  it("returns empty when no aggregations declared", () => {
    const tools = buildAggregationTools({
      resourceName: "order",
      displayName: "Order",
      aggregations: undefined,
      schemaOptions: undefined,
      repo: makeStubRepo(),
      buildOptionsFromSession,
    });
    expect(tools).toEqual([]);
  });

  it("`mcp: false` opts a specific aggregation out of MCP (REST still works)", () => {
    const tools = buildAggregationTools({
      resourceName: "order",
      displayName: "Order",
      aggregations: {
        public: defineAggregation({
          measures: { count: "count" },
          permissions: allowPublic(),
        }),
        internalOnly: defineAggregation({
          measures: { count: "count" },
          permissions: allowPublic(),
          mcp: false, // exclude from MCP
        }),
      },
      schemaOptions: undefined,
      repo: makeStubRepo(),
      buildOptionsFromSession,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("aggregation_public_order");
  });

  it("annotation defaults — readOnlyHint + idempotentHint (aggregations are read-shape)", () => {
    const tools = buildAggregationTools({
      resourceName: "order",
      displayName: "Order",
      aggregations: {
        revenueByStatus: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
        }),
      },
      schemaOptions: undefined,
      repo: makeStubRepo(),
      buildOptionsFromSession,
    });
    expect(tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
  });

  it("description summarizes groupBy + measures + safety knobs", () => {
    const tools = buildAggregationTools({
      resourceName: "order",
      displayName: "Order",
      aggregations: {
        revenueByStatus: defineAggregation({
          summary: "Revenue grouped by status",
          groupBy: "status",
          measures: { count: "count", revenue: "sum:totalPrice" },
          permissions: requireRoles(["admin"]),
          requireDateRange: { field: "createdAt", maxRangeDays: 30 },
          requireFilters: ["customerId"],
        }),
      },
      schemaOptions: undefined,
      repo: makeStubRepo(),
      buildOptionsFromSession,
    });
    const desc = tools[0]?.description ?? "";
    expect(desc).toContain("Revenue grouped by status");
    expect(desc).toContain("status");
    expect(desc).toContain("count");
    expect(desc).toContain("revenue");
    expect(desc).toMatch(/30 days/);
    expect(desc).toMatch(/customerId/);
  });

  it("input schema exposes a `filter` record", () => {
    const tools = buildAggregationTools({
      resourceName: "order",
      displayName: "Order",
      aggregations: {
        revenueByStatus: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
        }),
      },
      schemaOptions: undefined,
      repo: makeStubRepo(),
      buildOptionsFromSession,
    });
    expect(tools[0]?.inputSchema?.filter).toBeDefined();
  });

  it("handler invokes repo.aggregate with composed AggRequest (tenant + caller filter)", async () => {
    const repo = makeStubRepo();
    const tools = buildAggregationTools({
      resourceName: "order",
      displayName: "Order",
      aggregations: {
        revenueByStatus: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
        }),
      },
      schemaOptions: undefined,
      repo,
      buildOptionsFromSession,
    });

    const handler = tools[0]?.handler;
    const result = await handler?.(
      { filter: { status: "delivered" } },
      // biome-ignore lint/suspicious/noExplicitAny: tool ctx for test
      { session: makeAdminSession(), log: () => Promise.resolve() } as any,
    );

    expect(result.isError).toBeFalsy();
    expect(repo.aggregate).toHaveBeenCalledTimes(1);
    const req = repo.aggregate.mock.calls[0][0];
    expect(req.filter).toMatchObject({
      organizationId: "org-1", // tenant injected
      status: "delivered", // caller filter
    });
  });

  it("denies the call when permissions check fails", async () => {
    const repo = makeStubRepo();
    const tools = buildAggregationTools({
      resourceName: "order",
      displayName: "Order",
      aggregations: {
        adminOnly: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: requireRoles(["admin"]),
        }),
      },
      schemaOptions: undefined,
      repo,
      buildOptionsFromSession,
    });

    const handler = tools[0]?.handler;
    const noPermSession = {
      user: { id: "u-guest", roles: ["user"] },
      scope: { kind: "member", organizationId: "org-1", userId: "u-guest" },
    };
    const result = await handler?.(
      {},
      // biome-ignore lint/suspicious/noExplicitAny: tool ctx for test
      { session: noPermSession, log: () => Promise.resolve() } as any,
    );

    expect(result.isError).toBe(true);
    expect(repo.aggregate).not.toHaveBeenCalled();
  });

  it("returns 400-shaped error when requireFilters missing", async () => {
    const repo = makeStubRepo();
    const tools = buildAggregationTools({
      resourceName: "order",
      displayName: "Order",
      aggregations: {
        guarded: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
          requireFilters: ["customerId"],
        }),
      },
      schemaOptions: undefined,
      repo,
      buildOptionsFromSession,
    });

    const result = await tools[0]?.handler?.(
      { filter: {} },
      // biome-ignore lint/suspicious/noExplicitAny: tool ctx for test
      { session: makeAdminSession(), log: () => Promise.resolve() } as any,
    );

    expect(result?.isError).toBe(true);
    expect(repo.aggregate).not.toHaveBeenCalled();
  });
});
