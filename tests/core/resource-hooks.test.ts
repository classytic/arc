/**
 * Resource Hooks — Inline hooks on defineResource({ hooks })
 *
 * Tests that config.hooks are properly wired into the HookSystem pipeline
 * and fire with the correct context (data, user, meta).
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/index.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { ResourceHookContext } from "../../src/types/index.js";

// ============================================================================
// Setup
// ============================================================================

interface IItem {
  name: string;
  price: number;
  status: string;
}

const ItemSchema = new Schema<IItem>(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    status: { type: String, default: "active" },
  },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let ItemModel: Model<IItem>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ItemModel = mongoose.models.HookItem || mongoose.model<IItem>("HookItem", ItemSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ItemModel.deleteMany({});
});

function createItemResource(hooks: Record<string, unknown>) {
  const repo = new Repository<IItem>(ItemModel);
  const qp = new QueryParser();

  return defineResource({
    name: "item",
    displayName: "Item",
    adapter: createMongooseAdapter(ItemModel, repo),
    controller: new BaseController(repo, {
      resourceName: "item",
      queryParser: qp,
      tenantField: false,
    }),
    queryParser: qp,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    schemaOptions: {
      fieldRules: {
        name: { type: "string", required: true },
        price: { type: "number" },
        status: { type: "string" },
      },
    },
    hooks: hooks as any,
  });
}

async function buildApp(hooks: Record<string, unknown>) {
  const resource = createItemResource(hooks);
  const app = await createApp({
    preset: "testing",
    auth: false,
    logger: false,
    helmet: false,
    cors: false,
    rateLimit: false,
    underPressure: false,
    plugins: async (f) => {
      await f.register(resource.toPlugin());
    },
  });
  return app;
}

// ============================================================================
// Tests
// ============================================================================

describe("defineResource({ hooks }) — inline hooks", () => {
  // ── afterCreate ──

  it("afterCreate fires on POST with created document", async () => {
    const afterCreate = vi.fn();
    const app = await buildApp({ afterCreate });

    const res = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Widget", price: 10 },
    });

    expect(res.statusCode).toBe(201);
    expect(afterCreate).toHaveBeenCalledTimes(1);

    const ctx: ResourceHookContext = afterCreate.mock.calls[0][0];
    expect(ctx.data).toBeDefined();
    expect(ctx.data.name).toBe("Widget");
  });

  // ── beforeCreate ──

  it("beforeCreate fires before create and receives body data", async () => {
    const beforeCreate = vi.fn();
    const app = await buildApp({ beforeCreate });

    await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Gadget", price: 20 },
    });

    expect(beforeCreate).toHaveBeenCalledTimes(1);
    const ctx: ResourceHookContext = beforeCreate.mock.calls[0][0];
    expect(ctx.data.name).toBe("Gadget");
    expect(ctx.data.price).toBe(20);
  });

  // ── afterUpdate ──

  it("afterUpdate fires on PUT with updated document", async () => {
    const afterUpdate = vi.fn();
    const app = await buildApp({ afterUpdate });

    // Create first
    const createRes = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Original", price: 5 },
    });
    const id = JSON.parse(createRes.body)._id;

    // Update
    const res = await app.inject({
      method: "PATCH",
      url: `/items/${id}`,
      payload: { name: "Updated", price: 15 },
    });

    expect(res.statusCode).toBe(200);
    expect(afterUpdate).toHaveBeenCalledTimes(1);

    const ctx: ResourceHookContext = afterUpdate.mock.calls[0][0];
    expect(ctx.data).toBeDefined();
  });

  // ── beforeUpdate ──

  it("beforeUpdate receives data and meta.id", async () => {
    const beforeUpdate = vi.fn();
    const app = await buildApp({ beforeUpdate });

    const createRes = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Pre-update", price: 1 },
    });
    const id = JSON.parse(createRes.body)._id;

    await app.inject({
      method: "PATCH",
      url: `/items/${id}`,
      payload: { price: 99 },
    });

    expect(beforeUpdate).toHaveBeenCalledTimes(1);
    const ctx: ResourceHookContext = beforeUpdate.mock.calls[0][0];
    expect(ctx.data).toBeDefined();
    expect(ctx.meta?.id).toBe(id);
  });

  // ── afterDelete ──

  it("afterDelete fires on DELETE with deleted document", async () => {
    const afterDelete = vi.fn();
    const app = await buildApp({ afterDelete });

    const createRes = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "To Delete", price: 0 },
    });
    const id = JSON.parse(createRes.body)._id;

    const res = await app.inject({
      method: "DELETE",
      url: `/items/${id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(afterDelete).toHaveBeenCalledTimes(1);

    const ctx: ResourceHookContext = afterDelete.mock.calls[0][0];
    expect(ctx.data).toBeDefined();
    expect(ctx.data.name).toBe("To Delete");
    expect(ctx.meta?.id).toBe(id);
  });

  // ── beforeDelete ──

  it("beforeDelete receives the existing document before deletion", async () => {
    const beforeDelete = vi.fn();
    const app = await buildApp({ beforeDelete });

    const createRes = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Will Delete", price: 42 },
    });
    const id = JSON.parse(createRes.body)._id;

    await app.inject({
      method: "DELETE",
      url: `/items/${id}`,
    });

    expect(beforeDelete).toHaveBeenCalledTimes(1);
    const ctx: ResourceHookContext = beforeDelete.mock.calls[0][0];
    expect(ctx.data.name).toBe("Will Delete");
    expect(ctx.meta?.id).toBe(id);
  });

  // ── Multiple hooks ──

  it("multiple hooks fire in correct order", async () => {
    const order: string[] = [];
    const app = await buildApp({
      beforeCreate: (_ctx: ResourceHookContext) => {
        order.push("beforeCreate");
      },
      afterCreate: (_ctx: ResourceHookContext) => {
        order.push("afterCreate");
      },
    });

    await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Order Test", price: 1 },
    });

    // afterCreate is awaited in BaseController before response
    expect(order).toEqual(["beforeCreate", "afterCreate"]);
  });

  // ── No hooks ──

  it("works normally without hooks defined", async () => {
    const app = await buildApp({});

    const res = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "No Hooks", price: 5 },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).name).toBe("No Hooks");
  });

  // ── Context shape ──

  it("afterCreate ctx.data contains the full created document with _id", async () => {
    let captured: ResourceHookContext | null = null;
    const app = await buildApp({
      afterCreate: (ctx: ResourceHookContext) => {
        captured = ctx;
      },
    });

    await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Full Doc", price: 77 },
    });

    expect(captured).not.toBeNull();
    expect(captured?.data._id).toBeDefined();
    expect(captured?.data.name).toBe("Full Doc");
    expect(captured?.data.price).toBe(77);
  });

  it("beforeUpdate ctx.meta contains id and existing document", async () => {
    let captured: ResourceHookContext | null = null;
    const app = await buildApp({
      beforeUpdate: (ctx: ResourceHookContext) => {
        captured = ctx;
      },
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Before Update", price: 10 },
    });
    const id = JSON.parse(createRes.body)._id;

    await app.inject({
      method: "PATCH",
      url: `/items/${id}`,
      payload: { price: 20 },
    });

    expect(captured).not.toBeNull();
    expect(captured?.meta?.id).toBe(id);
    expect(captured?.meta?.existing).toBeDefined();
    expect((captured?.meta?.existing as any).name).toBe("Before Update");
  });

  it("afterUpdate ctx.data contains the updated document", async () => {
    let captured: ResourceHookContext | null = null;
    const app = await buildApp({
      afterUpdate: (ctx: ResourceHookContext) => {
        captured = ctx;
      },
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Will Update", price: 5 },
    });
    const id = JSON.parse(createRes.body)._id;

    await app.inject({
      method: "PATCH",
      url: `/items/${id}`,
      payload: { name: "Did Update", price: 50 },
    });

    expect(captured).not.toBeNull();
    expect(captured?.data).toBeDefined();
  });

  it("afterDelete ctx.meta.id matches the deleted resource", async () => {
    let captured: ResourceHookContext | null = null;
    const app = await buildApp({
      afterDelete: (ctx: ResourceHookContext) => {
        captured = ctx;
      },
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Delete Me", price: 0 },
    });
    const id = JSON.parse(createRes.body)._id;

    await app.inject({
      method: "DELETE",
      url: `/items/${id}`,
    });

    expect(captured).not.toBeNull();
    expect(captured?.meta?.id).toBe(id);
    expect(captured?.data.name).toBe("Delete Me");
  });

  // ── Error handling ──

  it("async hook errors in after phase do not crash the response", async () => {
    const app = await buildApp({
      afterCreate: async () => {
        throw new Error("Hook exploded");
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Should Succeed", price: 1 },
    });

    // Response should succeed — after hook errors are swallowed
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).name).toBe("Should Succeed");
  });

  it("before hook error prevents the operation", async () => {
    const app = await buildApp({
      beforeCreate: async () => {
        throw new Error("Blocked by hook");
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Should Fail", price: 1 },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    // Nothing should be created in DB
    const count = await ItemModel.countDocuments();
    expect(count).toBe(0);
  });

  // ── Full CRUD lifecycle ──

  it("all 6 hooks fire during a full create → update → delete lifecycle", async () => {
    const events: string[] = [];
    const app = await buildApp({
      beforeCreate: (_ctx: ResourceHookContext) => {
        events.push("beforeCreate");
      },
      afterCreate: (_ctx: ResourceHookContext) => {
        events.push("afterCreate");
      },
      beforeUpdate: (_ctx: ResourceHookContext) => {
        events.push("beforeUpdate");
      },
      afterUpdate: (_ctx: ResourceHookContext) => {
        events.push("afterUpdate");
      },
      beforeDelete: (_ctx: ResourceHookContext) => {
        events.push("beforeDelete");
      },
      afterDelete: (_ctx: ResourceHookContext) => {
        events.push("afterDelete");
      },
    });

    // Create
    const createRes = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Lifecycle", price: 10 },
    });
    expect(createRes.statusCode).toBe(201);
    const id = JSON.parse(createRes.body)._id;

    // Update
    const updateRes = await app.inject({
      method: "PATCH",
      url: `/items/${id}`,
      payload: { price: 99 },
    });
    expect(updateRes.statusCode).toBe(200);

    // Delete
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/items/${id}`,
    });
    expect(deleteRes.statusCode).toBe(200);

    expect(events).toEqual([
      "beforeCreate",
      "afterCreate",
      "beforeUpdate",
      "afterUpdate",
      "beforeDelete",
      "afterDelete",
    ]);
  });

  // ── Hooks alongside presets ──

  it("inline hooks work alongside preset hooks", async () => {
    const afterCreateFired = vi.fn();

    const repo = new Repository<IItem>(ItemModel);
    const qp = new QueryParser();

    const resource = defineResource({
      name: "item",
      displayName: "Item",
      adapter: createMongooseAdapter(ItemModel, repo),
      controller: new BaseController(repo, {
        resourceName: "item",
        queryParser: qp,
        tenantField: false,
      }),
      queryParser: qp,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: {
        fieldRules: {
          name: { type: "string", required: true },
          price: { type: "number" },
          status: { type: "string" },
        },
      },
      presets: ["softDelete"],
      hooks: {
        afterCreate: (ctx: ResourceHookContext) => {
          afterCreateFired(ctx);
        },
      },
    });

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "With Preset", price: 5 },
    });

    expect(res.statusCode).toBe(201);
    expect(afterCreateFired).toHaveBeenCalledTimes(1);
  });

  // ── Hook does not fire on disabled route ──

  it("hooks do not fire for operations that are never called", async () => {
    const afterDelete = vi.fn();
    const app = await buildApp({ afterDelete });

    // Only create — delete hook should NOT fire
    await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "No Delete", price: 1 },
    });

    expect(afterDelete).not.toHaveBeenCalled();
  });

  // ── Concurrent requests ──

  it("hooks handle concurrent requests independently", async () => {
    const calls: string[] = [];
    const app = await buildApp({
      afterCreate: async (ctx: ResourceHookContext) => {
        calls.push(ctx.data.name as string);
      },
    });

    // Fire 3 concurrent creates
    await Promise.all([
      app.inject({ method: "POST", url: "/items", payload: { name: "A", price: 1 } }),
      app.inject({ method: "POST", url: "/items", payload: { name: "B", price: 2 } }),
      app.inject({ method: "POST", url: "/items", payload: { name: "C", price: 3 } }),
    ]);

    expect(calls).toHaveLength(3);
    expect(calls.sort()).toEqual(["A", "B", "C"]);
  });
});
