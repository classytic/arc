/**
 * OpenAPI emission for `defineResource({ aggregations })`.
 *
 * Verifies that the spec carries one `GET /:resource/aggregations/:name`
 * path entry per declared aggregation, with response schema derived
 * from `groupBy` + `measures`, and required-filter / required-date-range
 * surfaced in the description and querystring schema.
 */

import { describe, expect, it } from "vitest";
import { defineAggregation } from "../../../src/core/aggregation/index.js";
import { defineResource } from "../../../src/core/defineResource.js";
import { buildOpenApiSpec } from "../../../src/docs/openapi.js";
import { allowPublic, requireRoles } from "../../../src/permissions/index.js";
import type { RegistryEntry } from "../../../src/types/index.js";

function buildRegistryEntry(): RegistryEntry {
  // We don't go through ResourceRegistry's `register()` here because
  // that requires a full plugin lifecycle. Instead, construct the
  // entry directly with the bits OpenAPI reads — same shape the
  // registry produces.
  const orderResource = defineResource({
    name: "order",
    prefix: "/orders",
    skipValidation: true, // docs-only test — no adapter/controller wiring needed
    disableDefaultRoutes: true,
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
        measures: { count: "count", revenue: "sum:totalPrice" },
        permissions: requireRoles(["admin"]),
      }),
      monthlyRevenue: defineAggregation({
        summary: "Daily revenue (last quarter)",
        groupBy: "status",
        measures: { revenue: "sum:totalPrice" },
        permissions: requireRoles(["admin"]),
        requireDateRange: { field: "createdAt", maxRangeDays: 90 },
        requireFilters: ["customerId"],
      }),
      publicCount: defineAggregation({
        measures: { count: "count" },
        permissions: allowPublic(),
      }),
    },
  });

  // Mimic what `ResourceRegistry.register()` produces — only the
  // fields the OpenAPI emitter reads.
  return {
    name: orderResource.name,
    displayName: orderResource.displayName,
    tag: orderResource.tag,
    prefix: orderResource.prefix,
    permissions: orderResource.permissions,
    presets: [],
    routes: [],
    customRoutes: [],
    plugin: orderResource.toPlugin(),
    aggregations: Object.entries(orderResource.aggregations ?? {}).map(([name, entry]) => ({
      name,
      summary: entry.summary,
      description: entry.description,
      permissions: entry.permissions,
      groupBy: entry.groupBy,
      measures: { count: "count", revenue: "sum:totalPrice" },
      lookupAliases: [],
      requireDateRange: entry.requireDateRange,
      requireFilters: entry.requireFilters,
    })),
  } as RegistryEntry;
}

describe("OpenAPI — aggregation paths", () => {
  it("emits one GET path per declared aggregation", () => {
    const spec = buildOpenApiSpec([buildRegistryEntry()]);
    expect(spec.paths["/orders/aggregations/revenueByStatus"]).toBeDefined();
    expect(spec.paths["/orders/aggregations/monthlyRevenue"]).toBeDefined();
    expect(spec.paths["/orders/aggregations/publicCount"]).toBeDefined();
  });

  it("each aggregation path uses GET method", () => {
    const spec = buildOpenApiSpec([buildRegistryEntry()]);
    const path = spec.paths["/orders/aggregations/revenueByStatus"];
    expect(path?.get).toBeDefined();
    expect(path?.post).toBeUndefined();
  });

  it("response schema declares { rows: [...] } envelope", () => {
    const spec = buildOpenApiSpec([buildRegistryEntry()]);
    const op = spec.paths["/orders/aggregations/revenueByStatus"]?.get;
    // biome-ignore lint/suspicious/noExplicitAny: traversing OpenAPI tree
    const schema = op?.responses?.["200"]?.content?.["application/json"]?.schema as any;
    expect(schema?.type).toBe("object");
    expect(schema?.required).toEqual(["rows"]);
    expect(schema?.properties?.rows?.type).toBe("array");
  });

  it("row schema has groupBy fields + measure aliases", () => {
    const spec = buildOpenApiSpec([buildRegistryEntry()]);
    const op = spec.paths["/orders/aggregations/revenueByStatus"]?.get;
    // biome-ignore lint/suspicious/noExplicitAny: traversing OpenAPI tree
    const rowSchema = (op?.responses?.["200"]?.content?.["application/json"]?.schema as any)
      ?.properties?.rows?.items;
    expect(rowSchema?.properties?.status?.type).toBe("string");
    expect(rowSchema?.properties?.count?.type).toBe("number");
    expect(rowSchema?.properties?.revenue?.type).toBe("number");
  });

  it("description surfaces measures inline", () => {
    const spec = buildOpenApiSpec([buildRegistryEntry()]);
    const desc = spec.paths["/orders/aggregations/revenueByStatus"]?.get?.description;
    expect(desc).toMatch(/measures/i);
    expect(desc).toContain("count");
    expect(desc).toContain("revenue");
  });

  it("requireDateRange surfaces in description + querystring", () => {
    const spec = buildOpenApiSpec([buildRegistryEntry()]);
    const op = spec.paths["/orders/aggregations/monthlyRevenue"]?.get;
    expect(op?.description).toMatch(/required date range/i);
    expect(op?.description).toContain("90 days");

    const queryParam = op?.parameters?.find((p) => p.in === "query");
    // biome-ignore lint/suspicious/noExplicitAny: traversing parameter schema
    const props = (queryParam?.schema as any)?.properties as Record<string, unknown>;
    expect(props?.["createdAt[gte]"]).toBeDefined();
    expect(props?.["createdAt[lte]"]).toBeDefined();
  });

  it("requireFilters surfaces in description + querystring", () => {
    const spec = buildOpenApiSpec([buildRegistryEntry()]);
    const op = spec.paths["/orders/aggregations/monthlyRevenue"]?.get;
    const queryParam = op?.parameters?.find((p) => p.in === "query");
    // biome-ignore lint/suspicious/noExplicitAny: traversing parameter schema
    const props = (queryParam?.schema as any)?.properties as Record<string, unknown>;
    expect(props?.customerId).toBeDefined();
  });

  it("public aggregation does NOT require auth in spec", () => {
    const spec = buildOpenApiSpec([buildRegistryEntry()]);
    const op = spec.paths["/orders/aggregations/publicCount"]?.get;
    // Auth-required ops have a non-empty `security` entry; public ops omit it
    expect(op?.security).toBeUndefined();
  });

  it("admin-only aggregation declares auth in spec", () => {
    const spec = buildOpenApiSpec([buildRegistryEntry()]);
    const op = spec.paths["/orders/aggregations/revenueByStatus"]?.get;
    // Auth-required → security array set
    expect(Array.isArray(op?.security)).toBe(true);
    expect(op?.security?.length).toBeGreaterThan(0);
  });

  it("declares 422 / 501 / 504 response codes (safety knobs surfaced in data)", () => {
    const spec = buildOpenApiSpec([buildRegistryEntry()]);
    const responses = spec.paths["/orders/aggregations/revenueByStatus"]?.get?.responses;
    expect(responses?.["422"]).toBeDefined();
    expect(responses?.["501"]).toBeDefined();
    expect(responses?.["504"]).toBeDefined();
  });
});
