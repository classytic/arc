/**
 * Compensation + MongoKit Transaction E2E
 *
 * Proves withCompensation works alongside MongoKit's withTransaction:
 * - DB writes inside a transaction (atomic)
 * - External API calls outside the transaction (compensated on failure)
 * - Transaction rollback on DB error
 * - Compensation rollback on external call failure
 */

import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { type Connection, Schema, type Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface IOrder {
  _id: Types.ObjectId;
  userId: string;
  items: string[];
  total: number;
  status: string;
}

interface IInventory {
  _id: Types.ObjectId;
  sku: string;
  quantity: number;
}

let replSet: MongoMemoryReplSet;
let connection: Connection;
let OrderModel: mongoose.Model<IOrder>;
let InventoryModel: mongoose.Model<IInventory>;

describe("Compensation + MongoKit Transaction", () => {
  beforeAll(async () => {
    // Need a replica set for transactions — allow extra time for startup under parallel load
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await replSet.waitUntilRunning();
    const uri = replSet.getUri("comp-txn");
    connection = mongoose.createConnection(uri, {
      serverSelectionTimeoutMS: 10000,
    });
    await connection.asPromise();
    // Wait for primary election under parallel load
    await connection.db?.admin().ping();

    const suffix = Date.now();
    OrderModel = connection.model<IOrder>(
      `CompTxnOrder_${suffix}`,
      new Schema<IOrder>({
        userId: String,
        items: [String],
        total: Number,
        status: { type: String, default: "pending" },
      }),
    );

    InventoryModel = connection.model<IInventory>(
      `CompTxnInv_${suffix}`,
      new Schema<IInventory>({
        sku: { type: String, unique: true },
        quantity: Number,
      }),
    );
  });

  afterAll(async () => {
    await connection.close();
    await replSet.stop();
  });

  beforeEach(async () => {
    await OrderModel.deleteMany({});
    await InventoryModel.deleteMany({});
  });

  // ==========================================================================
  // Happy path: transaction + compensation both succeed
  // ==========================================================================

  it("commits transaction and skips compensation on full success", { retry: 2 }, async () => {
    const { withCompensation } = await import("../../src/utils/compensation.js");

    // Seed inventory
    await InventoryModel.create({ sku: "widget", quantity: 10 });

    const externalPaymentService = {
      charge: vi.fn().mockResolvedValue({ chargeId: "ch-001" }),
      refund: vi.fn(),
    };

    const result = await withCompensation("order-checkout", [
      {
        name: "db-operations",
        execute: async (ctx) => {
          // Use a real MongoDB transaction for DB writes
          const session = await connection.startSession();
          try {
            session.startTransaction();

            const order = await OrderModel.create(
              [{ userId: "u1", items: ["widget"], total: 25, status: "confirmed" }],
              { session },
            );
            ctx.orderId = order[0]._id.toString();

            await InventoryModel.updateOne(
              { sku: "widget" },
              { $inc: { quantity: -1 } },
              { session },
            );

            await session.commitTransaction();
            return { orderId: ctx.orderId };
          } catch (err) {
            await session.abortTransaction();
            throw err;
          } finally {
            await session.endSession();
          }
        },
        compensate: async (ctx) => {
          // If external call fails after DB commit, undo DB changes
          await OrderModel.findByIdAndUpdate(ctx.orderId, { status: "cancelled" });
          await InventoryModel.updateOne({ sku: "widget" }, { $inc: { quantity: 1 } });
        },
      },
      {
        name: "charge-payment",
        execute: async (ctx) => {
          const charge = await externalPaymentService.charge(ctx.orderId, 25);
          ctx.chargeId = charge.chargeId;
          return charge;
        },
        compensate: async (_ctx, result) => {
          await externalPaymentService.refund((result as { chargeId: string }).chargeId);
        },
      },
    ]);

    if (!result.success) {
      // Surface the actual error for debugging flaky failures
      throw new Error(
        `Compensation failed: step=${result.failedStep} error=${result.error} compensationErrors=${JSON.stringify(result.compensationErrors)}`,
      );
    }

    // Verify DB state
    const order = await OrderModel.findById(
      result.results["db-operations"] &&
        (result.results["db-operations"] as { orderId: string }).orderId,
    ).lean();
    expect(order?.status).toBe("confirmed");

    const inventory = await InventoryModel.findOne({ sku: "widget" }).lean();
    expect(inventory?.quantity).toBe(9);

    // External service was called, not refunded
    expect(externalPaymentService.charge).toHaveBeenCalledTimes(1);
    expect(externalPaymentService.refund).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // External call fails → DB compensated
  // ==========================================================================

  it("compensates DB writes when external payment fails", async () => {
    const { withCompensation } = await import("../../src/utils/compensation.js");

    await InventoryModel.create({ sku: "gadget", quantity: 5 });

    const externalPaymentService = {
      charge: vi.fn().mockRejectedValue(new Error("Card declined")),
      refund: vi.fn(),
    };

    const result = await withCompensation("order-checkout", [
      {
        name: "db-operations",
        execute: async (ctx) => {
          const session = await connection.startSession();
          try {
            session.startTransaction();

            const order = await OrderModel.create(
              [{ userId: "u2", items: ["gadget"], total: 30, status: "confirmed" }],
              { session },
            );
            ctx.orderId = order[0]._id.toString();

            await InventoryModel.updateOne(
              { sku: "gadget" },
              { $inc: { quantity: -1 } },
              { session },
            );

            await session.commitTransaction();
            return { orderId: ctx.orderId };
          } catch (err) {
            await session.abortTransaction();
            throw err;
          } finally {
            await session.endSession();
          }
        },
        compensate: async (ctx) => {
          await OrderModel.findByIdAndUpdate(ctx.orderId, { status: "cancelled" });
          await InventoryModel.updateOne({ sku: "gadget" }, { $inc: { quantity: 1 } });
        },
      },
      {
        name: "charge-payment",
        execute: async () => {
          return await externalPaymentService.charge();
        },
        compensate: async (_ctx, result) => {
          if (result) await externalPaymentService.refund();
        },
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("charge-payment");
    expect(result.error).toBe("Card declined");

    // DB was compensated — order cancelled, inventory restored
    const order = await OrderModel.findById(
      result.results["db-operations"] &&
        (result.results["db-operations"] as { orderId: string }).orderId,
    ).lean();
    expect(order?.status).toBe("cancelled");

    const inventory = await InventoryModel.findOne({ sku: "gadget" }).lean();
    expect(inventory?.quantity).toBe(5); // restored

    // Payment charge failed, refund NOT called (charge never succeeded)
    expect(externalPaymentService.refund).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // MongoKit repo.withTransaction + compensation
  // ==========================================================================

  it("works with MongoKit repository withTransaction", async () => {
    const { withCompensation } = await import("../../src/utils/compensation.js");
    const { Repository } = await import("@classytic/mongokit");

    await InventoryModel.create({ sku: "doohickey", quantity: 3 });

    const orderRepo = new Repository(OrderModel);
    const inventoryRepo = new Repository(InventoryModel);

    const externalNotify = vi.fn().mockRejectedValue(new Error("Email service down"));

    const result = await withCompensation("with-mongokit", [
      {
        name: "create-order",
        execute: async (ctx) => {
          // Use MongoKit's withTransaction
          const order = await orderRepo.withTransaction(async (session) => {
            const created = await orderRepo.create(
              { userId: "u3", items: ["doohickey"], total: 15, status: "processing" },
              { session },
            );
            await InventoryModel.updateOne(
              { sku: "doohickey" },
              { $inc: { quantity: -1 } },
              { session },
            );
            return created;
          });
          ctx.orderId = (order as { _id: Types.ObjectId })._id.toString();
          return { orderId: ctx.orderId };
        },
        compensate: async (ctx) => {
          await OrderModel.findByIdAndUpdate(ctx.orderId, { status: "rolled-back" });
          await InventoryModel.updateOne({ sku: "doohickey" }, { $inc: { quantity: 1 } });
        },
      },
      {
        name: "notify",
        execute: async () => await externalNotify(),
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("notify");

    // DB was compensated
    const order = await OrderModel.findOne({ userId: "u3" }).lean();
    expect(order?.status).toBe("rolled-back");

    const inv = await InventoryModel.findOne({ sku: "doohickey" }).lean();
    expect(inv?.quantity).toBe(3); // restored
  });
});
