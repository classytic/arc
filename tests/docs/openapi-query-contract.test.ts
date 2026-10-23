/**
 * The list operation publishes what the query parser declares (`x-arc-query`),
 * so a client can check its filters and sorts against the spec.
 */
import Fastify from "fastify";
import qs from "qs";
import { describe, expect, it, vi } from "vitest";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { defineResource } from "../../src/core/defineResource.js";
import { openApiPlugin } from "../../src/docs/openapi.js";
import { allowPublic } from "../../src/permissions/index.js";

const parser = (declared: Record<string, readonly string[]>) => ({
  ...declared,
  parse: () => ({ filters: {}, limit: 20 }),
  getQuerySchema: () => ({
    type: "object" as const,
    properties: { page: { type: "integer" }, sort: { type: "string" } },
  }),
});

async function listOperation(queryParser: unknown) {
  const app = Fastify({
    logger: false,
    routerOptions: { querystringParser: (s: string) => qs.parse(s) },
  });
  const resource = defineResource({
    name: "widget",
    queryParser: queryParser as never,
    adapter: {
      type: "mock",
      repository: {
        getAll: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
        getById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    } as never,
    controller: {
      setQueryParser: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as never,
    permissions: { list: allowPublic(), get: allowPublic() },
  });
  await app.register(arcCorePlugin);
  await app.register(resource.toPlugin());
  await app.register(openApiPlugin, { title: "T", version: "1.0.0" });
  await app.ready();
  const spec = (await app.inject({ method: "GET", url: "/_docs/openapi.json" })).json();
  await app.close();
  return spec.paths["/widgets"].get as Record<string, unknown>;
}

describe("x-arc-query on the list operation", () => {
  it("publishes the parser's filter fields, operators and sort fields", async () => {
    const op = await listOperation(
      parser({
        allowedFilterFields: ["status"],
        allowedOperators: ["eq", "in"],
        allowedSortFields: ["createdAt"],
      }),
    );
    expect(op["x-arc-query"]).toEqual({
      filterFields: ["status"],
      operators: ["eq", "in"],
      sortFields: ["createdAt"],
    });
  });

  it("is absent when the parser declares nothing", async () => {
    expect((await listOperation(parser({})))["x-arc-query"]).toBeUndefined();
  });
});
