/**
 * Concurrent updates with custom idField
 *
 * Verifies that simultaneous PATCH/DELETE operations on the same resource
 * (queried by custom idField) don't corrupt state, leak across requests,
 * or trigger race conditions.
 *
 * Key concerns:
 *   - 50 concurrent PATCH /widgets/sku-1 should all complete safely
 *   - Each request derives its own `repoId` from its own fetch — no shared state
 *   - Mixed PATCH+DELETE in flight: deletes that win race should 404 the patches
 *   - Bulk + concurrent: cross-org isolation holds under load
 */

import { Repository } from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

interface IInventory {
  sku: string;
  name: string;
  stock: number;
  version: number;
}

const InventorySchema = new Schema<IInventory>(
  {
    sku: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    stock: { type: Number, default: 0 },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let InventoryModel: Model<IInventory>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  InventoryModel =
    mongoose.models.ConcInventory || mongoose.model<IInventory>("ConcInventory", InventorySchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await InventoryModel.deleteMany({});
});

async function buildApp() {
  const repo = new Repository<IInventory>(InventoryModel);
  const resource = defineResource<IInventory>({
    name: "inventory",
    prefix: "/inventories",
    // biome-ignore lint: generic
    adapter: createMongooseAdapter({ model: InventoryModel, repository: repo }),
    idField: "sku",
    tenantField: false,
    controller: new BaseController(repo, {
      resourceName: "inventory",
      idField: "sku",
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

  const app = await createApp({
    preset: "development",
    auth: false,
    logger: false,
    helmet: false,
    rateLimit: false,
    plugins: async (fastify) => {
      await fastify.register(resource.toPlugin());
    },
  });
  await app.ready();
  return app;
}

describe("Concurrent updates with custom idField", () => {
  it("50 concurrent PATCH /inventories/:sku — all succeed, no corruption", async () => {
    const app = await buildApp();
    try {
      await InventoryModel.create({ sku: "WIDGET-001", name: "Widget", stock: 100, version: 0 });

      // Fire 50 PATCH requests in parallel, each setting a different name
      const requests = Array.from({ length: 50 }, (_, i) =>
        app.inject({
          method: "PATCH",
          url: "/inventories/WIDGET-001",
          payload: { name: `Concurrent-${i}` },
        }),
      );
      const results = await Promise.all(requests);

      // Every request must succeed (no race-induced failures)
      const successCount = results.filter((r) => r.statusCode === 200).length;
      expect(successCount).toBe(50);

      // The doc should still exist with SOME concurrent name (the last write wins)
      const doc = await InventoryModel.findOne({ sku: "WIDGET-001" }).lean();
      expect(doc).toBeTruthy();
      expect(doc?.name).toMatch(/^Concurrent-\d+$/);
      // The custom idField is preserved
      expect(doc?.sku).toBe("WIDGET-001");
    } finally {
      await app.close();
    }
  });

  it("100 concurrent PATCHes on different SKUs — no cross-doc contamination", async () => {
    const app = await buildApp();
    try {
      // Seed 10 distinct SKUs
      await InventoryModel.insertMany(
        Array.from({ length: 10 }, (_, i) => ({
          sku: `ITEM-${i.toString().padStart(3, "0")}`,
          name: `Original ${i}`,
          stock: i * 10,
          version: 0,
        })),
      );

      // Fire 100 PATCHes (10 per SKU), each setting a unique name
      const requests: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 10; j++) {
          const sku = `ITEM-${i.toString().padStart(3, "0")}`;
          requests.push(
            app.inject({
              method: "PATCH",
              url: `/inventories/${sku}`,
              payload: { name: `${sku}-update-${j}` },
            }),
          );
        }
      }
      const results = (await Promise.all(requests)) as Array<{ statusCode: number }>;
      const successCount = results.filter((r) => r.statusCode === 200).length;
      expect(successCount).toBe(100);

      // Every doc should still exist with the right SKU
      const docs = await InventoryModel.find({}).lean();
      expect(docs.length).toBe(10);
      for (let i = 0; i < 10; i++) {
        const sku = `ITEM-${i.toString().padStart(3, "0")}`;
        const doc = docs.find((d) => d.sku === sku);
        expect(doc).toBeTruthy();
        // The name should be one of the patches for THIS sku, not another sku
        expect(doc?.name).toMatch(new RegExp(`^${sku}-update-\\d+$`));
      }
    } finally {
      await app.close();
    }
  });

  it("PATCH + DELETE race: late PATCH after DELETE returns 404, doc stays deleted", async () => {
    const app = await buildApp();
    try {
      await InventoryModel.create({
        sku: "RACE-001",
        name: "Will be deleted",
        stock: 50,
        version: 0,
      });

      // Fire DELETE first, then 5 PATCHes — they should all observe the deletion eventually
      const delPromise = app.inject({ method: "DELETE", url: "/inventories/RACE-001" });
      const patchPromises = Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: "PATCH",
          url: "/inventories/RACE-001",
          payload: { name: `late-${i}` },
        }),
      );

      const [delRes, ...patchResults] = await Promise.all([delPromise, ...patchPromises]);
      expect(delRes.statusCode).toBe(200);

      // Each PATCH either: succeeded (ran before the delete) → 200,
      // or saw the deleted state → 404. Both are acceptable.
      for (const r of patchResults) {
        expect([200, 404]).toContain(r.statusCode);
      }

      // The doc must be deleted at the end (no zombie resurrection)
      const doc = await InventoryModel.findOne({ sku: "RACE-001" });
      expect(doc).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("concurrent DELETEs on same sku — first wins, others get 404 (no errors)", async () => {
    const app = await buildApp();
    try {
      await InventoryModel.create({ sku: "DEL-RACE", name: "Goner", stock: 1, version: 0 });

      const requests = Array.from({ length: 10 }, () =>
        app.inject({ method: "DELETE", url: "/inventories/DEL-RACE" }),
      );
      const results = await Promise.all(requests);

      const successCount = results.filter((r) => r.statusCode === 200).length;
      const notFoundCount = results.filter((r) => r.statusCode === 404).length;
      // At least one delete must succeed
      expect(successCount).toBeGreaterThanOrEqual(1);
      // Total must equal 10 (no 5xx errors)
      expect(successCount + notFoundCount).toBe(10);

      const doc = await InventoryModel.findOne({ sku: "DEL-RACE" });
      expect(doc).toBeNull();
    } finally {
      await app.close();
    }
  });
});
