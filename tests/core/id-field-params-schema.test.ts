/**
 * idField override — params schema regression tests
 *
 * Bug: when `defineResource({ idField: 'jobId' })` is set with a non-ObjectId
 * field, adapters (or plugins like MongoKit) still generate a params schema
 * with the ObjectId pattern `^[0-9a-fA-F]{24}$`, so GET/PATCH/DELETE /:id
 * requests 400 on the params validation before reaching BaseController.
 *
 * Fix strategy:
 *   1. Arc passes `idField` to adapter.generateSchemas(options, context) so
 *      adapters can emit the right pattern from the start (new contract).
 *   2. Arc defensively strips any ObjectId pattern from params.id when idField
 *      is overridden — safety net for adapters/plugins that don't honor the
 *      new context parameter.
 */

import Fastify, { type FastifyInstance } from "fastify";
import qs from "qs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";

function makeMockAdapterWithObjectIdPattern() {
  // Simulates MongoKit's buildCrudSchemasFromModel output for a Mongoose model:
  // always emits params with ObjectId pattern regardless of idField.
  const generateSchemas = vi.fn((_options?: unknown, _context?: unknown) => ({
    createBody: { type: "object", properties: { name: { type: "string" } } },
    updateBody: { type: "object", properties: { name: { type: "string" } } },
    params: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
      },
      required: ["id"],
    },
    response: { type: "object", properties: {}, additionalProperties: true },
  }));

  return {
    type: "mock" as const,
    repository: {
      getAll: vi.fn().mockResolvedValue({ docs: [], total: 0, page: 1, limit: 20 }),
      getById: vi.fn(async (id: string) => ({ _id: id, name: "Test" })),
      getOne: vi.fn(async (filter: Record<string, unknown>) => ({
        _id: "abc",
        ...filter,
        name: "Test",
      })),
      create: vi.fn(async (data: unknown) => ({ _id: "new", ...(data as object) })),
      update: vi.fn(async (id: string, data: unknown) => ({ _id: id, ...(data as object) })),
      delete: vi.fn(async () => ({ success: true })),
    },
    generateSchemas,
  };
}

function makeAdapterRespectingContext() {
  // Simulates a well-behaved adapter that honors the idField context parameter.
  const generateSchemas = vi.fn(
    (_options?: unknown, context?: { idField?: string } | undefined) => {
      const idField = context?.idField ?? "_id";
      const isObjectId = idField === "_id";
      return {
        createBody: { type: "object", properties: {} },
        updateBody: { type: "object", properties: {} },
        params: {
          type: "object",
          properties: {
            id: isObjectId
              ? { type: "string", pattern: "^[0-9a-fA-F]{24}$" }
              : { type: "string", description: `${idField} (custom)` },
          },
          required: ["id"],
        },
        response: { type: "object", properties: {}, additionalProperties: true },
      };
    },
  );

  return {
    type: "mock" as const,
    repository: {
      getAll: vi.fn().mockResolvedValue({ docs: [], total: 0, page: 1, limit: 20 }),
      getById: vi.fn(async (id: string) => ({ _id: "abc", jobId: id, name: "Test" })),
      getOne: vi.fn(async (filter: Record<string, unknown>) => ({
        _id: "abc",
        ...filter,
        name: "Test",
      })),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    generateSchemas,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  return Fastify({
    logger: false,
    routerOptions: { querystringParser: (s: string) => qs.parse(s) },
    ajv: {
      customOptions: { coerceTypes: true, useDefaults: true, removeAdditional: false },
    },
  });
}

describe("idField override → params schema", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("strips ObjectId pattern when idField != '_id' (safety net)", () => {
    const adapter = makeMockAdapterWithObjectIdPattern();
    const resource = defineResource({
      name: "job",
      // biome-ignore lint: mock
      adapter: adapter as any,
      idField: "jobId",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const params = resource._registryMeta?.openApiSchemas?.params as {
      properties?: { id?: { pattern?: string; type?: string } };
    };
    expect(params?.properties?.id?.pattern).toBeUndefined();
    expect(params?.properties?.id?.type).toBe("string");
  });

  it("keeps ObjectId pattern when idField is default (_id)", () => {
    const adapter = makeMockAdapterWithObjectIdPattern();
    const resource = defineResource({
      name: "product",
      // biome-ignore lint: mock
      adapter: adapter as any,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const params = resource._registryMeta?.openApiSchemas?.params as {
      properties?: { id?: { pattern?: string } };
    };
    expect(params?.properties?.id?.pattern).toBe("^[0-9a-fA-F]{24}$");
  });

  it("passes idField context to adapter.generateSchemas (new contract)", () => {
    const adapter = makeAdapterRespectingContext();
    defineResource({
      name: "job",
      // biome-ignore lint: mock
      adapter: adapter as any,
      idField: "jobId",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // Adapter should have been called with { idField: 'jobId' } context
    expect(adapter.generateSchemas).toHaveBeenCalled();
    const call = adapter.generateSchemas.mock.calls[0];
    expect(call).toBeDefined();
    // Second positional arg is the context object
    expect(call?.[1]).toMatchObject({ idField: "jobId" });
  });

  it("GET /:id accepts custom ID format (end-to-end)", async () => {
    const adapter = makeMockAdapterWithObjectIdPattern();
    const resource = defineResource({
      name: "order",
      // biome-ignore lint: mock
      adapter: adapter as any,
      idField: "orderId",
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

    // Non-ObjectId custom string — should NOT be rejected by params validation
    const res = await app.inject({
      method: "GET",
      url: "/orders/ORD-2026-0001",
    });
    // Before fix: 400 "must match pattern ^[0-9a-fA-F]{24}$"
    // After fix: 200 (controller handles the lookup by idField)
    expect(res.statusCode).toBe(200);
  });

  it("GET /:id with UUID-style ID accepts custom format", async () => {
    const adapter = makeMockAdapterWithObjectIdPattern();
    const resource = defineResource({
      name: "session",
      // biome-ignore lint: mock
      adapter: adapter as any,
      idField: "sessionToken",
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

    const res = await app.inject({
      method: "GET",
      url: "/sessions/550e8400-e29b-41d4-a716-446655440000",
    });
    expect(res.statusCode).toBe(200);
  });

  it("user-provided openApiSchemas.params overrides everything (highest priority)", () => {
    const adapter = makeMockAdapterWithObjectIdPattern();
    const resource = defineResource({
      name: "widget",
      // biome-ignore lint: mock
      adapter: adapter as any,
      idField: "widgetId",
      openApiSchemas: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^wdg-[a-z0-9]+$" },
          },
          required: ["id"],
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

    const params = resource._registryMeta?.openApiSchemas?.params as {
      properties?: { id?: { pattern?: string } };
    };
    // User override wins — custom pattern survives
    expect(params?.properties?.id?.pattern).toBe("^wdg-[a-z0-9]+$");
  });
});
