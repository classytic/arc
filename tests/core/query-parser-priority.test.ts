/**
 * QueryParser schema priority test
 *
 * Verifies that queryParser.getQuerySchema() takes precedence over the
 * adapter's generateSchemas().listQuery output. The parser is the source
 * of truth for list query shape (limit max, sort, filters, operators).
 *
 * Bug history: prior to this fix, when an adapter (like Mongoose) emitted
 * a listQuery schema, the parser's richer schema was discarded — losing
 * constraints like `limit.maximum` and operator-suffixed filter fields.
 */

import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";

describe("QueryParser schema priority", () => {
  it("queryParser schema wins over adapter generateSchemas", () => {
    // Mock adapter that emits a generic listQuery (like Mongoose adapter does)
    const mockAdapter = {
      type: "mock" as const,
      generateSchemas: () => ({
        listQuery: {
          type: "object",
          properties: {
            limit: { type: "string" }, // ← wrong: no maximum, wrong type
            page: { type: "string" },
          },
        },
      }),
    };

    // Mock parser with richer schema (the source of truth)
    const mockParser = {
      getQuerySchema: () => ({
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          page: { type: "integer", minimum: 1, default: 1 },
          name: { type: "string" }, // filter field
          name_contains: { type: "string" }, // operator suffix
        },
      }),
      maxLimit: 100,
    };

    const resource = defineResource({
      name: "product",
      disableDefaultRoutes: true, // skip adapter requirement for unit test
      // biome-ignore lint: mock adapter for unit test
      adapter: mockAdapter as any,
      // biome-ignore lint: mock parser for unit test
      queryParser: mockParser as any,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // The registry metadata holds the schemas used for OpenAPI/Fastify
    const meta = resource._registryMeta;
    expect(meta).toBeDefined();

    const listQuery = meta?.openApiSchemas?.listQuery as
      | { properties?: Record<string, { type?: string; maximum?: number }> }
      | undefined;

    expect(listQuery).toBeDefined();
    expect(listQuery?.properties).toBeDefined();

    // Parser's richer schema should win — limit must be integer with maximum
    expect(listQuery?.properties?.limit?.type).toBe("integer");
    expect(listQuery?.properties?.limit?.maximum).toBe(100);

    // Operator-suffixed filter field from parser is present
    expect(listQuery?.properties?.name_contains).toBeDefined();
  });

  it("user-provided openApiSchemas.listQuery still wins over parser", () => {
    const mockParser = {
      getQuerySchema: () => ({
        type: "object",
        properties: {
          limit: { type: "integer", maximum: 100 },
        },
      }),
    };

    const customListQuery = {
      type: "object",
      properties: {
        limit: { type: "integer", maximum: 500, default: 50 },
        customParam: { type: "string" },
      },
    };

    const resource = defineResource({
      name: "product",
      disableDefaultRoutes: true,
      // biome-ignore lint: mock parser for unit test
      queryParser: mockParser as any,
      openApiSchemas: { listQuery: customListQuery },
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const meta = resource._registryMeta;
    const listQuery = meta?.openApiSchemas?.listQuery as
      | { properties?: Record<string, { type?: string; maximum?: number }> }
      | undefined;

    // User's custom schema wins — maximum is 500, not 100
    expect(listQuery?.properties?.limit?.maximum).toBe(500);
    expect(listQuery?.properties?.customParam).toBeDefined();
  });
});
