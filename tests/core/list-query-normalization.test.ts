/**
 * List query schema normalization — regression tests
 *
 * Verifies that the listQuery normalization in defineResource.toPlugin() does
 * NOT emit AJV strict-mode warnings regardless of which QueryParser the user
 * brings: MongoKit, SQL-style custom, or composition-based.
 *
 * Bug history: prior fix had two issues
 *   1. `populate` wasn't in the keep-as-is set → its inner oneOf branch leaked
 *      `additionalProperties: true` into a context AJV strict mode rejects.
 *   2. Normalization stripped `type` but kept `minimum`/`maximum` when merging
 *      partial user schemas → AJV warned "has minimum/maximum without type".
 *
 * The fix keeps pagination/composition keywords untouched and replaces filter
 * fields with `{}` (accept anything) so the QueryParser owns runtime validation.
 */

import Fastify, { type FastifyInstance } from "fastify";
import qs from "qs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";

// ----------------------------------------------------------------------------
// Fake query parsers — each represents a different user scenario
// ----------------------------------------------------------------------------

/**
 * Mimics @classytic/mongokit's QueryParser.getQuerySchema() output.
 * Includes `populate` with oneOf composition and bracket-notation filter fields.
 */
const mongokitLikeParser = {
  maxLimit: 500,
  getQuerySchema: () => ({
    type: "object",
    properties: {
      page: { type: "integer", minimum: 1, default: 1 },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 20 },
      sort: { type: "string" },
      search: { type: "string", maxLength: 200 },
      select: { type: "string" },
      after: { type: "string" },
      populate: {
        oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
        description: "Fields to populate",
      },
      // Direct equality filters
      status: { type: "string", description: "Filter by status" },
      category: { type: "string", description: "Filter by category" },
      // Operator-suffixed filters (with type — MongoKit emits these)
      "status[ne]": { type: "string" },
      "status[in]": { type: "string" },
      "price[gte]": { type: "number" },
      "price[lte]": { type: "number" },
      "name[like]": { type: "string" },
      "createdAt[exists]": { type: "boolean" },
    },
  }),
};

/**
 * Mimics a SQL-style parser (e.g., a custom Drizzle/Prisma parser) that uses
 * snake_case operator suffixes instead of brackets and no composition.
 */
const sqlStyleParser = {
  getQuerySchema: () => ({
    type: "object",
    properties: {
      page: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      sort: { type: "string" },
      // SQL-style filter fields
      id: { type: "integer" },
      email: { type: "string", format: "email" },
      email_contains: { type: "string" },
      created_after: { type: "string", format: "date-time" },
      age_gt: { type: "integer" },
      is_active: { type: "boolean" },
    },
  }),
};

/**
 * Custom parser using allOf composition on a filter field.
 * This is exotic but a real user might do this to compose constraints.
 */
const compositionParser = {
  getQuerySchema: () => ({
    type: "object",
    properties: {
      page: { type: "integer" },
      limit: { type: "integer" },
      // Composition on a filter field — author knows what they're doing
      tags: {
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      },
      metadata: {
        allOf: [{ type: "object" }, { additionalProperties: true }],
      },
    },
  }),
};

/**
 * Minimal repo mock — satisfies RepositoryLike without pulling in real DB.
 */
function makeMockAdapter() {
  return {
    type: "mock" as const,
    repository: {
      find: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      getAll: vi.fn().mockResolvedValue({ docs: [], total: 0, page: 1, limit: 20, hasNext: false }),
      getById: vi.fn().mockResolvedValue(null),
    },
    generateSchemas: () => ({
      // Adapter emits a generic listQuery — parser should override it
      listQuery: {
        type: "object",
        properties: {
          limit: { type: "string" },
          page: { type: "string" },
        },
      },
    }),
  };
}

/**
 * A stub controller that always returns empty list. Bypasses BaseController so
 * our test focuses on schema normalization only, not controller wiring.
 */
function makeStubController() {
  return {
    list: vi.fn(async () => ({
      success: true,
      data: { docs: [], total: 0, page: 1, limit: 20, hasNext: false },
    })),
    get: vi.fn(async () => ({ success: true, data: null })),
    create: vi.fn(async () => ({ success: true, data: {} })),
    update: vi.fn(async () => ({ success: true, data: {} })),
    delete: vi.fn(async () => ({ success: true })),
  };
}

/**
 * Build a Fastify instance in AJV STRICT mode. Strict mode is what surfaces
 * the `additionalProperties without type`, `minimum without type`, etc warnings
 * the user reported.
 */
async function buildStrictApp(): Promise<{
  app: FastifyInstance;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const app = Fastify({
    logger: false,
    routerOptions: {
      querystringParser: (str: string) => qs.parse(str),
    },
    ajv: {
      customOptions: {
        coerceTypes: true,
        useDefaults: true,
        strict: "log", // downgrades errors to warnings so we can collect them
        // Intercept strict-mode warnings
        logger: {
          log: () => {},
          warn: (msg: string) => warnings.push(String(msg)),
          error: (msg: string) => warnings.push(String(msg)),
        },
      },
    },
  });
  return { app, warnings };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("list query schema normalization", () => {
  let app: FastifyInstance;
  let warnings: string[];

  beforeEach(async () => {
    ({ app, warnings } = await buildStrictApp());
  });

  afterEach(async () => {
    await app.close();
  });

  it("MongoKit-like parser: no AJV warnings, populate oneOf preserved", async () => {
    const resource = defineResource({
      name: "product",
      // biome-ignore lint: mock for test
      adapter: makeMockAdapter() as any,
      // biome-ignore lint: stub for test
      controller: makeStubController() as any,
      // biome-ignore lint: mock for test
      queryParser: mongokitLikeParser as any,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // Registration is where normalization runs — warnings fire here
    await app.register(resource.toPlugin());
    await app.ready();

    // Filter out unrelated warnings (if any)
    const schemaWarnings = warnings.filter(
      (w) =>
        w.includes("strict mode") ||
        w.includes("additionalProperties") ||
        w.includes("minimum") ||
        w.includes("maximum") ||
        w.includes("oneOf"),
    );
    expect(schemaWarnings).toEqual([]);

    // Actual requests should work — bracket notation filters must pass through
    const resp = await app.inject({
      method: "GET",
      url: "/products?page=1&limit=10&status=active&price[gte]=100&populate=author",
    });
    expect(resp.statusCode).toBe(200);
  });

  it("SQL-style parser: no warnings, snake_case filter fields accepted", async () => {
    const resource = defineResource({
      name: "user",
      // biome-ignore lint: mock for test
      adapter: makeMockAdapter() as any,
      // biome-ignore lint: stub for test
      controller: makeStubController() as any,
      // biome-ignore lint: mock for test
      queryParser: sqlStyleParser as any,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await app.register(resource.toPlugin());
    await app.ready();

    const schemaWarnings = warnings.filter(
      (w) =>
        w.includes("strict mode") ||
        w.includes("additionalProperties") ||
        w.includes("minimum") ||
        w.includes("maximum"),
    );
    expect(schemaWarnings).toEqual([]);

    const resp = await app.inject({
      method: "GET",
      url: "/users?page=1&email=test@example.com&age_gt=18&is_active=true",
    });
    expect(resp.statusCode).toBe(200);
  });

  it("composition parser (anyOf/allOf in filter fields): relaxed to accept-any, no warnings", async () => {
    const resource = defineResource({
      name: "note",
      // biome-ignore lint: mock for test
      adapter: makeMockAdapter() as any,
      // biome-ignore lint: stub for test
      controller: makeStubController() as any,
      // biome-ignore lint: mock for test
      queryParser: compositionParser as any,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await app.register(resource.toPlugin());
    await app.ready();

    // No AJV strict-mode warnings even when the parser emits exotic composition
    // schemas on filter fields — QueryParser owns runtime validation.
    const schemaWarnings = warnings.filter(
      (w) =>
        w.includes("strict mode") ||
        w.includes("additionalProperties") ||
        w.includes("anyOf") ||
        w.includes("allOf"),
    );
    expect(schemaWarnings).toEqual([]);

    // The untouched OpenAPI metadata still carries the original composition
    // shape for documentation purposes — only the Fastify validation schema
    // is relaxed. Verify OpenAPI schema preserved the author's intent.
    const listQuery = resource._registryMeta?.openApiSchemas?.listQuery as {
      properties?: Record<string, unknown>;
    };
    const tagsSchema = listQuery?.properties?.tags as { anyOf?: unknown[] };
    const metadataSchema = listQuery?.properties?.metadata as { allOf?: unknown[] };
    expect(tagsSchema?.anyOf).toBeDefined();
    expect(metadataSchema?.allOf).toBeDefined();

    // And a real request with composition-style values should be accepted
    const resp = await app.inject({
      method: "GET",
      url: "/notes?tags=foo&metadata[key]=value",
    });
    expect(resp.statusCode).toBe(200);
  });

  it("merging with user-provided partial list.querystring does not corrupt types", async () => {
    // This reproduces the contradictory warning scenario: a preset or user
    // supplies a partial list.querystring and the merge used to leave orphan
    // minimum/maximum without type.
    const resource = defineResource({
      name: "order",
      // biome-ignore lint: mock for test
      adapter: makeMockAdapter() as any,
      // biome-ignore lint: stub for test
      controller: makeStubController() as any,
      // biome-ignore lint: mock for test
      queryParser: mongokitLikeParser as any,
      openApiSchemas: {
        list: {
          querystring: {
            type: "object",
            properties: {
              // Partial: only minimum/maximum, no type — this was the trap.
              limit: { minimum: 1, maximum: 200 },
              customFlag: { type: "boolean" },
            },
          },
        },
      },
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await app.register(resource.toPlugin());
    await app.ready();

    const schemaWarnings = warnings.filter(
      (w) => w.includes("minimum") || w.includes("maximum") || w.includes("strict mode"),
    );
    expect(schemaWarnings).toEqual([]);
  });

  it("pagination params (page/limit/sort/search/select/after) keep their types", () => {
    const resource = defineResource({
      name: "item",
      // biome-ignore lint: mock for test
      adapter: makeMockAdapter() as any,
      // biome-ignore lint: stub for test
      controller: makeStubController() as any,
      // biome-ignore lint: mock for test
      queryParser: mongokitLikeParser as any,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const listQuery = resource._registryMeta?.openApiSchemas?.listQuery as {
      properties?: Record<string, { type?: string; maximum?: number }>;
    };
    // Paging params preserved exactly as parser emitted them
    expect(listQuery?.properties?.page?.type).toBe("integer");
    expect(listQuery?.properties?.limit?.type).toBe("integer");
    expect(listQuery?.properties?.limit?.maximum).toBe(500);
    expect(listQuery?.properties?.sort?.type).toBe("string");
  });
});
