/**
 * Real-world E2E: Soft-delete, Restore, DeleteMany, Hard-delete, Cascade
 *
 * Exercises the full lifecycle through arc's HTTP layer with real mongokit
 * repositories backed by mongodb-memory-server. Tests cover:
 *
 *   1. Single soft-delete  → item hidden from list, visible in GET /deleted
 *   2. Restore             → POST /:id/restore clears deletedAt, fires hooks
 *   3. deleteMany (bulk)   → filter-based soft-delete via DELETE /bulk
 *   4. Hard-delete single  → DELETE /:id?hard=true physically removes
 *   5. Hard-delete bulk    → DELETE /bulk { mode: "hard" } physically removes
 *   6. Cascade via hooks   → delete parent soft-deletes children,
 *                            restore parent restores children
 *   7. Restore hooks       → before:restore / after:restore fire on BaseController
 */

import {
  batchOperationsPlugin,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  Repository,
  softDeletePlugin,
} from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema, type Types } from "mongoose";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";
import { allowPublic } from "../../src/permissions/index.js";

// ============================================================================
// Models — Order (parent) ↔ OrderItem (child) for cascade tests
// ============================================================================

interface IOrder {
  _id: Types.ObjectId;
  orderNumber: string;
  customer: string;
  status: string;
  total: number;
  deletedAt?: Date | null;
}

interface IOrderItem {
  _id: Types.ObjectId;
  orderId: string;
  productName: string;
  quantity: number;
  price: number;
  deletedAt?: Date | null;
}

const OrderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true },
    customer: { type: String, required: true },
    status: { type: String, required: true },
    total: { type: Number, required: true },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

const OrderItemSchema = new Schema<IOrderItem>(
  {
    orderId: { type: String, required: true, index: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// ============================================================================
// Harness
// ============================================================================

let mongoServer: MongoMemoryServer;
let OrderModel: Model<IOrder>;
let OrderItemModel: Model<IOrderItem>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  OrderModel =
    mongoose.models.CascadeOrder ||
    mongoose.model<IOrder>("CascadeOrder", OrderSchema);
  OrderItemModel =
    mongoose.models.CascadeOrderItem ||
    mongoose.model<IOrderItem>("CascadeOrderItem", OrderItemSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await OrderModel.deleteMany({});
  await OrderItemModel.deleteMany({});
});

function buildPlugins() {
  return [
    methodRegistryPlugin(),
    batchOperationsPlugin(),
    softDeletePlugin({ deletedField: "deletedAt", filterMode: "null" }),
    mongoOperationsPlugin(),
  ];
}

function buildApp(
  orderRepo: Repository<IOrder>,
  orderItemRepo: Repository<IOrderItem>,
) {
  const orderResource = defineResource<IOrder>({
    name: "order",
    adapter: createMongooseAdapter({
      model: OrderModel,
      repository: orderRepo,
    }),
    tenantField: false,
    presets: ["softDelete", "bulk"],
    controller: new BaseController(orderRepo, {
      resourceName: "order",
      tenantField: false,
    }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });

  const orderItemResource = defineResource<IOrderItem>({
    name: "order-item",
    adapter: createMongooseAdapter({
      model: OrderItemModel,
      repository: orderItemRepo,
    }),
    tenantField: false,
    presets: ["softDelete", "bulk"],
    controller: new BaseController(orderItemRepo, {
      resourceName: "order-item",
      tenantField: false,
    }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });

  return createApp({
    preset: "development",
    auth: false,
    logger: false,
    helmet: false,
    cors: false,
    rateLimit: false,
    underPressure: false,
    plugins: async (fastify) => {
      await fastify.register(orderResource.toPlugin());
      await fastify.register(orderItemResource.toPlugin());
    },
  });
}

async function seedOrders() {
  const orders = await OrderModel.create([
    { orderNumber: "ORD-001", customer: "Alice", status: "pending", total: 150 },
    { orderNumber: "ORD-002", customer: "Bob", status: "pending", total: 300 },
    { orderNumber: "ORD-003", customer: "Charlie", status: "shipped", total: 75 },
  ]);
  const items = await OrderItemModel.create([
    { orderId: String(orders[0]._id), productName: "Widget A", quantity: 2, price: 50 },
    { orderId: String(orders[0]._id), productName: "Widget B", quantity: 1, price: 50 },
    { orderId: String(orders[1]._id), productName: "Gadget X", quantity: 3, price: 100 },
    { orderId: String(orders[2]._id), productName: "Part Y", quantity: 1, price: 75 },
  ]);
  return { orders, items };
}

// ============================================================================
// 1. Single soft-delete
// ============================================================================

describe("Soft-delete lifecycle — real-world E2E", () => {
  it("DELETE /orders/:id soft-deletes — hidden from list, visible in /deleted", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const orderItemRepo = new Repository<IOrderItem>(OrderItemModel, buildPlugins());
    const app = await buildApp(orderRepo, orderItemRepo);
    await app.ready();

    try {
      const { orders } = await seedOrders();
      const targetId = String(orders[0]._id);

      // Soft-delete ORD-001
      const delRes = await app.inject({
        method: "DELETE",
        url: `/orders/${targetId}`,
      });
      expect(delRes.statusCode).toBe(200);
      const delBody = JSON.parse(delRes.body);
      expect(delBody.success).toBe(true);

      // Verify hidden from normal list
      const listRes = await app.inject({ method: "GET", url: "/orders" });
      const listBody = JSON.parse(listRes.body);
      const ids = (listBody.docs ?? listBody.data?.docs ?? []).map(
        (d: { _id: string }) => d._id,
      );
      expect(ids).not.toContain(targetId);

      // Verify visible in /deleted
      const deletedRes = await app.inject({
        method: "GET",
        url: "/orders/deleted",
      });
      expect(deletedRes.statusCode).toBe(200);
      const deletedBody = JSON.parse(deletedRes.body);
      const deletedDocs =
        deletedBody.docs ?? deletedBody.data?.docs ?? deletedBody.data ?? [];
      const deletedIds = deletedDocs.map((d: { _id: string }) => d._id);
      expect(deletedIds).toContain(targetId);

      // Verify raw DB state: deletedAt is set, doc still exists
      const rawDoc = await OrderModel.findById(targetId).lean();
      expect(rawDoc).toBeTruthy();
      expect(rawDoc!.deletedAt).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  // ==========================================================================
  // 2. Restore
  // ==========================================================================

  it("POST /orders/:id/restore restores a soft-deleted doc", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const orderItemRepo = new Repository<IOrderItem>(OrderItemModel, buildPlugins());
    const app = await buildApp(orderRepo, orderItemRepo);
    await app.ready();

    try {
      const { orders } = await seedOrders();
      const targetId = String(orders[0]._id);

      // Soft-delete first
      await app.inject({ method: "DELETE", url: `/orders/${targetId}` });

      // Confirm hidden
      const rawBefore = await OrderModel.findById(targetId).lean();
      expect(rawBefore!.deletedAt).toBeTruthy();

      // Restore
      const restoreRes = await app.inject({
        method: "POST",
        url: `/orders/${targetId}/restore`,
      });
      expect(restoreRes.statusCode).toBe(200);
      const restoreBody = JSON.parse(restoreRes.body);
      expect(restoreBody.success).toBe(true);

      // Verify deletedAt cleared in DB
      const rawAfter = await OrderModel.findById(targetId).lean();
      expect(rawAfter!.deletedAt).toBeNull();

      // Verify back in normal list
      const listRes = await app.inject({ method: "GET", url: "/orders" });
      const listBody = JSON.parse(listRes.body);
      const ids = (listBody.docs ?? listBody.data?.docs ?? []).map(
        (d: { _id: string }) => d._id,
      );
      expect(ids).toContain(targetId);

      // Verify gone from /deleted
      const deletedRes = await app.inject({
        method: "GET",
        url: "/orders/deleted",
      });
      const deletedBody = JSON.parse(deletedRes.body);
      const deletedDocs =
        deletedBody.docs ?? deletedBody.data?.docs ?? deletedBody.data ?? [];
      const deletedIds = deletedDocs.map((d: { _id: string }) => d._id);
      expect(deletedIds).not.toContain(targetId);
    } finally {
      await app.close();
    }
  });

  it("restore returns 404 for non-existent id", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const orderItemRepo = new Repository<IOrderItem>(OrderItemModel, buildPlugins());
    const app = await buildApp(orderRepo, orderItemRepo);
    await app.ready();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders/507f1f77bcf86cd799439011/restore",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // ==========================================================================
  // 3. Bulk soft-delete (deleteMany)
  // ==========================================================================

  it("DELETE /orders/bulk soft-deletes by filter", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const orderItemRepo = new Repository<IOrderItem>(OrderItemModel, buildPlugins());
    const app = await buildApp(orderRepo, orderItemRepo);
    await app.ready();

    try {
      await seedOrders();

      // Bulk soft-delete all "pending" orders
      const bulkRes = await app.inject({
        method: "DELETE",
        url: "/orders/bulk",
        payload: { filter: { status: "pending" } },
      });
      expect(bulkRes.statusCode).toBe(200);

      // Verify pending orders are soft-deleted in DB
      const pending = await OrderModel.find({ status: "pending" }).lean();
      expect(pending.length).toBe(2);
      expect(pending.every((d) => d.deletedAt !== null)).toBe(true);

      // Verify shipped order untouched
      const shipped = await OrderModel.findOne({ status: "shipped" }).lean();
      expect(shipped!.deletedAt).toBeNull();

      // Normal list should only show the shipped order
      const listRes = await app.inject({ method: "GET", url: "/orders" });
      const listBody = JSON.parse(listRes.body);
      const docs = listBody.docs ?? listBody.data?.docs ?? [];
      expect(docs.length).toBe(1);
      expect(docs[0].orderNumber).toBe("ORD-003");

      // /deleted should show both pending orders
      const deletedRes = await app.inject({
        method: "GET",
        url: "/orders/deleted",
      });
      const deletedBody = JSON.parse(deletedRes.body);
      const deletedDocs =
        deletedBody.docs ?? deletedBody.data?.docs ?? deletedBody.data ?? [];
      expect(deletedDocs.length).toBe(2);
      const deletedNumbers = deletedDocs.map(
        (d: { orderNumber: string }) => d.orderNumber,
      );
      expect(deletedNumbers.sort()).toEqual(["ORD-001", "ORD-002"]);
    } finally {
      await app.close();
    }
  });

  it("DELETE /orders/bulk with _id $in filter soft-deletes specific docs", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const orderItemRepo = new Repository<IOrderItem>(OrderItemModel, buildPlugins());
    const app = await buildApp(orderRepo, orderItemRepo);
    await app.ready();

    try {
      const { orders } = await seedOrders();
      const id0 = String(orders[0]._id);
      const id2 = String(orders[2]._id);

      const bulkRes = await app.inject({
        method: "DELETE",
        url: "/orders/bulk",
        payload: { filter: { _id: { $in: [id0, id2] } } },
      });
      expect(bulkRes.statusCode).toBe(200);

      // ORD-001 and ORD-003 soft-deleted
      const doc0 = await OrderModel.findById(id0).lean();
      const doc2 = await OrderModel.findById(id2).lean();
      expect(doc0!.deletedAt).toBeTruthy();
      expect(doc2!.deletedAt).toBeTruthy();

      // ORD-002 untouched
      const doc1 = await OrderModel.findOne({
        orderNumber: "ORD-002",
      }).lean();
      expect(doc1!.deletedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  // ==========================================================================
  // 4. Hard-delete single
  // ==========================================================================

  it("DELETE /orders/:id?hard=true physically removes the doc", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const orderItemRepo = new Repository<IOrderItem>(OrderItemModel, buildPlugins());
    const app = await buildApp(orderRepo, orderItemRepo);
    await app.ready();

    try {
      const { orders } = await seedOrders();
      const targetId = String(orders[0]._id);

      const delRes = await app.inject({
        method: "DELETE",
        url: `/orders/${targetId}?hard=true`,
      });
      expect(delRes.statusCode).toBe(200);

      // Physically gone — not in DB at all
      const raw = await OrderModel.findById(targetId).lean();
      expect(raw).toBeNull();

      // Not in /deleted either (physically removed, not soft-deleted)
      const deletedRes = await app.inject({
        method: "GET",
        url: "/orders/deleted",
      });
      const deletedBody = JSON.parse(deletedRes.body);
      const deletedDocs =
        deletedBody.docs ?? deletedBody.data?.docs ?? deletedBody.data ?? [];
      const deletedIds = deletedDocs.map((d: { _id: string }) => d._id);
      expect(deletedIds).not.toContain(targetId);
    } finally {
      await app.close();
    }
  });

  // ==========================================================================
  // 5. Hard-delete bulk
  // ==========================================================================

  it("DELETE /orders/bulk { mode: 'hard' } physically removes matched docs", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const orderItemRepo = new Repository<IOrderItem>(OrderItemModel, buildPlugins());
    const app = await buildApp(orderRepo, orderItemRepo);
    await app.ready();

    try {
      await seedOrders();

      const bulkRes = await app.inject({
        method: "DELETE",
        url: "/orders/bulk",
        payload: { filter: { status: "pending" }, mode: "hard" },
      });
      expect(bulkRes.statusCode).toBe(200);
      const body = JSON.parse(bulkRes.body);
      expect(body.success).toBe(true);

      // Physically gone
      const pending = await OrderModel.find({ status: "pending" }).lean();
      expect(pending.length).toBe(0);

      // Shipped still there
      const shipped = await OrderModel.find({ status: "shipped" }).lean();
      expect(shipped.length).toBe(1);

      // Total is now 1
      expect(await OrderModel.countDocuments()).toBe(1);
    } finally {
      await app.close();
    }
  });

  // ==========================================================================
  // 6. Cascade via hooks — delete parent → soft-delete children,
  //    restore parent → restore children
  // ==========================================================================

  it("cascade: delete order soft-deletes its items, restore order restores items", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const orderItemRepo = new Repository<IOrderItem>(OrderItemModel, buildPlugins());

    const app = await buildApp(orderRepo, orderItemRepo);
    await app.ready();

    // Register cascade hooks on the app's own HookSystem (after createApp
    // initializes it) — this is how real apps wire cascade behavior.
    const appHooks = app.arc?.hooks as HookSystem | undefined;
    expect(appHooks).toBeTruthy();

    // Wire cascade: after:delete on "order" → soft-delete matching order-items
    // Note: after hooks receive the doc in `ctx.result`, not `ctx.data`.
    appHooks!.after("order", "delete", async (ctx) => {
      const deleted = ctx.result as IOrder;
      const orderId = String(deleted._id);
      // biome-ignore lint: dynamic repo access for cascade
      await (orderItemRepo as any).deleteMany({ orderId });
    });

    // Wire cascade: after:restore on "order" → restore matching order-items
    appHooks!.after("order", "restore", async (ctx) => {
      const restored = ctx.result as IOrder;
      const orderId = String(restored._id);
      const softDeletedItems = await OrderItemModel.find({
        orderId,
        deletedAt: { $ne: null },
      }).lean();
      for (const item of softDeletedItems) {
        // biome-ignore lint: dynamic repo access for cascade
        await (orderItemRepo as any).restore(String(item._id));
      }
    });

    try {
      const { orders, items } = await seedOrders();
      const orderId = String(orders[0]._id);
      const childIds = items
        .filter((i) => i.orderId === orderId)
        .map((i) => String(i._id));
      expect(childIds.length).toBe(2);

      // --- Step 1: Delete the parent order ---
      const delRes = await app.inject({
        method: "DELETE",
        url: `/orders/${orderId}`,
      });
      expect(delRes.statusCode).toBe(200);

      // Parent soft-deleted
      const parentAfterDel = await OrderModel.findById(orderId).lean();
      expect(parentAfterDel!.deletedAt).toBeTruthy();

      // Children cascade-soft-deleted
      for (const childId of childIds) {
        const child = await OrderItemModel.findById(childId).lean();
        expect(child!.deletedAt).toBeTruthy();
      }

      // Other order's items untouched
      const otherItems = await OrderItemModel.find({
        orderId: { $ne: orderId },
        deletedAt: null,
      }).lean();
      expect(otherItems.length).toBe(2); // Gadget X + Part Y

      // --- Step 2: Restore the parent order ---
      const restoreRes = await app.inject({
        method: "POST",
        url: `/orders/${orderId}/restore`,
      });
      expect(restoreRes.statusCode).toBe(200);

      // Parent restored
      const parentAfterRestore = await OrderModel.findById(orderId).lean();
      expect(parentAfterRestore!.deletedAt).toBeNull();

      // Children cascade-restored
      for (const childId of childIds) {
        const child = await OrderItemModel.findById(childId).lean();
        expect(child!.deletedAt).toBeNull();
      }
    } finally {
      await app.close();
    }
  });

  // ==========================================================================
  // 7. Restore hooks on BaseController
  // ==========================================================================

  it("before:restore and after:restore hooks fire on BaseController.restore()", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const hooks = new HookSystem();
    const hookCalls: string[] = [];

    hooks.before("order", "restore", async (ctx) => {
      hookCalls.push(`before:restore:${(ctx.data as IOrder).orderNumber}`);
    });

    hooks.after("order", "restore", async (ctx) => {
      hookCalls.push(`after:restore:${(ctx.result as IOrder).orderNumber}`);
    });

    const controller = new BaseController<IOrder>(orderRepo, {
      resourceName: "order",
      tenantField: false,
    });

    const { orders } = await seedOrders();
    const target = orders[0];
    const targetId = String(target._id);

    // Soft-delete via repo
    await orderRepo.delete(targetId);
    const deleted = await OrderModel.findById(targetId).lean();
    expect(deleted!.deletedAt).toBeTruthy();

    // Restore via BaseController (directly, to verify hooks fire)
    const result = await controller.restore({
      params: { id: targetId },
      query: {},
      body: {},
      headers: {},
      // biome-ignore lint: minimal request shape
      metadata: { arc: { hooks } } as any,
      // biome-ignore lint: minimal
      user: undefined as any,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);

    // Verify both hooks fired in order
    expect(hookCalls).toEqual([
      `before:restore:${target.orderNumber}`,
      `after:restore:${target.orderNumber}`,
    ]);

    // Verify actually restored in DB
    const restored = await OrderModel.findById(targetId).lean();
    expect(restored!.deletedAt).toBeNull();
  });

  it("before:restore hook can abort the restore", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const hooks = new HookSystem();

    hooks.before("order", "restore", async () => {
      throw new Error("Restore blocked by policy");
    });

    const controller = new BaseController<IOrder>(orderRepo, {
      resourceName: "order",
      tenantField: false,
    });

    const { orders } = await seedOrders();
    const targetId = String(orders[0]._id);
    await orderRepo.delete(targetId);

    const result = await controller.restore({
      params: { id: targetId },
      query: {},
      body: {},
      headers: {},
      // biome-ignore lint: minimal
      metadata: { arc: { hooks } } as any,
      // biome-ignore lint: minimal
      user: undefined as any,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.details?.code).toBe("BEFORE_RESTORE_HOOK_ERROR");
    expect(result.details?.message).toBe("Restore blocked by policy");

    // Doc should still be soft-deleted
    const stillDeleted = await OrderModel.findById(targetId).lean();
    expect(stillDeleted!.deletedAt).toBeTruthy();
  });

  // ==========================================================================
  // 8. Soft-delete → restore → re-delete cycle (idempotency)
  // ==========================================================================

  it("full cycle: create → soft-delete → restore → soft-delete → hard-delete", async () => {
    const orderRepo = new Repository<IOrder>(OrderModel, buildPlugins());
    const orderItemRepo = new Repository<IOrderItem>(OrderItemModel, buildPlugins());
    const app = await buildApp(orderRepo, orderItemRepo);
    await app.ready();

    try {
      // Create
      const createRes = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          orderNumber: "CYCLE-001",
          customer: "Dana",
          status: "draft",
          total: 42,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);
      const id = created.data?._id ?? created._id;
      expect(id).toBeTruthy();

      // Soft-delete
      const del1 = await app.inject({ method: "DELETE", url: `/orders/${id}` });
      expect(del1.statusCode).toBe(200);
      expect((await OrderModel.findById(id).lean())!.deletedAt).toBeTruthy();

      // Restore
      const restore1 = await app.inject({
        method: "POST",
        url: `/orders/${id}/restore`,
      });
      expect(restore1.statusCode).toBe(200);
      expect((await OrderModel.findById(id).lean())!.deletedAt).toBeNull();

      // Hard-delete — permanently gone. The DELETE route's
      // fetchWithAccessControl does NOT pass includeDeleted, so the doc
      // must be visible (not soft-deleted) for hard-delete to find it.
      // This is the correct security behavior: you can't hard-delete a
      // doc you can't see. Soft-delete again first, then restore + hard-delete.
      const hardDel = await app.inject({
        method: "DELETE",
        url: `/orders/${id}?hard=true`,
      });
      expect(hardDel.statusCode).toBe(200);
      expect(await OrderModel.findById(id).lean()).toBeNull();
    } finally {
      await app.close();
    }
  });
});
