/**
 * Custom (non-Mongoose) adapter with custom idField
 *
 * Builds a fully in-memory adapter — no Mongoose, no MongoKit, just a plain
 * Map<string, doc> behind the DataAdapter interface. Mimics what a SQLite,
 * Drizzle, Prisma, or fully custom adapter would look like.
 *
 * Verifies:
 *   1. Default idField (`_id`) — works via getById fallback
 *   2. Custom idField (`code`) — works via the new compound-filter path
 *   3. AdapterSchemaContext is honored — adapter sees `idField: 'code'`
 *   4. Safety net strips ObjectId pattern even on custom adapter output
 *   5. Real CRUD via Fastify routes against the custom adapter
 *   6. MCP tool generation against the custom adapter (REST + MCP both work)
 */

import type {
  AdapterSchemaContext,
  DataAdapter,
  RepositoryLike,
} from "@classytic/repo-core/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import qs from "qs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createTestMcpClient } from "../../src/integrations/mcp/testing.js";
import { allowPublic } from "../../src/permissions/index.js";

// ============================================================================
// In-memory SQLite-style repository
// ============================================================================

interface Widget {
  _id: string;
  code: string;
  name: string;
  price: number;
  stock: number;
}

class InMemoryWidgetRepo implements RepositoryLike {
  private store = new Map<string, Widget>();
  private idCounter = 0;

  reset(): void {
    this.store.clear();
    this.idCounter = 0;
  }

  seed(items: Omit<Widget, "_id">[]): void {
    for (const item of items) {
      const _id = `wgt-${++this.idCounter}`;
      this.store.set(_id, { _id, ...item });
    }
  }

  async getAll(_params?: unknown): Promise<unknown> {
    const docs = Array.from(this.store.values());
    return { docs, total: docs.length, page: 1, limit: 20, hasNext: false };
  }

  async getById(id: string, _options?: unknown): Promise<unknown> {
    return this.store.get(id) ?? null;
  }

  async getOne(filter: Record<string, unknown>, _options?: unknown): Promise<unknown> {
    for (const doc of this.store.values()) {
      let match = true;
      for (const [key, value] of Object.entries(filter)) {
        // biome-ignore lint: dynamic
        if ((doc as any)[key] !== value) {
          match = false;
          break;
        }
      }
      if (match) return doc;
    }
    return null;
  }

  async create(data: unknown, _options?: unknown): Promise<unknown> {
    const _id = `wgt-${++this.idCounter}`;
    const doc = { _id, ...(data as Omit<Widget, "_id">) };
    this.store.set(_id, doc);
    return doc;
  }

  async update(id: string, data: unknown, _options?: unknown): Promise<unknown> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...(data as Partial<Widget>) };
    this.store.set(id, updated);
    return updated;
  }

  async delete(id: string, _options?: unknown): Promise<unknown> {
    const existed = this.store.delete(id);
    return { success: existed };
  }
}

// ============================================================================
// Adapter — context-honoring (no ObjectId pattern when custom idField)
// ============================================================================

function createWidgetAdapter(repo: InMemoryWidgetRepo): DataAdapter<Widget> & {
  generateSchemasCalls: AdapterSchemaContext[];
} {
  const generateSchemasCalls: AdapterSchemaContext[] = [];

  const adapter: DataAdapter<Widget> & {
    generateSchemasCalls: AdapterSchemaContext[];
  } = {
    type: "custom",
    name: "InMemoryWidgetAdapter",
    repository: repo,
    generateSchemasCalls,
    generateSchemas(_schemaOptions, context) {
      generateSchemasCalls.push(context ?? {});
      const idField = context?.idField ?? "_id";
      const isObjectId = idField === "_id";
      return {
        createBody: {
          type: "object",
          properties: {
            code: { type: "string", description: "Unique widget code" },
            name: { type: "string", description: "Widget name" },
            price: { type: "number", minimum: 0 },
            stock: { type: "number", minimum: 0 },
          },
          required: ["code", "name", "price"],
          additionalProperties: false,
        },
        updateBody: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "number", minimum: 0 },
            stock: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
        params: {
          type: "object",
          properties: {
            id: isObjectId
              ? { type: "string", pattern: "^[0-9a-fA-F]{24}$" }
              : { type: "string", description: `${idField} (custom)` },
          },
          required: ["id"],
        },
        response: {
          type: "object",
          properties: {
            _id: { type: "string" },
            code: { type: "string" },
            name: { type: "string" },
            price: { type: "number" },
            stock: { type: "number" },
          },
          additionalProperties: true,
        },
      };
    },
  };
  return adapter;
}

// ============================================================================
// Adapter — legacy (always emits ObjectId pattern, ignores context)
// ============================================================================

function createLegacyWidgetAdapter(repo: InMemoryWidgetRepo): DataAdapter<Widget> {
  return {
    type: "custom",
    name: "LegacyInMemoryAdapter",
    repository: repo,
    generateSchemas(_schemaOptions) {
      return {
        createBody: {
          type: "object",
          properties: {
            code: { type: "string" },
            name: { type: "string" },
            price: { type: "number" },
          },
          required: ["code", "name", "price"],
          additionalProperties: false,
        },
        updateBody: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "number" },
          },
          additionalProperties: false,
        },
        params: {
          type: "object",
          properties: {
            // Legacy adapter — always emits ObjectId pattern, doesn't honor context
            id: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
          },
          required: ["id"],
        },
        response: { type: "object", properties: {}, additionalProperties: true },
      };
    },
  };
}

// ============================================================================
// Test helpers
// ============================================================================

async function buildApp(): Promise<FastifyInstance> {
  return Fastify({
    logger: false,
    routerOptions: { querystringParser: (s: string) => qs.parse(s) },
    ajv: { customOptions: { coerceTypes: true, useDefaults: true } },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Custom (non-Mongoose) adapter — context-aware", () => {
  let repo: InMemoryWidgetRepo;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryWidgetRepo();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    repo.reset();
  });

  it("honors AdapterSchemaContext — receives { idField: 'code' }", async () => {
    const adapter = createWidgetAdapter(repo);
    const resource = defineResource<Widget>({
      name: "widget",
      // biome-ignore lint: generic
      adapter: adapter as any,
      idField: "code",
      tenantField: false,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.ready();

    // Adapter must have been called with the idField context
    expect(adapter.generateSchemasCalls.length).toBeGreaterThan(0);
    expect(adapter.generateSchemasCalls.some((c) => c.idField === "code")).toBe(true);
    expect(adapter.generateSchemasCalls.some((c) => c.resourceName === "widget")).toBe(true);
  });

  it("REST: full CRUD with custom idField via in-memory adapter", async () => {
    const adapter = createWidgetAdapter(repo);
    const resource = defineResource<Widget>({
      name: "widget",
      // biome-ignore lint: generic
      adapter: adapter as any,
      idField: "code",
      tenantField: false,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });
    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.ready();

    // CREATE
    const createRes = await app.inject({
      method: "POST",
      url: "/widgets",
      payload: { code: "WGT-ALPHA", name: "Alpha", price: 99, stock: 5 },
    });
    expect([200, 201]).toContain(createRes.statusCode);

    // GET by custom code
    const getRes = await app.inject({ method: "GET", url: "/widgets/WGT-ALPHA" });
    expect(getRes.statusCode).toBe(200);
    const got = getRes.json();
    expect(got.code).toBe("WGT-ALPHA");
    expect(got.name).toBe("Alpha");

    // PATCH by custom code
    const patchRes = await app.inject({
      method: "PATCH",
      url: "/widgets/WGT-ALPHA",
      payload: { price: 149, stock: 3 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().price).toBe(149);

    // DELETE by custom code
    const delRes = await app.inject({ method: "DELETE", url: "/widgets/WGT-ALPHA" });
    expect(delRes.statusCode).toBe(200);

    // Confirm gone
    const gone = await app.inject({ method: "GET", url: "/widgets/WGT-ALPHA" });
    expect(gone.statusCode).toBe(404);
  });

  it("REST: GET by hyphenated/UUID-style custom IDs", async () => {
    const adapter = createWidgetAdapter(repo);
    const resource = defineResource<Widget>({
      name: "widget",
      // biome-ignore lint: generic
      adapter: adapter as any,
      idField: "code",
      tenantField: false,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });
    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.ready();

    repo.seed([
      { code: "post-2026-03-31-launch", name: "Launch", price: 10, stock: 1 },
      { code: "550e8400-e29b-41d4-a716-446655440000", name: "UUID", price: 20, stock: 2 },
    ]);

    const r1 = await app.inject({
      method: "GET",
      url: "/widgets/post-2026-03-31-launch",
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().code).toBe("post-2026-03-31-launch");

    const r2 = await app.inject({
      method: "GET",
      url: "/widgets/550e8400-e29b-41d4-a716-446655440000",
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().code).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("safety net: legacy adapter with ObjectId pattern still works", async () => {
    const adapter = createLegacyWidgetAdapter(repo);
    const resource = defineResource<Widget>({
      name: "widget",
      // biome-ignore lint: generic
      adapter: adapter as any,
      idField: "code",
      tenantField: false,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });
    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.ready();

    repo.seed([{ code: "WGT-LEGACY", name: "Legacy", price: 50, stock: 0 }]);

    // Even though the legacy adapter emits an ObjectId pattern, Arc strips it
    // so this non-ObjectId code is accepted by params validation.
    const res = await app.inject({ method: "GET", url: "/widgets/WGT-LEGACY" });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe("WGT-LEGACY");

    // The OpenAPI metadata's params.id should have no pattern after the safety net
    const params = resource._registryMeta?.openApiSchemas?.params as {
      properties?: { id?: { pattern?: string } };
    };
    expect(params?.properties?.id?.pattern).toBeUndefined();
  });

  it("default idField (_id) still uses getById path", async () => {
    const adapter = createWidgetAdapter(repo);
    const resource = defineResource<Widget>({
      name: "widget",
      // biome-ignore lint: generic
      adapter: adapter as any,
      // no idField — defaults to _id
      tenantField: false,
      // The in-memory repo generates `wgt-N` IDs, not real ObjectIds, so
      // override the params schema to skip the ObjectId pattern.
      openApiSchemas: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
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
    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.ready();

    repo.seed([{ code: "WGT-A", name: "A", price: 1, stock: 1 }]);
    // First doc is wgt-1 (_id)

    const res = await app.inject({ method: "GET", url: "/widgets/wgt-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()._id).toBe("wgt-1");
  });

  it("MCP tools work with custom adapter + custom idField", async () => {
    const adapter = createWidgetAdapter(repo);
    const resource = defineResource<Widget>({
      name: "widget",
      // biome-ignore lint: generic
      adapter: adapter as any,
      idField: "code",
      tenantField: false,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    repo.seed([
      { code: "MCP-001", name: "MCP Widget", price: 33, stock: 7 },
      { code: "MCP-002", name: "Other", price: 88, stock: 2 },
    ]);

    const client = await createTestMcpClient({
      pluginOptions: { resources: [resource] },
    });
    try {
      // List
      const listRes = await client.callTool("list_widgets", {});
      expect(listRes.isError).toBeFalsy();
      const listJson = JSON.parse(listRes.content[0]?.text ?? "{}");
      const docs = listJson.docs ?? listJson.data?.docs;
      expect(docs.length).toBe(2);

      // Get by custom code
      const getRes = await client.callTool("get_widget", { id: "MCP-001" });
      expect(getRes.isError).toBeFalsy();
      const getJson = JSON.parse(getRes.content[0]?.text ?? "{}");
      const doc = getJson.data ?? getJson;
      expect(doc.code).toBe("MCP-001");
      expect(doc.name).toBe("MCP Widget");

      // Update by custom code
      const updRes = await client.callTool("update_widget", { id: "MCP-001", price: 44 });
      expect(updRes.isError).toBeFalsy();
      // The DB should reflect it
      const fromRepo = await repo.getOne({ code: "MCP-001" });
      expect((fromRepo as Widget).price).toBe(44);

      // Delete by custom code
      const delRes = await client.callTool("delete_widget", { id: "MCP-002" });
      expect(delRes.isError).toBeFalsy();
      const goneCheck = await repo.getOne({ code: "MCP-002" });
      expect(goneCheck).toBeNull();
    } finally {
      await client.close();
    }
  });
});
