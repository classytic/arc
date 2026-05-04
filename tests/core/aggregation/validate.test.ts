/**
 * Boot-time validation + measure-shorthand normalization tests for
 * `validateAggregations()`.
 *
 * These run without Fastify — pure config-time checks. Misconfigs
 * throw `ArcAggregationConfigError` with the offending aggregation
 * name in the message so hosts see exactly what to fix.
 */

import { describe, expect, it } from "vitest";
import {
  ArcAggregationConfigError,
  adapterSupportsAggregate,
  compileAggRequest,
  validateAggregations,
} from "../../../src/core/aggregation/validate.js";
import { allowPublic, requireRoles } from "../../../src/permissions/index.js";

describe("validateAggregations — happy path", () => {
  it("normalizes measure shorthand to AggMeasure IR", () => {
    const [normalized] = validateAggregations(
      "order",
      {
        revenueByStatus: {
          groupBy: "status",
          measures: {
            count: "count",
            revenue: "sum:totalPrice",
            avgRating: "avg:rating",
            uniqueCustomers: "countDistinct:customerId",
          },
          permissions: requireRoles(["admin"]),
        },
      },
      undefined,
    );

    expect(normalized?.compiled.measures).toEqual({
      count: { op: "count" },
      revenue: { op: "sum", field: "totalPrice" },
      avgRating: { op: "avg", field: "rating" },
      uniqueCustomers: { op: "countDistinct", field: "customerId" },
    });
  });

  it("accepts AggMeasure IR objects directly (no shorthand)", () => {
    const [normalized] = validateAggregations(
      "order",
      {
        sumRevenue: {
          measures: { revenue: { op: "sum", field: "totalPrice" } },
          permissions: requireRoles(["admin"]),
        },
      },
      undefined,
    );

    expect(normalized?.compiled.measures.revenue).toEqual({
      op: "sum",
      field: "totalPrice",
    });
  });

  it("normalizes string groupBy to array form", () => {
    const [normalized] = validateAggregations(
      "order",
      {
        byStatus: {
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
        },
      },
      undefined,
    );

    expect(normalized?.compiled.groupBy).toEqual(["status"]);
  });

  it("preserves array groupBy", () => {
    const [normalized] = validateAggregations(
      "order",
      {
        byStatusAndRegion: {
          groupBy: ["status", "region"],
          measures: { count: "count" },
          permissions: allowPublic(),
        },
      },
      undefined,
    );

    expect(normalized?.compiled.groupBy).toEqual(["status", "region"]);
  });

  it("accepts dotted-path measure fields when matching lookup exists", () => {
    const [normalized] = validateAggregations(
      "order",
      {
        avgCategoryBasePrice: {
          lookups: [
            {
              from: "product",
              localField: "productId",
              foreignField: "_id",
              as: "product",
            },
          ],
          measures: { avgBase: "avg:product.basePrice" },
          permissions: requireRoles(["admin"]),
        },
      },
      undefined,
    );

    expect(normalized?.compiled.lookups?.[0]?.from).toBe("product");
    expect(normalized?.compiled.measures.avgBase).toEqual({
      op: "avg",
      field: "product.basePrice",
    });
  });
});

describe("validateAggregations — boot errors", () => {
  it("throws when permissions missing", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          revenueByStatus: {
            groupBy: "status",
            measures: { count: "count" },
            // no permissions
          } as never,
        },
        undefined,
      ),
    ).toThrow(/missing a "permissions" check/);
  });

  it("throws when measures bag is empty", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          empty: {
            measures: {},
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/has no measures/);
  });

  it("throws on invalid measure shorthand", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          bad: {
            measures: { x: "garbage:field" } as never,
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/invalid shorthand/);
  });

  it("throws on aggregation key that wouldn't be safe in a URL", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          "../etc/passwd": {
            measures: { count: "count" },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/keys map to URL segments/);
  });

  it("rejects groupBy on hidden field", () => {
    expect(() =>
      validateAggregations(
        "user",
        {
          byPasswordHash: {
            groupBy: "passwordHash",
            measures: { count: "count" },
            permissions: requireRoles(["admin"]),
          },
        },
        { fieldRules: { passwordHash: { hidden: true } } },
      ),
    ).toThrow(/marked hidden or systemManaged/);
  });

  it("rejects measure field referencing systemManaged field", () => {
    expect(() =>
      validateAggregations(
        "user",
        {
          sumInternal: {
            measures: { total: "sum:internalCounter" },
            permissions: requireRoles(["admin"]),
          },
        },
        { fieldRules: { internalCounter: { systemManaged: true } } },
      ),
    ).toThrow(/marked hidden or systemManaged/);
  });

  it("accepts dotted-path references as nested embedded-document fields", () => {
    // A dotted path whose head doesn't match a declared lookup is treated as
    // a nested embedded-document field on the base resource (e.g.
    // `totals.grandTotal.amount` on an Order doc). Validator only enforces
    // blocked-field policy on the head segment.
    expect(() =>
      validateAggregations(
        "order",
        {
          revenueByCategoryParent: {
            groupBy: "category.parent",
            measures: { revenue: "sum:totals.grandTotal" },
            permissions: requireRoles(["admin"]),
          },
        },
        undefined,
      ),
    ).not.toThrow();
  });

  it("rejects dotted-path reference whose root is hidden/systemManaged", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          leakInternals: {
            groupBy: "internalAudit.actor",
            measures: { revenue: "sum:totalPrice" },
            permissions: requireRoles(["admin"]),
          },
        },
        { fieldRules: { internalAudit: { hidden: true } } },
      ),
    ).toThrow(/marked hidden or systemManaged/);
  });

  it("error class is identifiable for catching", () => {
    try {
      validateAggregations(
        "order",
        {
          bad: {
            measures: {},
            permissions: allowPublic(),
          },
        },
        undefined,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(ArcAggregationConfigError);
      expect((err as Error).name).toBe("ArcAggregationConfigError");
      return;
    }
    throw new Error("expected validateAggregations to throw");
  });
});

describe("compileAggRequest — runtime IR composition", () => {
  it("composes filter as: tenant FIRST → host base → caller", () => {
    const [normalized] = validateAggregations(
      "order",
      {
        byStatus: {
          filter: { archived: false },
          groupBy: "status",
          measures: { count: "count" },
          permissions: requireRoles(["admin"]),
        },
      },
      undefined,
    );
    if (!normalized) throw new Error("expected normalized aggregation");

    const req = compileAggRequest(
      normalized,
      { customerId: "c-42" }, // caller URL filter
      { organizationId: "org-1", userId: "u-1", requestId: "r-99" }, // tenant + audit options
    );

    // tenant first, host next, caller last
    expect(req.filter).toEqual({
      organizationId: "org-1",
      archived: false,
      customerId: "c-42",
    });
    // userId / requestId / session / user MUST NOT leak into the filter
    expect((req.filter as Record<string, unknown>).userId).toBeUndefined();
    expect((req.filter as Record<string, unknown>).requestId).toBeUndefined();
  });

  it("omits filter when empty (no tenant, no base, no caller)", () => {
    const [normalized] = validateAggregations(
      "order",
      {
        scalarSum: {
          measures: { total: "sum:amount" },
          permissions: allowPublic(),
        },
      },
      undefined,
    );
    if (!normalized) throw new Error("expected normalized aggregation");

    const req = compileAggRequest(normalized, {}, {});

    expect(req.filter).toBeUndefined();
    expect(req.measures).toEqual({ total: { op: "sum", field: "amount" } });
  });

  it("threads lookups through to the AggRequest", () => {
    const [normalized] = validateAggregations(
      "order",
      {
        revenueByCategoryParent: {
          lookups: [
            {
              from: "category",
              localField: "categoryId",
              foreignField: "_id",
              as: "category",
              single: true,
            },
          ],
          groupBy: "category.parent",
          measures: { revenue: "sum:totalPrice" },
          permissions: requireRoles(["admin"]),
        },
      },
      undefined,
    );
    if (!normalized) throw new Error("expected normalized aggregation");

    const req = compileAggRequest(normalized, {}, {});

    expect(req.lookups).toHaveLength(1);
    expect(req.lookups?.[0]?.as).toBe("category");
    expect(req.groupBy).toEqual(["category.parent"]);
  });
});

describe("validateAggregations — percentile measure", () => {
  it("expands 'percentile:field:p' shorthand to AggMeasure IR", () => {
    const [normalized] = validateAggregations(
      "request",
      {
        latencyP95: {
          measures: { p95: "percentile:latency:0.95" },
          permissions: requireRoles(["admin"]),
        },
      },
      undefined,
    );
    expect(normalized?.compiled.measures.p95).toEqual({
      op: "percentile",
      field: "latency",
      p: 0.95,
    });
  });

  it("expands median shorthand 'percentile:field:0.5'", () => {
    const [normalized] = validateAggregations(
      "request",
      {
        latencyMedian: {
          measures: { p50: "percentile:latency:0.5" },
          permissions: requireRoles(["admin"]),
        },
      },
      undefined,
    );
    expect(normalized?.compiled.measures.p50).toEqual({
      op: "percentile",
      field: "latency",
      p: 0.5,
    });
  });

  it("accepts AggMeasure IR object directly (no shorthand)", () => {
    const [normalized] = validateAggregations(
      "request",
      {
        latencyP99: {
          measures: { p99: { op: "percentile", field: "latency", p: 0.99 } },
          permissions: requireRoles(["admin"]),
        },
      },
      undefined,
    );
    expect(normalized?.compiled.measures.p99).toEqual({
      op: "percentile",
      field: "latency",
      p: 0.99,
    });
  });

  it("accepts boundary values p=0 and p=1", () => {
    expect(() =>
      validateAggregations(
        "request",
        {
          edges: {
            measures: {
              minP: "percentile:latency:0",
              maxP: "percentile:latency:1",
            },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).not.toThrow();
  });

  it("rejects p > 1 (shorthand)", () => {
    expect(() =>
      validateAggregations(
        "request",
        {
          bad: {
            measures: { tooBig: "percentile:latency:1.5" },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/percentile p=1\.5 — must be a finite number in \[0, 1\]/);
  });

  it("rejects p < 0 (shorthand)", () => {
    expect(() =>
      validateAggregations(
        "request",
        {
          bad: {
            measures: { negative: "percentile:latency:-0.1" },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/percentile p=-0\.1/);
  });

  it("rejects non-numeric p (shorthand)", () => {
    expect(() =>
      validateAggregations(
        "request",
        {
          bad: {
            // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
            measures: { junk: "percentile:latency:abc" as any },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/invalid shorthand/);
  });

  it("rejects p outside range when passed as IR object", () => {
    expect(() =>
      validateAggregations(
        "request",
        {
          bad: {
            measures: { tooBig: { op: "percentile", field: "latency", p: 2 } },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(ArcAggregationConfigError);
  });

  it("rejects NaN p (IR object)", () => {
    expect(() =>
      validateAggregations(
        "request",
        {
          bad: {
            measures: { junk: { op: "percentile", field: "latency", p: Number.NaN } },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/must be a finite number/);
  });

  it("rejects 'percentile:latency' without p segment", () => {
    expect(() =>
      validateAggregations(
        "request",
        {
          bad: {
            // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
            measures: { incomplete: "percentile:latency" as any },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/invalid shorthand/);
  });
});

describe("validateAggregations — dateBuckets", () => {
  it("threads dateBuckets through to the AggRequest IR", () => {
    const [normalized] = validateAggregations(
      "order",
      {
        monthlyRevenue: {
          dateBuckets: { month: { field: "createdAt", interval: "month" } },
          measures: { revenue: "sum:totalPrice" },
          permissions: requireRoles(["admin"]),
        },
      },
      undefined,
    );
    if (!normalized) throw new Error("expected normalized aggregation");

    const req = compileAggRequest(normalized, {}, {});
    expect(req.dateBuckets).toEqual({
      month: { field: "createdAt", interval: "month" },
    });
  });

  it("accepts custom-bin form ({ every, unit })", () => {
    expect(() =>
      validateAggregations(
        "event",
        {
          slot15: {
            dateBuckets: {
              slot: { field: "ts", interval: { every: 15, unit: "minute" } },
            },
            measures: { hits: "count" },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).not.toThrow();
  });

  it("rejects bucket alias that collides with a groupBy field", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          bad: {
            groupBy: "status",
            dateBuckets: { status: { field: "createdAt", interval: "day" } },
            measures: { count: "count" },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/dateBucket alias "status" collides with a groupBy field/);
  });

  it("rejects bucket alias that collides with a measure alias", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          bad: {
            dateBuckets: { count: { field: "createdAt", interval: "day" } },
            measures: { count: "count" },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/dateBucket alias "count" collides with a measure alias/);
  });

  it("rejects unknown named-interval value", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          bad: {
            dateBuckets: {
              // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
              fortnight: { field: "createdAt", interval: "fortnight" as any },
            },
            measures: { count: "count" },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/not a recognized unit/);
  });

  it("rejects custom-bin form with non-positive every", () => {
    expect(() =>
      validateAggregations(
        "event",
        {
          bad: {
            dateBuckets: {
              slot: { field: "ts", interval: { every: 0, unit: "minute" } },
            },
            measures: { count: "count" },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/interval\.every must be a positive integer/);
  });

  it("rejects quarter / year in custom-bin form", () => {
    expect(() =>
      validateAggregations(
        "event",
        {
          bad: {
            dateBuckets: {
              // biome-ignore lint/suspicious/noExplicitAny: testing rejection
              q: { field: "ts", interval: { every: 1, unit: "quarter" as any } },
            },
            measures: { count: "count" },
            permissions: allowPublic(),
          },
        },
        undefined,
      ),
    ).toThrow(/not valid in custom-bin form/);
  });

  it("rejects bucket field that's hidden via fieldRules", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          bad: {
            dateBuckets: { day: { field: "secretAt", interval: "day" } },
            measures: { count: "count" },
            permissions: allowPublic(),
          },
        },
        { fieldRules: { secretAt: { hidden: true } } },
      ),
    ).toThrow(/marked hidden or systemManaged/);
  });

  it("topN.partitionBy can reference a dateBucket alias", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          topPerMonth: {
            dateBuckets: { month: { field: "createdAt", interval: "month" } },
            groupBy: "customerId",
            measures: { spent: "sum:totalPrice" },
            topN: {
              partitionBy: "month",
              sortBy: { spent: -1 },
              limit: 5,
            },
            permissions: requireRoles(["admin"]),
          },
        },
        undefined,
      ),
    ).not.toThrow();
  });

  it("sort key may reference a dateBucket alias", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          monthlyOrdered: {
            dateBuckets: { month: { field: "createdAt", interval: "month" } },
            measures: { revenue: "sum:totalPrice" },
            sort: { month: 1 },
            permissions: requireRoles(["admin"]),
          },
        },
        undefined,
      ),
    ).not.toThrow();
  });
});

describe("validateAggregations — topN", () => {
  it("threads topN through to the AggRequest IR", () => {
    const [normalized] = validateAggregations(
      "order",
      {
        topProductsPerCategory: {
          groupBy: ["category", "product"],
          measures: { revenue: "sum:totalPrice" },
          topN: {
            partitionBy: "category",
            sortBy: { revenue: -1 },
            limit: 3,
          },
          permissions: requireRoles(["admin"]),
        },
      },
      undefined,
    );
    if (!normalized) throw new Error("expected normalized aggregation");

    const req = compileAggRequest(normalized, {}, {});
    expect(req.topN).toEqual({
      partitionBy: "category",
      sortBy: { revenue: -1 },
      limit: 3,
    });
  });

  it("accepts measure-alias partitionBy (rank by groupBy, partition by measure)", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          topByRevenue: {
            groupBy: "status",
            measures: { revenue: "sum:totalPrice" },
            topN: {
              partitionBy: "revenue",
              sortBy: { status: 1 },
              limit: 5,
            },
            permissions: requireRoles(["admin"]),
          },
        },
        undefined,
      ),
    ).not.toThrow();
  });

  it("rejects partitionBy that isn't a groupBy field or measure alias", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          bad: {
            groupBy: "status",
            measures: { count: "count" },
            topN: {
              partitionBy: "nonExistentField",
              sortBy: { count: -1 },
              limit: 3,
            },
            permissions: requireRoles(["admin"]),
          },
        },
        undefined,
      ),
    ).toThrow(/topN\.partitionBy "nonExistentField"/);
  });

  it("rejects non-positive limit", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          bad: {
            groupBy: "status",
            measures: { count: "count" },
            topN: {
              partitionBy: "status",
              sortBy: { count: -1 },
              limit: 0,
            },
            permissions: requireRoles(["admin"]),
          },
        },
        undefined,
      ),
    ).toThrow(/topN\.limit must be a positive integer/);
  });

  it("rejects empty sortBy (no ranking field)", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          bad: {
            groupBy: "status",
            measures: { count: "count" },
            topN: {
              partitionBy: "status",
              sortBy: {},
              limit: 3,
            },
            permissions: requireRoles(["admin"]),
          },
        },
        undefined,
      ),
    ).toThrow(ArcAggregationConfigError);
  });

  it("accepts compound partitionBy (array of groupBy fields)", () => {
    expect(() =>
      validateAggregations(
        "order",
        {
          ok: {
            groupBy: ["region", "month"],
            measures: { spent: "sum:amount" },
            topN: {
              partitionBy: ["region", "month"],
              sortBy: { spent: -1 },
              limit: 1,
              ties: "row_number",
            },
            permissions: requireRoles(["admin"]),
          },
        },
        undefined,
      ),
    ).not.toThrow();
  });
});

describe("adapterSupportsAggregate", () => {
  it("returns true when repo has aggregate function", () => {
    const repo = { aggregate: () => Promise.resolve({ rows: [] }) };
    expect(adapterSupportsAggregate(repo)).toBe(true);
  });

  it("returns false when repo lacks aggregate", () => {
    expect(adapterSupportsAggregate({})).toBe(false);
    expect(adapterSupportsAggregate(null)).toBe(false);
    expect(adapterSupportsAggregate({ aggregate: "not a function" })).toBe(false);
  });
});
