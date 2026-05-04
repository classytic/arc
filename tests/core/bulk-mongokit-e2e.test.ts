/**
 * Bulk Preset + MongoKit E2E Tests
 *
 * Tests bulkCreate/bulkUpdate/bulkDelete through BaseController
 * with a real MongoKit Repository + MongoDB Memory Server.
 * Uses isolated mongoose connection to avoid parallel test interference.
 */

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Connection, Schema, type Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  price: number;
  status: string;
  deletedAt?: Date | null;
}

let mongoServer: MongoMemoryServer;
let connection: Connection;
let ProductModel: mongoose.Model<IProduct>;

describe("Bulk Preset + MongoKit E2E", () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    // Isolated connection — does NOT interfere with other test files
    connection = mongoose.createConnection(mongoServer.getUri("bulk-e2e"));
    await connection.asPromise();

    const schema = new Schema<IProduct>({
      name: { type: String, required: true },
      price: { type: Number, required: true },
      status: { type: String, default: "active" },
      deletedAt: { type: Date, default: null },
    });

    ProductModel = connection.model<IProduct>("BulkProduct", schema);
  });

  afterAll(async () => {
    await connection.close();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
  });

  // ==========================================================================
  // Helper
  // ==========================================================================

  async function createBulkController() {
    const { Repository, methodRegistryPlugin, batchOperationsPlugin } = await import(
      "@classytic/mongokit"
    );
    const { BaseController } = await import("../../src/core/BaseController.js");
    const { HookSystem } = await import("../../src/hooks/HookSystem.js");

    const repo = new Repository(ProductModel, [methodRegistryPlugin(), batchOperationsPlugin()]);

    const controller = new BaseController(repo, { resourceName: "product" });
    const hooks = new HookSystem();

    const makeCtx = (body: unknown) => ({
      params: {},
      query: {},
      body,
      headers: {},
      metadata: { arc: { hooks } },
    });

    return { controller, makeCtx };
  }

  // ==========================================================================
  // bulkCreate
  // ==========================================================================

  describe("bulkCreate with MongoKit", () => {
    it("creates multiple documents in one call", async () => {
      const { controller, makeCtx } = await createBulkController();

      const result = await controller.bulkCreate(
        makeCtx({
          items: [
            { name: "Widget", price: 10, status: "active" },
            { name: "Gadget", price: 20, status: "active" },
            { name: "Doohickey", price: 30, status: "draft" },
          ],
        }),
      );

      expect(result.status).toBe(201);
      expect(result.data).toHaveLength(3);
      expect(result.meta).toEqual(
        expect.objectContaining({ count: 3, requested: 3, inserted: 3, skipped: 0 }),
      );

      const dbCount = await ProductModel.countDocuments();
      expect(dbCount).toBe(3);
    });

    it("all invalid → 422 with reason: all_invalid", async () => {
      const { controller, makeCtx } = await createBulkController();

      // MongoKit 3.4.5+: ordered=false, invalid docs skipped (no throw).
      // Arc reports this as 422 partial-success with reason='all_invalid' so
      // callers can distinguish "nothing inserted, your fault" from server errors.
      const result = await controller.bulkCreate(makeCtx({ items: [{ price: 10 }] }));
      expect(result.status).toBe(422);
      expect(result.data).toHaveLength(0);
      expect(result.meta).toEqual(
        expect.objectContaining({
          requested: 1,
          inserted: 0,
          skipped: 1,
          partial: true,
          reason: "all_invalid",
        }),
      );

      const dbCount = await ProductModel.countDocuments();
      expect(dbCount).toBe(0);
    });

    it("partial valid → 207 Multi-Status with reason: some_invalid", async () => {
      const { controller, makeCtx } = await createBulkController();

      // 2 valid + 1 invalid (missing required `name`)
      const result = await controller.bulkCreate(
        makeCtx({
          items: [
            { name: "Valid1", price: 10 },
            { price: 20 }, // missing name
            { name: "Valid2", price: 30 },
          ],
        }),
      );

      expect(result.status).toBe(207);
      expect(result.data).toHaveLength(2);
      expect(result.meta).toEqual(
        expect.objectContaining({
          requested: 3,
          inserted: 2,
          skipped: 1,
          partial: true,
          reason: "some_invalid",
        }),
      );
    });

    it("strips system-managed and protected fields from each item (security)", async () => {
      const { Repository, methodRegistryPlugin, batchOperationsPlugin } = await import(
        "@classytic/mongokit"
      );
      const { BaseController } = await import("../../src/core/BaseController.js");
      const { HookSystem } = await import("../../src/hooks/HookSystem.js");

      const repo = new Repository(ProductModel, [methodRegistryPlugin(), batchOperationsPlugin()]);
      // Resource has fieldRules marking `status` as systemManaged and a custom
      // `internalScore` field as readonly. Both must be stripped from bulk input.
      const controller = new BaseController(repo, {
        resourceName: "product",
        schemaOptions: {
          fieldRules: {
            status: { systemManaged: true } as { systemManaged: boolean },
            internalScore: { readonly: true } as { readonly: boolean },
          },
        },
      });
      const hooks = new HookSystem();
      const makeCtx = (body: unknown) => ({
        params: {},
        query: {},
        body,
        headers: {},
        metadata: { arc: { hooks } },
      });

      // Attacker tries to set a protected field via bulk create
      const result = await controller.bulkCreate(
        makeCtx({
          items: [
            // biome-ignore lint: test
            { name: "Sneaky", price: 10, status: "vip", internalScore: 999 } as any,
          ],
        }),
      );

      const inserted = await ProductModel.findOne({ name: "Sneaky" }).lean();
      expect(inserted).toBeTruthy();
      // status should fall back to schema default (`active`), NOT `vip`
      expect(inserted?.status).toBe("active");
      // internalScore is not in the schema, so it shouldn't appear at all
      expect((inserted as Record<string, unknown>).internalScore).toBeUndefined();
    });
  });

  // ==========================================================================
  // bulkUpdate
  // ==========================================================================

  describe("bulkUpdate with MongoKit", () => {
    it("updates multiple documents matching filter", async () => {
      await ProductModel.create([
        { name: "A", price: 10, status: "draft" },
        { name: "B", price: 20, status: "draft" },
        { name: "C", price: 30, status: "published" },
      ]);

      const { controller, makeCtx } = await createBulkController();

      const result = await controller.bulkUpdate(
        makeCtx({
          filter: { status: "draft" },
          data: { $set: { status: "published" } },
        }),
      );

      expect(result.data).toEqual(
        expect.objectContaining({
          matchedCount: 2,
          modifiedCount: 2,
        }),
      );

      const drafts = await ProductModel.countDocuments({ status: "draft" });
      expect(drafts).toBe(0);
    });

    it("supports $inc operator", async () => {
      await ProductModel.create([
        { name: "A", price: 10, status: "active" },
        { name: "B", price: 20, status: "active" },
      ]);

      const { controller, makeCtx } = await createBulkController();

      await controller.bulkUpdate(
        makeCtx({
          filter: { status: "active" },
          data: { $inc: { price: 5 } },
        }),
      );

      const data = await ProductModel.find({}).sort("name").lean();
      expect(data[0].price).toBe(15);
      expect(data[1].price).toBe(25);
    });

    it("strips protected fields from flat update payload (security)", async () => {
      const { Repository, methodRegistryPlugin, batchOperationsPlugin } = await import(
        "@classytic/mongokit"
      );
      const { BaseController } = await import("../../src/core/BaseController.js");
      const { HookSystem } = await import("../../src/hooks/HookSystem.js");

      await ProductModel.create({ name: "Target", price: 10, status: "draft" });

      const repo = new Repository(ProductModel, [methodRegistryPlugin(), batchOperationsPlugin()]);
      const controller = new BaseController(repo, {
        resourceName: "product",
        schemaOptions: {
          fieldRules: {
            // biome-ignore lint: test
            status: { systemManaged: true } as any,
          },
        },
      });
      const hooks = new HookSystem();
      const makeCtx = (body: unknown) => ({
        params: {},
        query: {},
        body,
        headers: {},
        metadata: { arc: { hooks } },
      });

      // Attacker tries to flip status from draft → published via bulk update
      const result = await controller.bulkUpdate(
        makeCtx({
          filter: { name: "Target" },
          // biome-ignore lint: test
          data: { price: 99, status: "published" } as any,
        }),
      );

      // `status` should have been stripped — meta.stripped reports it
      expect((result.meta as Record<string, unknown>)?.stripped).toEqual(["status"]);

      const doc = await ProductModel.findOne({ name: "Target" }).lean();
      expect(doc?.price).toBe(99); // legitimate field updated
      expect(doc?.status).toBe("draft"); // protected field unchanged
    });

    it("strips protected fields from $set operator payload (security)", async () => {
      const { Repository, methodRegistryPlugin, batchOperationsPlugin } = await import(
        "@classytic/mongokit"
      );
      const { BaseController } = await import("../../src/core/BaseController.js");
      const { HookSystem } = await import("../../src/hooks/HookSystem.js");

      await ProductModel.create([
        { name: "T1", price: 10, status: "draft" },
        { name: "T2", price: 20, status: "draft" },
      ]);

      const repo = new Repository(ProductModel, [methodRegistryPlugin(), batchOperationsPlugin()]);
      const controller = new BaseController(repo, {
        resourceName: "product",
        schemaOptions: {
          fieldRules: {
            // biome-ignore lint: test
            status: { systemManaged: true } as any,
          },
        },
      });
      const hooks = new HookSystem();
      const makeCtx = (body: unknown) => ({
        params: {},
        query: {},
        body,
        headers: {},
        metadata: { arc: { hooks } },
      });

      // Operator-shape payload: $set should be sanitized too.
      // ($set and $inc must target different fields per Mongo rules.)
      const result = await controller.bulkUpdate(
        makeCtx({
          filter: { status: "draft" },
          // biome-ignore lint: test
          data: { $set: { name: "Renamed", status: "published" } } as any,
        }),
      );

      expect((result.meta as Record<string, unknown>)?.stripped).toContain("status");

      const data = await ProductModel.find({}).sort("name").lean();
      // $set name applied, status untouched
      expect(data.every((d) => d.status === "draft")).toBe(true);
      expect(data.every((d) => d.name === "Renamed")).toBe(true);
    });

    it("rejects bulkUpdate when ALL fields are protected (400 ALL_FIELDS_STRIPPED)", async () => {
      const { Repository, methodRegistryPlugin, batchOperationsPlugin } = await import(
        "@classytic/mongokit"
      );
      const { BaseController } = await import("../../src/core/BaseController.js");
      const { HookSystem } = await import("../../src/hooks/HookSystem.js");

      const repo = new Repository(ProductModel, [methodRegistryPlugin(), batchOperationsPlugin()]);
      const controller = new BaseController(repo, {
        resourceName: "product",
        schemaOptions: {
          fieldRules: {
            // biome-ignore lint: test
            status: { systemManaged: true } as any,
          },
        },
      });
      const hooks = new HookSystem();
      const makeCtx = (body: unknown) => ({
        params: {},
        query: {},
        body,
        headers: {},
        metadata: { arc: { hooks } },
      });

      await expect(
        controller.bulkUpdate(
          makeCtx({
            filter: { name: "anything" },
            // biome-ignore lint: test
            data: { status: "published" } as any,
          }),
        ),
      ).rejects.toMatchObject({
        status: 400,
        details: { code: "ALL_FIELDS_STRIPPED", stripped: ["status"] },
      });
    });
  });

  // ==========================================================================
  // bulkDelete
  // ==========================================================================

  describe("bulkDelete with MongoKit", () => {
    it("deletes multiple documents matching filter", async () => {
      await ProductModel.create([
        { name: "Keep", price: 10, status: "active" },
        { name: "Delete1", price: 20, status: "archived" },
        { name: "Delete2", price: 30, status: "archived" },
      ]);

      const { controller, makeCtx } = await createBulkController();

      const result = await controller.bulkDelete(makeCtx({ filter: { status: "archived" } }));

      expect(result.data).toEqual(expect.objectContaining({ deletedCount: 2 }));

      const remaining = await ProductModel.find({}).lean();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe("Keep");
    });

    // ========================================================================
    // bulkDelete `ids[]` form — industry standard "delete by selection" pattern
    //
    // Real-world scenario: admin UI shows a checkbox grid, user selects 3
    // products and clicks "Delete Selected". Frontend POSTs the selected ids.
    // No need to construct Mongo filters client-side.
    // ========================================================================

    it("ids[] form: deletes specific documents by _id (real MongoKit deleteMany)", async () => {
      const data = await ProductModel.create([
        { name: "A", price: 10, status: "active" },
        { name: "B", price: 20, status: "active" },
        { name: "C", price: 30, status: "active" },
        { name: "D", price: 40, status: "active" },
      ]);
      // Pick 2 of 4 to delete — typical "delete selected rows" UI pattern
      const idsToDelete = [String(data[0]._id), String(data[2]._id)];

      const { controller, makeCtx } = await createBulkController();

      const result = await controller.bulkDelete(makeCtx({ ids: idsToDelete }));

      expect(result.data).toEqual(expect.objectContaining({ deletedCount: 2 }));

      const remaining = await ProductModel.find({}).sort("name").lean();
      expect(remaining.map((d) => d.name)).toEqual(["B", "D"]);
    });

    it("ids[] form: nonexistent ids return deletedCount: 0 (no error, idempotent)", async () => {
      await ProductModel.create({ name: "Real", price: 10, status: "active" });

      const { controller, makeCtx } = await createBulkController();

      // Valid ObjectId strings that don't match any doc
      const result = await controller.bulkDelete(
        makeCtx({
          ids: ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"],
        }),
      );

      expect(result.data).toEqual(expect.objectContaining({ deletedCount: 0 }));
      expect(await ProductModel.countDocuments()).toBe(1);
    });

    it("ids[] form: partial match — deletes only the ids that exist", async () => {
      const data = await ProductModel.create([
        { name: "Real1", price: 10, status: "active" },
        { name: "Real2", price: 20, status: "active" },
      ]);

      const { controller, makeCtx } = await createBulkController();

      // Mix of real and fake ids — real-world race condition (doc deleted by
      // another request between selection and submit). Should silently skip.
      const result = await controller.bulkDelete(
        makeCtx({
          ids: [String(data[0]._id), "507f1f77bcf86cd799439099", String(data[1]._id)],
        }),
      );

      expect(result.data).toEqual(expect.objectContaining({ deletedCount: 2 }));
      expect(await ProductModel.countDocuments()).toBe(0);
    });

    it("ids[] form: empty array → 400 (don't accidentally delete everything)", async () => {
      await ProductModel.create([{ name: "Safe", price: 10, status: "active" }]);

      const { controller, makeCtx } = await createBulkController();

      await expect(controller.bulkDelete(makeCtx({ ids: [] }))).rejects.toMatchObject({
        status: 400,
      });
      // Crucial: nothing deleted
      expect(await ProductModel.countDocuments()).toBe(1);
    });

    it("ids[] form: mutually exclusive with filter → 400 (avoid ambiguity)", async () => {
      await ProductModel.create({ name: "Safe", price: 10, status: "active" });

      const { controller, makeCtx } = await createBulkController();

      await expect(
        controller.bulkDelete(
          makeCtx({
            ids: ["507f1f77bcf86cd799439011"],
            filter: { status: "active" },
          }),
        ),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("either"),
      });
      // Crucial: nothing deleted (filter would have matched)
      expect(await ProductModel.countDocuments()).toBe(1);
    });

    it("ids[] form: large batch (500 ids) — single deleteMany call", async () => {
      // Industry-standard scenario: "purge old logs" — bulk delete a large set
      const data = await ProductModel.insertMany(
        Array.from({ length: 500 }, (_, i) => ({
          name: `Log${i}`,
          price: i,
          status: "old",
        })),
      );
      // Add 10 we want to keep
      await ProductModel.insertMany(
        Array.from({ length: 10 }, (_, i) => ({
          name: `Keep${i}`,
          price: 1000 + i,
          status: "active",
        })),
      );

      const { controller, makeCtx } = await createBulkController();

      const ids = data.map((d) => String(d._id));
      const result = await controller.bulkDelete(makeCtx({ ids }));

      expect(result.data).toEqual(expect.objectContaining({ deletedCount: 500 }));
      expect(await ProductModel.countDocuments()).toBe(10);
    });
  });

  // ==========================================================================
  // bulkDelete `ids[]` with multi-tenancy — security-critical scenario
  //
  // The user supplies ids belonging to ANOTHER org. The controller MUST NOT
  // delete them, even though the ids are valid. Tenant scope from the request
  // is merged into the deleteMany filter, so cross-tenant ids silently no-op.
  // ==========================================================================

  describe("bulkDelete ids[] + multi-tenancy (cross-tenant isolation)", () => {
    interface IOrgProduct {
      _id: Types.ObjectId;
      name: string;
      organizationId: string;
    }
    let OrgProductModel: mongoose.Model<IOrgProduct>;

    beforeAll(() => {
      const schema = new Schema<IOrgProduct>({
        name: { type: String, required: true },
        organizationId: { type: String, required: true, index: true },
      });
      OrgProductModel = connection.model<IOrgProduct>("BulkOrgProduct", schema);
    });

    beforeEach(async () => {
      await OrgProductModel.deleteMany({});
    });

    async function createTenantController() {
      const { Repository, methodRegistryPlugin, batchOperationsPlugin } = await import(
        "@classytic/mongokit"
      );
      const { BaseController } = await import("../../src/core/BaseController.js");
      const { HookSystem } = await import("../../src/hooks/HookSystem.js");

      const repo = new Repository(OrgProductModel, [
        methodRegistryPlugin(),
        batchOperationsPlugin(),
      ]);
      const controller = new BaseController(repo, { resourceName: "product" });
      const hooks = new HookSystem();

      // Simulate a request scoped to org A (multi-tenant member scope).
      // _scope lives at metadata._scope (top-level), arc.hooks is nested.
      const makeCtxAsOrg = (orgId: string, body: unknown) => ({
        params: {},
        query: {},
        body,
        headers: {},
        metadata: {
          arc: { hooks },
          _scope: { kind: "member" as const, userId: "u1", organizationId: orgId, orgRoles: [] },
        },
      });

      return { controller, makeCtxAsOrg };
    }

    it("rejects cross-tenant ids — org A cannot delete org B's products via ids[]", async () => {
      const orgADocs = await OrgProductModel.create([
        { name: "A1", organizationId: "org-a" },
        { name: "A2", organizationId: "org-a" },
      ]);
      const orgBDocs = await OrgProductModel.create([
        { name: "B1", organizationId: "org-b" },
        { name: "B2", organizationId: "org-b" },
      ]);

      const { controller, makeCtxAsOrg } = await createTenantController();

      // Caller is in org A but maliciously passes BOTH org A and org B ids
      const allIds = [
        String(orgADocs[0]._id),
        String(orgADocs[1]._id),
        String(orgBDocs[0]._id),
        String(orgBDocs[1]._id),
      ];

      const result = await controller.bulkDelete(makeCtxAsOrg("org-a", { ids: allIds }));

      // Only org A's docs deleted (2), org B's untouched
      expect(result.data).toEqual(expect.objectContaining({ deletedCount: 2 }));

      const orgARemaining = await OrgProductModel.countDocuments({ organizationId: "org-a" });
      const orgBRemaining = await OrgProductModel.countDocuments({ organizationId: "org-b" });
      expect(orgARemaining).toBe(0);
      expect(orgBRemaining).toBe(2); // ← critical: cross-tenant data preserved
    });

    it("public scope on tenant-scoped resource → 403 (no anonymous bulk delete)", async () => {
      const { controller } = await createTenantController();

      const { HookSystem } = await import("../../src/hooks/HookSystem.js");
      const ctx = {
        params: {},
        query: {},
        body: { ids: ["507f1f77bcf86cd799439011"] },
        headers: {},
        metadata: {
          arc: { hooks: new HookSystem() },
          _scope: { kind: "public" as const },
        },
      };

      await expect(controller.bulkDelete(ctx)).rejects.toMatchObject({
        status: 403,
        details: { code: "ORG_CONTEXT_REQUIRED" },
      });
    });
  });

  // ==========================================================================
  // Soft-delete batch ops (MongoKit v3.4+)
  // ==========================================================================

  describe("soft-delete batch ops (MongoKit v3.4)", () => {
    async function createSoftDeleteController() {
      const { Repository, methodRegistryPlugin, batchOperationsPlugin, softDeletePlugin } =
        await import("@classytic/mongokit");
      const { BaseController } = await import("../../src/core/BaseController.js");
      const { HookSystem } = await import("../../src/hooks/HookSystem.js");

      const repo = new Repository(ProductModel, [
        methodRegistryPlugin(),
        batchOperationsPlugin(),
        softDeletePlugin({ deletedField: "deletedAt", filterMode: "null" }),
      ]);

      const controller = new BaseController(repo, { resourceName: "product" });
      const hooks = new HookSystem();

      return {
        controller,
        makeCtx: (body: unknown) => ({
          params: {},
          query: {},
          body,
          headers: {},
          metadata: { arc: { hooks } },
        }),
      };
    }

    it("bulkDelete soft-deletes when softDeletePlugin is active", async () => {
      await ProductModel.create([
        { name: "A", price: 10, status: "old" },
        { name: "B", price: 20, status: "old" },
        { name: "C", price: 30, status: "active" },
      ]);

      const { controller, makeCtx } = await createSoftDeleteController();

      await controller.bulkDelete(makeCtx({ filter: { status: "old" } }));

      // Documents should still exist (soft-deleted)
      const allDocs = await ProductModel.find({}).lean();
      expect(allDocs).toHaveLength(3);

      const softDeleted = allDocs.filter((d) => d.deletedAt !== null);
      expect(softDeleted).toHaveLength(2);
    });

    it("bulkUpdate skips soft-deleted documents", async () => {
      await ProductModel.create([
        { name: "Active", price: 10, status: "draft", deletedAt: null },
        { name: "Deleted", price: 20, status: "draft", deletedAt: new Date() },
      ]);

      const { controller, makeCtx } = await createSoftDeleteController();

      const result = await controller.bulkUpdate(
        makeCtx({
          filter: { status: "draft" },
          data: { $set: { status: "published" } },
        }),
      );

      expect(result.data).toEqual(expect.objectContaining({ matchedCount: 1, modifiedCount: 1 }));

      const deletedDoc = await ProductModel.findOne({ name: "Deleted" }).lean();
      expect(deletedDoc?.status).toBe("draft");
    });
  });
});
