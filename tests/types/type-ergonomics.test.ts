/**
 * Type Ergonomics Tests
 *
 * Validates the type-level fixes that eliminate consumer `as any` casts
 * when using Arc with MongoKit, typed Fastify handlers, and event definitions.
 *
 * These are compile-time + runtime structural tests — zero behavior changes.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import { describe, expect, it } from "vitest";
import type {
  EventDefinition,
  KeysetPaginatedResult,
  OffsetPaginatedResult,
  OpenApiSchemas,
  PaginationResult,
  RouteDefinition,
  RouteSchemaOptions,
} from "../../src/types/index.js";

// ============================================================================
// 1. RouteDefinition.handler — accepts typed Fastify request generics
// ============================================================================

describe("RouteDefinition.handler type ergonomics", () => {
  it("should accept a plain FastifyRequest handler (no generics)", () => {
    const route: RouteDefinition = {
      method: "GET",
      path: "/test",
      handler: (_req: FastifyRequest, _reply: FastifyReply) => ({ ok: true }),
      permissions: (() => true) as unknown as RouteDefinition["permissions"],
      raw: true,
    };

    expect(route.handler).toBeTypeOf("function");
  });

  it("should accept a typed FastifyRequest<{ Body }> handler without casting", () => {
    // This is the key fix: previously required `as any` because
    // FastifyRequest<{ Body: T }> is not assignable to FastifyRequest (invariant generic)
    type CreateBody = { name: string; email: string };

    const handler = (_req: FastifyRequest<{ Body: CreateBody }>, _reply: FastifyReply) => ({
      created: true,
    });

    const route: RouteDefinition = {
      method: "POST",
      path: "/create",
      handler,
      permissions: (() => true) as unknown as RouteDefinition["permissions"],
      raw: true,
    };

    expect(route.handler).toBe(handler);
  });

  it("should accept a typed FastifyRequest<{ Params }> handler without casting", () => {
    type RouteParams = { id: string };

    const handler = (_req: FastifyRequest<{ Params: RouteParams }>, _reply: FastifyReply) => ({
      found: true,
    });

    const route: RouteDefinition = {
      method: "GET",
      path: "/:id/details",
      handler,
      permissions: (() => true) as unknown as RouteDefinition["permissions"],
      raw: true,
    };

    expect(route.handler).toBe(handler);
  });

  it("should accept a typed FastifyRequest<{ Querystring }> handler without casting", () => {
    type QueryParams = { page: number; limit: number };

    const handler = (_req: FastifyRequest<{ Querystring: QueryParams }>, _reply: FastifyReply) => ({
      results: [],
    });

    const route: RouteDefinition = {
      method: "GET",
      path: "/search",
      handler,
      permissions: (() => true) as unknown as RouteDefinition["permissions"],
      raw: true,
    };

    expect(route.handler).toBe(handler);
  });

  it("should accept a fully typed FastifyRequest<{ Body, Params, Querystring }> handler", () => {
    type FullRequest = {
      Body: { data: string };
      Params: { id: string };
      Querystring: { dryRun: boolean };
    };

    const handler = (_req: FastifyRequest<FullRequest>, _reply: FastifyReply) => ({
      processed: true,
    });

    const route: RouteDefinition = {
      method: "PUT",
      path: "/:id/process",
      handler,
      permissions: (() => true) as unknown as RouteDefinition["permissions"],
      raw: true,
    };

    expect(route.handler).toBe(handler);
  });

  it("should still accept string handler names", () => {
    const route: RouteDefinition = {
      method: "GET",
      path: "/test",
      handler: "myControllerMethod",
      permissions: (() => true) as unknown as RouteDefinition["permissions"],
      raw: false,
    };

    expect(route.handler).toBe("myControllerMethod");
  });

  it("should still accept RouteHandlerMethod", () => {
    const fastifyHandler: RouteHandlerMethod = async (_req, _reply) => {
      return { ok: true };
    };

    const route: RouteDefinition = {
      method: "GET",
      path: "/native",
      handler: fastifyHandler,
      permissions: (() => true) as unknown as RouteDefinition["permissions"],
      raw: true,
    };

    expect(route.handler).toBe(fastifyHandler);
  });
});

// ============================================================================
// 2. EventDefinition.handler — optional (events published via fastify.events.publish)
// ============================================================================

describe("EventDefinition.handler optionality", () => {
  it("should accept events without a handler", () => {
    const event: EventDefinition = {
      name: "order.shipped",
      schema: { type: "object", properties: { orderId: { type: "string" } } },
      description: "Fired when an order ships",
    };

    expect(event.name).toBe("order.shipped");
    expect(event.handler).toBeUndefined();
    expect(event.schema).toBeDefined();
    expect(event.description).toBe("Fired when an order ships");
  });

  it("should still accept events with a handler", () => {
    const handler = async (_data: unknown) => {
      // handler logic
    };

    const event: EventDefinition = {
      name: "order.created",
      handler,
      schema: { type: "object" },
    };

    expect(event.handler).toBe(handler);
  });

  it("should accept events with only a name (minimal definition)", () => {
    const event: EventDefinition = {
      name: "user.logged_in",
    };

    expect(event.name).toBe("user.logged_in");
    expect(event.handler).toBeUndefined();
    expect(event.schema).toBeUndefined();
    expect(event.description).toBeUndefined();
  });

  it("should allow Record<string, EventDefinition> without handler on every entry", () => {
    // This is how consumers use events in defineResource() — a map of event names
    const events: Record<string, EventDefinition> = {
      created: { name: "product.created", description: "Product was created" },
      updated: { name: "product.updated", description: "Product was updated" },
      deleted: { name: "product.deleted", description: "Product was deleted" },
      outOfStock: {
        name: "product.outOfStock",
        schema: { type: "object", properties: { productId: { type: "string" } } },
      },
    };

    expect(Object.keys(events)).toHaveLength(4);
    // None have handlers — all are metadata-only
    for (const def of Object.values(events)) {
      expect(def.handler).toBeUndefined();
    }
  });
});

// ============================================================================
// 3. RouteSchemaOptions.fieldRules — MongoKit field rule types
// ============================================================================

describe("RouteSchemaOptions.fieldRules MongoKit alignment", () => {
  it("should accept systemManaged field rule (existing)", () => {
    const options: RouteSchemaOptions = {
      fieldRules: {
        createdAt: { systemManaged: true },
        updatedAt: { systemManaged: true },
      },
    };

    expect(options.fieldRules?.createdAt?.systemManaged).toBe(true);
  });

  it("should accept immutable field rule", () => {
    const options: RouteSchemaOptions = {
      fieldRules: {
        createdBy: { immutable: true },
      },
    };

    expect(options.fieldRules?.createdBy?.immutable).toBe(true);
  });

  it("should accept immutableAfterCreate field rule", () => {
    const options: RouteSchemaOptions = {
      fieldRules: {
        organizationId: { immutableAfterCreate: true },
      },
    };

    expect(options.fieldRules?.organizationId?.immutableAfterCreate).toBe(true);
  });

  it("should accept optional field rule", () => {
    const options: RouteSchemaOptions = {
      fieldRules: {
        description: { optional: true },
        nickname: { optional: true },
      },
    };

    expect(options.fieldRules?.description?.optional).toBe(true);
    expect(options.fieldRules?.nickname?.optional).toBe(true);
  });

  it("should accept combined field rules (real-world MongoKit usage)", () => {
    const options: RouteSchemaOptions = {
      fieldRules: {
        _id: { systemManaged: true },
        createdAt: { systemManaged: true },
        updatedAt: { systemManaged: true },
        createdBy: { immutable: true, systemManaged: true },
        organizationId: { immutableAfterCreate: true },
        description: { optional: true },
        slug: { immutable: true },
      },
    };

    expect(options.fieldRules?._id?.systemManaged).toBe(true);
    expect(options.fieldRules?.createdBy?.immutable).toBe(true);
    expect(options.fieldRules?.createdBy?.systemManaged).toBe(true);
    expect(options.fieldRules?.organizationId?.immutableAfterCreate).toBe(true);
    expect(options.fieldRules?.description?.optional).toBe(true);
    expect(options.fieldRules?.slug?.immutable).toBe(true);
  });

  it("should still accept arbitrary extra field rule properties via index signature", () => {
    const options: RouteSchemaOptions = {
      fieldRules: {
        tags: { customTransform: "lowercase", optional: true },
      },
    };

    expect((options.fieldRules?.tags as Record<string, unknown>)?.customTransform).toBe(
      "lowercase",
    );
    expect(options.fieldRules?.tags?.optional).toBe(true);
  });

  it("should work alongside other RouteSchemaOptions properties", () => {
    const options: RouteSchemaOptions = {
      hiddenFields: ["password", "internalNotes"],
      readonlyFields: ["createdAt", "updatedAt"],
      requiredFields: ["name", "email"],
      optionalFields: ["bio"],
      excludeFields: ["__v"],
      fieldRules: {
        createdAt: { systemManaged: true },
        password: { systemManaged: true },
        email: { immutableAfterCreate: true },
      },
      query: { page: { type: "integer" }, limit: { type: "integer" } },
    };

    expect(options.hiddenFields).toContain("password");
    expect(options.fieldRules?.email?.immutableAfterCreate).toBe(true);
    expect(options.query).toBeDefined();
  });
});

// ============================================================================
// 4. MongooseAdapterOptions.schemaGenerator — widened return type
// ============================================================================

describe("schemaGenerator widened return type", () => {
  it("should accept a generator returning OpenApiSchemas", () => {
    const schemas: OpenApiSchemas = {
      entity: { type: "object" },
      createBody: { type: "object", properties: { name: { type: "string" } } },
      updateBody: { type: "object", properties: { name: { type: "string" } } },
      params: { type: "object", properties: { id: { type: "string" } } },
      listQuery: { type: "object" },
    };

    const generator = (_model: unknown, _options?: RouteSchemaOptions) => schemas;
    const result = generator({});

    expect(result).toBe(schemas);
    expect(result.createBody).toBeDefined();
  });

  it("should accept a generator returning Record<string, unknown> (MongoKit CrudSchemas)", () => {
    // Simulates MongoKit's buildCrudSchemasFromModel return type (CrudSchemas)
    // which is structurally compatible but nominally different from OpenApiSchemas
    const crudSchemas: Record<string, unknown> = {
      createBody: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      updateBody: { type: "object", properties: { name: { type: "string" } } },
      params: { type: "object", properties: { id: { type: "string", pattern: "^[a-f0-9]{24}$" } } },
      listQuery: { type: "object", properties: { page: { type: "integer" } } },
    };

    const generator = (_model: unknown, _options?: RouteSchemaOptions): Record<string, unknown> =>
      crudSchemas;
    const result = generator({});

    expect(result).toBe(crudSchemas);
    expect(result.createBody).toBeDefined();
    expect(result.updateBody).toBeDefined();
  });

  it("DataAdapter.generateSchemas return type includes Record<string, unknown>", () => {
    // Verify the interface signature allows the widened type
    const mockAdapter: Pick<DataAdapter, "generateSchemas"> = {
      generateSchemas: (_options?: RouteSchemaOptions) => {
        return { createBody: { type: "object" } } as Record<string, unknown>;
      },
    };

    const result = mockAdapter.generateSchemas?.();
    expect(result).toHaveProperty("createBody");
  });
});

// ============================================================================
// 4. Pagination result types accept kit-specific extras via TExtra generic
// ============================================================================

describe("Pagination result types — TExtra generic", () => {
  interface Product {
    _id: string;
    name: string;
  }

  it("default TExtra = {} keeps the standard offset shape", () => {
    const page: OffsetPaginatedResult<Product> = {
      method: "offset",
      data: [{ _id: "a", name: "alpha" }],
      page: 1,
      limit: 20,
      total: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };
    expect(page.data).toHaveLength(1);
  });

  it("TExtra fields appear flat alongside the standard ones", () => {
    // A kit that returns query timing + region alongside the pagination shape:
    type KitExtras = { tookMs: number; region: string };
    const page: OffsetPaginatedResult<Product, KitExtras> = {
      method: "offset",
      data: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
      // ↓ Must typecheck as top-level fields, not inside a `meta` object.
      tookMs: 12,
      region: "us-east-1",
    };
    expect(page.tookMs).toBe(12);
    expect(page.region).toBe("us-east-1");
  });

  it("KeysetPaginatedResult also accepts TExtra", () => {
    type KeysetExtras = { cursorVersion: number };
    const page: KeysetPaginatedResult<Product, KeysetExtras> = {
      method: "keyset",
      data: [],
      limit: 20,
      hasMore: false,
      next: null,
      cursorVersion: 1,
    };
    expect(page.cursorVersion).toBe(1);
  });

  it("PaginationResult discriminated union threads TExtra through both branches", () => {
    type Extras = { tookMs: number };
    const offset: PaginationResult<Product, Extras> = {
      method: "offset",
      data: [],
      page: 1,
      limit: 20,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
      tookMs: 7,
    };
    const keyset: PaginationResult<Product, Extras> = {
      method: "keyset",
      data: [],
      limit: 20,
      hasMore: false,
      next: null,
      tookMs: 4,
    };

    // Narrow on the discriminator; the TExtra field is visible in both
    // branches thanks to the distributed intersection.
    const narrow = (r: PaginationResult<Product, Extras>) =>
      r.method === "keyset" ? r.next : r.page;
    expect(narrow(offset)).toBe(1);
    expect(narrow(keyset)).toBeNull();
  });

  it("warning field (offset-only) is typed as optional string", () => {
    const page: OffsetPaginatedResult<Product> = {
      method: "offset",
      data: [],
      page: 101,
      limit: 50,
      total: 50000,
      pages: 1000,
      hasNext: true,
      hasPrev: true,
      warning: "Deep offset — consider keyset pagination for page > 100",
    };
    expect(typeof page.warning).toBe("string");
  });
});
