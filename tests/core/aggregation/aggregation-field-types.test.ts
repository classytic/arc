/**
 * Aggregation URL filters are coerced by the DECLARED field type, not guessed from the value.
 *
 * Regression: `GET /aggregations/:name?civilDate[gte]=2026-11-01` turned the operand into a Date
 * because it looked like one, so a String field holding `YYYY-MM-DD` civil dates matched nothing
 * (and `amount[gte]=10` compared a number field against the string "10"). The resource's
 * generated entity schema now drives coercion; an aggregation's own `fieldTypes` win over it;
 * undeclared fields keep the legacy guess.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coerceByType,
  fieldTypesFromOpenApiSchemas,
} from "../../../src/core/aggregation/fieldTypes.js";
import { defineAggregation } from "../../../src/core/aggregation/index.js";
import { BaseController } from "../../../src/core/BaseController.js";
import { defineResource } from "../../../src/core/defineResource.js";
import { createApp } from "../../../src/factory/createApp.js";
import { buildAggregationTools } from "../../../src/integrations/mcp/aggregation-tools.js";
import { allowPublic } from "../../../src/permissions/index.js";
import { createMockRepository, setupTestDatabase, teardownTestDatabase } from "../../setup.js";

type Leaf = { op: string; field?: string; value?: unknown; values?: unknown[] };

function leavesOf(filter: unknown): Leaf[] {
  const node = filter as Leaf & { children?: unknown[] };
  if (node.children) return node.children.flatMap(leavesOf);
  return [node];
}

describe("fieldTypesFromOpenApiSchemas", () => {
  it("maps unambiguous JSON Schema shapes; leaves `format: date` and objects without a type", () => {
    const types = fieldTypesFromOpenApiSchemas({
      createBody: {
        properties: {
          civilDate: { type: "string" },
          at: { type: "string", format: "date-time" },
          day: { type: "string", format: "date" },
          amount: { type: "integer" },
          ratio: { type: ["number", "null"] },
          active: { type: "boolean" },
          note: { anyOf: [{ type: "string" }, { type: "null" }] },
          tags: { type: "array", items: { type: "string" } },
          address: {
            type: "object",
            properties: {
              city: { type: "string" },
              since: { type: "string", format: "date-time" },
            },
          },
        },
      },
      // `entity` is read first: its declaration wins.
      entity: { properties: { amount: { type: "string" } } },
    });
    expect(types).toEqual({
      amount: "string",
      civilDate: "string",
      at: "date",
      ratio: "number",
      active: "boolean",
      note: "string",
      "address.city": "string",
      "address.since": "date",
    });
    expect(fieldTypesFromOpenApiSchemas(undefined)).toEqual({});
  });

  it("coerceByType keeps unparseable input unchanged", () => {
    expect(coerceByType("2026-11-01", "string")).toBe("2026-11-01");
    expect(coerceByType("2026-11-01", "date")).toBeInstanceOf(Date);
    expect(coerceByType("soon", "date")).toBe("soon");
    expect(coerceByType("10", "number")).toBe(10);
    expect(coerceByType("ten", "number")).toBe("ten");
    expect(coerceByType("", "number")).toBe("");
    expect(coerceByType("false", "boolean")).toBe(false);
    expect(coerceByType("no", "boolean")).toBe("no");
  });
});

describe("aggregation routes — declared field types drive URL coercion", () => {
  let app: FastifyInstance;
  let aggregateStub: any;

  beforeAll(async () => {
    await setupTestDatabase();
    const name = "AggFieldTypeShift";
    const Model =
      mongoose.models[name] ??
      mongoose.model(
        name,
        new mongoose.Schema({
          civilDate: String, // `YYYY-MM-DD` civil date: compared as a string
          at: Date,
          amount: Number,
          active: Boolean,
          status: String,
          label: String,
        }),
      );
    const repo = createMockRepository(Model) as Record<string, unknown>;
    aggregateStub = vi.fn().mockResolvedValue({ rows: [] });
    repo.aggregate = aggregateStub;

    const resource = defineResource({
      name: "shift",
      prefix: "/shifts",
      adapter: createMongooseAdapter(Model, repo as never),
      controller: new BaseController(repo as never, { resourceName: "shift", tenantField: false }),
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
        // The declaration's own types win over the schema's (`label` is a String in Mongo
        // but this aggregation reads it as a date, e.g. a legacy text column).
        overridden: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
          fieldTypes: { label: "date" },
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

  beforeEach(() => aggregateStub.mockClear());

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  async function filterFor(url: string): Promise<Leaf[]> {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode, res.body).toBe(200);
    return leavesOf(aggregateStub.mock.calls[0][0].filter);
  }
  const leaf = (leaves: Leaf[], op: string, field: string) =>
    leaves.find((l) => l.op === op && l.field === field);

  it("a String field keeps a date-shaped range operand a string (civil dates match)", async () => {
    const leaves = await filterFor(
      "/shifts/aggregations/byStatus?civilDate[gte]=2026-11-01&civilDate[lte]=2026-11-07",
    );
    expect(leaf(leaves, "gte", "civilDate")?.value).toBe("2026-11-01");
    expect(leaf(leaves, "lte", "civilDate")?.value).toBe("2026-11-07");
  });

  it("a Date field still gets a Date; Number and Boolean fields get typed operands", async () => {
    const leaves = await filterFor(
      "/shifts/aggregations/byStatus?at[gte]=2026-11-01T00:00:00.000Z&amount[gte]=10&amount[in]=1,2&active=true",
    );
    const at = leaf(leaves, "gte", "at")?.value;
    expect(at).toBeInstanceOf(Date);
    expect((at as Date).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(leaf(leaves, "gte", "amount")?.value).toBe(10);
    expect(leaf(leaves, "in", "amount")?.values).toEqual([1, 2]);
    expect(leaf(leaves, "eq", "active")?.value).toBe(true);
  });

  it("a field the schema does not declare keeps the legacy guess", async () => {
    const leaves = await filterFor("/shifts/aggregations/byStatus?unknownAt[gte]=2026-11-01");
    expect(leaf(leaves, "gte", "unknownAt")?.value).toBeInstanceOf(Date);
  });

  it("an aggregation's own fieldTypes win over the schema", async () => {
    const leaves = await filterFor("/shifts/aggregations/overridden?label[gte]=2026-11-01");
    expect(leaf(leaves, "gte", "label")?.value).toBeInstanceOf(Date);
    aggregateStub.mockClear();
    const plain = await filterFor("/shifts/aggregations/byStatus?label[gte]=2026-11-01");
    expect(leaf(plain, "gte", "label")?.value).toBe("2026-11-01");
  });
});

describe("MCP aggregation tools — the same declared types", () => {
  it("coerces a JSON filter operand by the field type the REST route uses", async () => {
    const repo = { aggregate: vi.fn().mockResolvedValue({ rows: [] }) };
    const [tool] = buildAggregationTools({
      resourceName: "shift",
      displayName: "Shift",
      aggregations: {
        byStatus: defineAggregation({
          groupBy: "status",
          measures: { count: "count" },
          permissions: allowPublic(),
        }),
      },
      schemaOptions: undefined,
      repo,
      buildOptionsFromSession: () => ({}),
      fieldTypes: { civilDate: "string", at: "date" },
    });
    await tool?.handler?.(
      { filter: { civilDate: { gte: "2026-11-01" }, at: { gte: "2026-11-01T00:00:00.000Z" } } },
      { session: null, log: () => Promise.resolve() } as any,
    );
    const leaves = leavesOf(repo.aggregate.mock.calls[0]?.[0].filter);
    expect(leaves.find((l) => l.op === "gte" && l.field === "civilDate")?.value).toBe("2026-11-01");
    expect(leaves.find((l) => l.op === "gte" && l.field === "at")?.value).toBeInstanceOf(Date);
  });
});
