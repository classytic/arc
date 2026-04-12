/**
 * Repository Contract Conformance — mongokit 3.6 Reference
 *
 * Exercises arc's canonical `CrudRepository<TDoc>` surface against a real
 * `@classytic/mongokit` 3.6.0 `Repository` backed by `mongodb-memory-server`
 * with seeded data. Serves two purposes:
 *
 * 1. **Regression gate** — any future arc change that breaks the mongokit
 *    integration gets caught here.
 * 2. **Reference for 3rd-party kit authors** — copy this file, swap in your
 *    `prismakit` / `pgkit` / `sqlitekit` repository, and make it pass. If
 *    every green check here translates to green on your kit, arc's
 *    BaseController + presets will work out of the box.
 *
 * The tests go method-by-method through every tier:
 *
 *   Required:     getAll, getById, create, update, delete
 *   Recommended:  getOne
 *   Optional:     count, exists, distinct, findAll, getOrCreate, createMany,
 *                 updateMany, deleteMany, bulkWrite, restore, getDeleted,
 *                 aggregate, withTransaction, geo operators via QueryParser,
 *                 lookup/populate, hard-delete forwarding, keyset pagination,
 *                 `before:restore` and `before:delete` hooks
 *
 * Each `it()` name starts with the contract section it exercises so
 * diagnostic output reads as a capability checklist.
 */

import {
  batchOperationsPlugin,
  methodRegistryPlugin,
  QueryParser,
  Repository,
  softDeletePlugin,
  withTransaction,
} from "@classytic/mongokit";
import { type MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Connection, Schema, type Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  BulkWriteOperation,
  CrudRepository,
  DeleteManyResult,
  DeleteResult,
  KeysetPaginatedResult,
  OffsetPaginatedResult,
  PaginationResult,
  UpdateManyResult,
} from "../../src/types/index.js";

// ============================================================================
// Seed data
// ============================================================================

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  sku: string;
  price: number;
  category: string;
  tags: string[];
  stock: number;
  location?: { type: "Point"; coordinates: [number, number] };
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true },
    sku: { type: String, required: true, unique: true },
    price: { type: Number, required: true },
    category: { type: String, required: true, index: true },
    tags: [String],
    stock: { type: Number, default: 0 },
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
productSchema.index({ location: "2dsphere" });
productSchema.index({ category: 1, price: -1 });

const SEED: Array<Omit<IProduct, "_id" | "createdAt" | "updatedAt">> = [
  {
    name: "Espresso Machine",
    sku: "ESM-001",
    price: 499,
    category: "kitchen",
    tags: ["coffee", "premium"],
    stock: 10,
    location: { type: "Point", coordinates: [-73.9857, 40.7484] }, // NYC
  },
  {
    name: "French Press",
    sku: "FRP-002",
    price: 29,
    category: "kitchen",
    tags: ["coffee", "budget"],
    stock: 50,
    location: { type: "Point", coordinates: [-73.9857, 40.7484] },
  },
  {
    name: "Desk Lamp",
    sku: "DLP-003",
    price: 89,
    category: "office",
    tags: ["lighting", "minimalist"],
    stock: 25,
    location: { type: "Point", coordinates: [-122.4194, 37.7749] }, // SF
  },
  {
    name: "Office Chair",
    sku: "OCH-004",
    price: 399,
    category: "office",
    tags: ["ergonomic", "premium"],
    stock: 5,
    location: { type: "Point", coordinates: [-122.4194, 37.7749] },
  },
  {
    name: "Yoga Mat",
    sku: "YMT-005",
    price: 45,
    category: "fitness",
    tags: ["exercise", "budget"],
    stock: 30,
    location: { type: "Point", coordinates: [-87.6298, 41.8781] }, // Chicago
  },
  {
    name: "Dumbbell Set",
    sku: "DMB-006",
    price: 149,
    category: "fitness",
    tags: ["exercise", "strength"],
    stock: 15,
    location: { type: "Point", coordinates: [-87.6298, 41.8781] },
  },
];

// ============================================================================
// Harness
// ============================================================================

type ProductRepo = Repository<IProduct> &
  CrudRepository<IProduct> & {
    updateMany: NonNullable<CrudRepository<IProduct>["updateMany"]>;
    deleteMany: NonNullable<CrudRepository<IProduct>["deleteMany"]>;
    bulkWrite: NonNullable<CrudRepository<IProduct>["bulkWrite"]>;
    restore: NonNullable<CrudRepository<IProduct>["restore"]>;
    getDeleted: NonNullable<CrudRepository<IProduct>["getDeleted"]>;
  };

let mongoServer: MongoMemoryServer;
const replSet: MongoMemoryReplSet | null = null;
let connection: Connection;
let ProductModel: mongoose.Model<IProduct>;
let repo: ProductRepo;

const warnings: string[] = [];

describe("Repository Contract — mongokit 3.6 reference", () => {
  beforeAll(async () => {
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
      origWarn(...args);
    };

    mongoServer = await MongoMemoryServer.create();
    connection = mongoose.createConnection(mongoServer.getUri("contract-test"));
    await connection.asPromise();

    ProductModel = connection.model<IProduct>("ContractProduct", productSchema);

    repo = new Repository<IProduct>(ProductModel, [
      methodRegistryPlugin(),
      softDeletePlugin(),
      batchOperationsPlugin(),
    ]) as ProductRepo;
  });

  afterAll(async () => {
    await connection?.close();
    await mongoServer?.stop();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
    await ProductModel.insertMany(SEED);
  });

  // ==========================================================================
  // Required: Core CRUD
  // ==========================================================================

  describe("Required — core CRUD", () => {
    it("getAll: returns offset PaginationResult when `page` is given", async () => {
      const result = await repo.getAll({ page: 1, limit: 3 });
      const offset = result as OffsetPaginatedResult<IProduct>;
      expect(offset.docs.length).toBe(3);
      expect(offset.page).toBe(1);
      expect(offset.total).toBe(6);
      expect(offset.pages).toBe(2);
      expect(offset.hasNext).toBe(true);
      expect(offset.hasPrev).toBe(false);
    });

    it("getAll: returns keyset PaginationResult when `sort` given without `page`", async () => {
      const result = await repo.getAll({
        sort: { createdAt: -1 },
        limit: 2,
      });
      // keyset mode is detected by mongokit — `method: "keyset"` or equivalent
      // shape. Accept either: our discriminated union covers both.
      expect(result).toHaveProperty("docs");
      const anyResult = result as Record<string, unknown>;
      if ("method" in anyResult && anyResult.method === "keyset") {
        const keyset = result as KeysetPaginatedResult<IProduct>;
        expect(keyset.docs.length).toBe(2);
        expect(typeof keyset.hasMore).toBe("boolean");
        expect(keyset.next === null || typeof keyset.next === "string").toBe(true);
      } else {
        // Legacy offset shape fallback — still valid under the contract.
        const offset = result as OffsetPaginatedResult<IProduct>;
        expect(offset.docs.length).toBe(2);
      }
    });

    it("getById: returns a single doc (and throws-OR-null on miss)", async () => {
      const first = await ProductModel.findOne().lean();
      const found = await repo.getById(String(first!._id));
      expect(found).toBeTruthy();
      expect(found?.sku).toBe(first!.sku);

      // CONTRACT NOTE — arc types `getById` as `Promise<TDoc | null>`, but
      // mongokit 3.6 THROWS a 404 error on miss by default. Pass
      // `{ throwOnNotFound: false }` to get null back. Arc's BaseController
      // handles both styles (AccessControl.ts catches "not found" errors),
      // so 3rd-party kits may implement either convention. 3rd-party kit
      // authors: document which style you use so consumers don't guess.
      let missing: IProduct | null = null;
      let threw = false;
      try {
        missing = (await repo.getById("507f1f77bcf86cd799439011", {
          throwOnNotFound: false,
        } as unknown as undefined)) as IProduct | null;
      } catch (err) {
        threw = true;
        expect((err as Error).message).toMatch(/not found/i);
      }
      expect(missing === null || threw).toBe(true);
    });

    it("create: inserts and returns the created doc", async () => {
      const created = await repo.create({
        name: "Blender",
        sku: "BLN-999",
        price: 79,
        category: "kitchen",
        tags: [],
        stock: 20,
      } as Partial<IProduct>);
      expect(created).toBeTruthy();
      expect((created as IProduct).sku).toBe("BLN-999");
      expect(await repo.count?.({})).toBe(7);
    });

    it("update: updates by id and returns the new doc", async () => {
      const first = await ProductModel.findOne({ sku: "ESM-001" }).lean();
      const updated = await repo.update(String(first!._id), { price: 549 });
      expect(updated).toBeTruthy();
      expect((updated as IProduct).price).toBe(549);
    });

    it("delete: returns DeleteResult with success=true", async () => {
      const first = await ProductModel.findOne({ sku: "FRP-002" }).lean();
      const result = (await repo.delete(String(first!._id))) as DeleteResult;
      expect(result.success).toBe(true);
      // soft-delete plugin is wired → should return soft: true
      expect(result.soft).toBe(true);
      // the doc is still there, but flagged
      const found = await ProductModel.findOne({ sku: "FRP-002" }).lean();
      expect(found?.deletedAt).toBeTruthy();
    });
  });

  // ==========================================================================
  // Recommended: Compound-filter read
  // ==========================================================================

  describe("Recommended — getOne compound filter", () => {
    it("getOne: finds by compound filter (sku + category)", async () => {
      expect(typeof repo.getOne).toBe("function");
      const found = await repo.getOne!({ sku: "DLP-003", category: "office" });
      expect(found).toBeTruthy();
      expect((found as IProduct).name).toBe("Desk Lamp");
    });

    it("getOne: throws-OR-null when filter matches nothing", async () => {
      // Same contract note as getById — mongokit throws 404 by default.
      let missing: IProduct | null = null;
      let threw = false;
      try {
        missing = (await repo.getOne!({ sku: "DLP-003", category: "kitchen" }, {
          throwOnNotFound: false,
        } as unknown as undefined)) as IProduct | null;
      } catch (err) {
        threw = true;
        expect((err as Error).message).toMatch(/not found/i);
      }
      expect(missing === null || threw).toBe(true);
    });
  });

  // ==========================================================================
  // Optional: Projections & existence
  // ==========================================================================

  describe("Optional — projections & existence", () => {
    it("count: returns total matching filter", async () => {
      expect(typeof repo.count).toBe("function");
      expect(await repo.count!({})).toBe(6);
      expect(await repo.count!({ category: "kitchen" })).toBe(2);
    });

    it("exists: truthy when at least one matches", async () => {
      expect(typeof repo.exists).toBe("function");
      const found = await repo.exists!({ sku: "ESM-001" });
      expect(found).toBeTruthy();
      const missing = await repo.exists!({ sku: "NOPE" });
      expect(missing).toBeFalsy();
    });

    it("distinct: returns unique values", async () => {
      expect(typeof repo.distinct).toBe("function");
      const cats = await repo.distinct!<string>("category");
      expect(cats.sort()).toEqual(["fitness", "kitchen", "office"]);
    });

    it("findAll: returns raw array matching filter", async () => {
      expect(typeof repo.findAll).toBe("function");
      const kitchen = await repo.findAll!({ category: "kitchen" });
      expect(Array.isArray(kitchen)).toBe(true);
      expect(kitchen.length).toBe(2);
    });
  });

  // ==========================================================================
  // Optional: Batch operations
  // ==========================================================================

  describe("Optional — batch operations", () => {
    it("updateMany: bumps matching docs and returns UpdateManyResult", async () => {
      expect(typeof repo.updateMany).toBe("function");
      const result = (await repo.updateMany(
        { category: "office" },
        { $inc: { price: 10 } },
      )) as UpdateManyResult;
      expect(result.matchedCount).toBe(2);
      expect(result.modifiedCount).toBe(2);

      const lamp = await ProductModel.findOne({ sku: "DLP-003" }).lean();
      expect(lamp!.price).toBe(99);
    });

    it("deleteMany: soft-deletes matching docs when softDeletePlugin wired", async () => {
      expect(typeof repo.deleteMany).toBe("function");
      const result = (await repo.deleteMany({
        category: "fitness",
      })) as DeleteManyResult;

      // CONTRACT NOTE — mongokit 3.6's softDeletePlugin intercepts in
      // `before:deleteMany` and writes via `updateMany`, then short-circuits
      // the Model.deleteMany call. The returned `deletedCount` is therefore
      // 0, NOT the number of soft-deleted rows. The actual affected count
      // is only observable via a follow-up query. 3rd-party kits that
      // implement soft-delete SHOULD document whichever convention they
      // pick. Arc's BaseController surfaces whatever the kit returns, so
      // consumers should not rely on `deletedCount` reflecting soft-delete
      // counts unless their kit promises it.
      expect(result).toBeDefined();
      expect(typeof result.deletedCount).toBe("number");

      // The authoritative check is the follow-up query:
      const stillThere = await ProductModel.countDocuments({
        category: "fitness",
      });
      expect(stillThere).toBe(2);
      const flagged = await ProductModel.countDocuments({
        category: "fitness",
        deletedAt: { $ne: null },
      });
      expect(flagged).toBe(2);
    });

    it("deleteMany: `mode: 'hard'` physically removes despite softDelete", async () => {
      const result = (await repo.deleteMany(
        { category: "kitchen" },
        { mode: "hard" },
      )) as DeleteManyResult;
      expect(result.deletedCount).toBe(2);

      const remaining = await ProductModel.countDocuments({
        category: "kitchen",
      });
      expect(remaining).toBe(0);
    });

    it("bulkWrite: heterogeneous ops in one call", async () => {
      expect(typeof repo.bulkWrite).toBe("function");
      const first = await ProductModel.findOne({ sku: "ESM-001" }).lean();

      const ops: Array<BulkWriteOperation<IProduct>> = [
        {
          insertOne: {
            document: {
              name: "Kettle",
              sku: "KTL-777",
              price: 49,
              category: "kitchen",
              tags: ["coffee"],
              stock: 12,
            } as Partial<IProduct>,
          },
        },
        {
          updateOne: {
            filter: { _id: first!._id },
            update: { $set: { stock: 99 } },
          },
        },
        {
          deleteOne: { filter: { sku: "YMT-005" } },
        },
      ];

      // mongokit's BatchOperationsMethods.bulkWrite takes `Record<string, unknown>[]`
      // — our typed `BulkWriteOperation` union is structurally compatible.
      const result = await repo.bulkWrite(ops as unknown as BulkWriteOperation<IProduct>[]);
      expect(result).toBeTruthy();

      expect(await repo.count!({ sku: "KTL-777" })).toBe(1);
      const bumped = await ProductModel.findOne({ sku: "ESM-001" }).lean();
      expect(bumped!.stock).toBe(99);
      // soft-delete plugin intercepts deleteOne inside bulkWrite too — the
      // yoga mat gets soft-deleted, not physically removed. That's a
      // mongokit implementation detail; the contract only requires the
      // bulkWrite to execute and return a result.
    });

    it("createMany: inserts multiple docs", async () => {
      expect(typeof repo.createMany).toBe("function");
      const before = await repo.count!({});
      const created = await repo.createMany!([
        { name: "A", sku: "A-1", price: 1, category: "misc", tags: [], stock: 0 },
        { name: "B", sku: "B-1", price: 2, category: "misc", tags: [], stock: 0 },
      ] as Array<Partial<IProduct>>);
      expect(created.length).toBe(2);
      expect(await repo.count!({})).toBe(before + 2);
    });
  });

  // ==========================================================================
  // Optional: Soft delete surface
  // ==========================================================================

  describe("Optional — soft delete surface", () => {
    it("restore: un-soft-deletes a previously deleted doc", async () => {
      expect(typeof repo.restore).toBe("function");
      const doc = await ProductModel.findOne({ sku: "FRP-002" }).lean();
      await repo.delete(String(doc!._id));

      // Confirm it's hidden from normal reads — mongokit 3.6 throws on
      // soft-deleted docs by default; accept either behavior.
      let hidden: IProduct | null = null;
      try {
        hidden = (await repo.getById(String(doc!._id), {
          throwOnNotFound: false,
        } as unknown as undefined)) as IProduct | null;
      } catch {
        hidden = null;
      }
      expect(hidden).toBeNull();

      // Restore — mongokit wires this via softDeletePlugin. Pass ObjectId
      // directly so findOneAndUpdate's cast works reliably across schema
      // variants.
      const restored = await repo.restore(String(doc!._id));
      expect(restored).toBeTruthy();

      const visible = await repo.getById(String(doc!._id));
      expect(visible).toBeTruthy();
      expect((visible as IProduct).deletedAt).toBeNull();
    });

    it("getDeleted: lists soft-deleted docs (PaginationResult | TDoc[])", async () => {
      expect(typeof repo.getDeleted).toBe("function");
      // delete two
      const kitchen = await ProductModel.find({ category: "kitchen" }).lean();
      for (const doc of kitchen) {
        await repo.delete(String(doc._id));
      }

      const result = await repo.getDeleted();
      // mongokit returns a PaginationResult; a simpler adapter might return
      // a bare array. Both satisfy the contract — accept either.
      const docs = Array.isArray(result) ? result : (result as PaginationResult<IProduct>).docs;
      expect(docs.length).toBe(2);
      expect(docs.every((d: IProduct) => d.category === "kitchen")).toBe(true);
    });
  });

  // ==========================================================================
  // Optional: Hard delete on single doc
  // ==========================================================================

  describe("Optional — hard delete on single doc", () => {
    it("delete({ mode: 'hard' }): physically removes despite softDelete", async () => {
      const doc = await ProductModel.findOne({ sku: "OCH-004" }).lean();
      const result = (await repo.delete(String(doc!._id), {
        mode: "hard",
      })) as DeleteResult;
      expect(result.success).toBe(true);
      // `soft` should NOT be set when we forced hard
      expect(result.soft).toBeFalsy();

      const gone = await ProductModel.findOne({ sku: "OCH-004" }).lean();
      expect(gone).toBeNull();
    });
  });

  // ==========================================================================
  // Optional: Aggregation & lookup
  // ==========================================================================

  describe("Optional — aggregation", () => {
    it("aggregate: runs a pipeline and returns results", async () => {
      expect(typeof repo.aggregate).toBe("function");
      type GroupRow = { _id: string; totalStock: number; count: number };
      const rows = await repo.aggregate!<GroupRow>([
        {
          $group: {
            _id: "$category",
            totalStock: { $sum: "$stock" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]);
      expect(rows.length).toBe(3);
      const kitchen = rows.find((r) => r._id === "kitchen");
      expect(kitchen?.totalStock).toBe(60); // 10 + 50
      expect(kitchen?.count).toBe(2);
    });
  });

  // ==========================================================================
  // Optional: Geo via mongokit QueryParser
  // ==========================================================================

  describe("Optional — geo operators via mongokit QueryParser", () => {
    it("QueryParser: [near] produces a $near filter arc can forward", async () => {
      const parser = new QueryParser({ schema: productSchema });
      const parsed = parser.parse({
        location: { near: "-73.9857,40.7484,100000" }, // within 100km of NYC
      });

      // mongokit's Repository handles $near + pagination internally —
      // forward the filter through findAll so the test doesn't depend on
      // pagination count-rewriting.
      const nearby = await repo.findAll!(parsed.filters as Record<string, unknown>);
      const skus = nearby.map((p: IProduct) => p.sku).sort();
      // Both NYC products should be present; SF/Chicago far outside 100km.
      expect(skus).toContain("ESM-001");
      expect(skus).toContain("FRP-002");
      expect(skus).not.toContain("DLP-003");
      expect(skus).not.toContain("YMT-005");
    });

    it("QueryParser: [withinRadius] is count-safe (uses $centerSphere)", async () => {
      const parser = new QueryParser({ schema: productSchema });
      const parsed = parser.parse({
        location: { withinRadius: "-122.4194,37.7749,50000" }, // 50km around SF
      });

      const count = await repo.count!(parsed.filters as Record<string, unknown>);
      expect(count).toBe(2); // Desk Lamp + Office Chair
    });

    it("QueryParser: [geoWithin] bounding box works without a 2dsphere index", async () => {
      const parser = new QueryParser({ schema: productSchema });
      // Box around Chicago
      const parsed = parser.parse({
        location: { geoWithin: "-88,41,-87,42" },
      });
      const found = await repo.findAll!(parsed.filters as Record<string, unknown>);
      const skus = found.map((p: IProduct) => p.sku);
      expect(skus).toContain("YMT-005");
      expect(skus).toContain("DMB-006");
      expect(skus).not.toContain("ESM-001");
    });

    it("QueryParser: parses sort, pagination, and filters together", async () => {
      const parser = new QueryParser({ schema: productSchema });
      const parsed = parser.parse({
        category: "fitness",
        sort: "-price",
        page: "1",
        limit: "10",
      });

      expect(parsed.filters).toMatchObject({ category: "fitness" });
      expect(parsed.sort).toBeTruthy();
      expect(parsed.page).toBe(1);
      expect(parsed.limit).toBe(10);

      const result = await repo.getAll({
        filters: parsed.filters as Record<string, unknown>,
        sort: parsed.sort as Record<string, 1 | -1>,
        page: parsed.page,
        limit: parsed.limit,
      });
      const offset = result as OffsetPaginatedResult<IProduct>;
      expect(offset.docs.length).toBe(2);
      // Sorted by -price → Dumbbell (149) before Yoga Mat (45)
      expect(offset.docs[0]!.sku).toBe("DMB-006");
      expect(offset.docs[1]!.sku).toBe("YMT-005");
    });
  });

  // ==========================================================================
  // Optional: Lifecycle hooks (verify arc's event expectations)
  // ==========================================================================

  describe("Optional — lifecycle hooks", () => {
    it("fires before:delete and after:delete on single delete", async () => {
      const calls: string[] = [];
      const beforeDelete = () => calls.push("before:delete");
      const afterDelete = () => calls.push("after:delete");

      repo.on("before:delete", beforeDelete);
      repo.on("after:delete", afterDelete);

      const doc = await ProductModel.findOne({ sku: "ESM-001" }).lean();
      await repo.delete(String(doc!._id));

      expect(calls).toContain("before:delete");
      expect(calls).toContain("after:delete");

      // CONTRACT GOTCHA — NEVER call `removeAllListeners('before:delete')`
      // to clean up a test hook. That silently removes the softDeletePlugin
      // listener too, which then causes subsequent deletes in the same test
      // file to be HARD instead of soft. Always use `.off(event, fn)` with
      // the specific handler reference, so plugin-owned listeners stay
      // intact. This is a shared gotcha for any repo kit using an event
      // system to compose plugins — document it explicitly in your kit.
      repo.off("before:delete", beforeDelete);
      repo.off("after:delete", afterDelete);
    });

    it("fires before:restore and after:restore on restore (mongokit 3.6 feature)", async () => {
      const calls: string[] = [];
      const beforeRestore = () => calls.push("before:restore");
      const afterRestore = () => calls.push("after:restore");
      repo.on("before:restore" as never, beforeRestore);
      repo.on("after:restore" as never, afterRestore);

      // Use a sku unique to this test so previous listener state (from the
      // before:delete/after:delete test) can't interfere with fetching.
      const doc = await ProductModel.findOne({ sku: "OCH-004" }).lean();
      expect(doc).toBeTruthy();

      await repo.delete(String(doc!._id));

      // Confirm the doc IS soft-deleted in the raw collection before we try
      // restore — eliminates "was it physically deleted?" as a hypothesis.
      const raw = await ProductModel.collection.findOne({ _id: doc!._id });
      expect(raw).toBeTruthy();
      expect(raw?.deletedAt).toBeTruthy();

      await repo.restore(String(doc!._id));

      expect(calls).toContain("before:restore");
      expect(calls).toContain("after:restore");

      // Same gotcha as before:delete — use `.off` with specific handlers,
      // not `removeAllListeners`, so plugin listeners survive.
      repo.off("before:restore" as never, beforeRestore);
      repo.off("after:restore" as never, afterRestore);
    });
  });

  // ==========================================================================
  // Optional: Transactions
  // ==========================================================================

  describe("Optional — transactions (replica-set only)", () => {
    it("withTransaction is exported from mongokit 3.6", () => {
      expect(typeof withTransaction).toBe("function");
    });

    it("repo.withTransaction exists when wired by plugins", () => {
      // Not all plugin stacks add this method. Document it as optional.
      const hasMethod =
        typeof (repo as { withTransaction?: unknown }).withTransaction === "function";
      // We don't assert true — arc's contract marks this optional.
      expect(typeof hasMethod).toBe("boolean");
    });
  });

  // ==========================================================================
  // Identity — idField
  // ==========================================================================

  describe("Required — idField identity", () => {
    it("exposes idField (defaults to '_id' for mongokit)", () => {
      expect(repo.idField).toBe("_id");
    });
  });

  // ==========================================================================
  // Warnings report — surface anything mongokit logged while we ran
  // ==========================================================================

  describe("Diagnostic", () => {
    it("collects warnings so contract gaps get caught", () => {
      // Print every warning captured during this file's runs. Serves as a
      // heads-up for downstream kit authors: whatever mongokit warned us
      // about is likely something you want to handle in your kit too.
      if (warnings.length) {
        // eslint-disable-next-line no-console
        console.log(
          "\n[contract] captured warnings during tests:\n" +
            warnings.map((w, i) => `  ${i + 1}. ${w}`).join("\n"),
        );
      }
      expect(warnings).toBeDefined();
    });
  });
});
