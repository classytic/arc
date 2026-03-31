/**
 * Bulk Preset + MongoKit E2E Tests
 *
 * Tests bulkCreate/bulkUpdate/bulkDelete through BaseController
 * with a real MongoKit Repository + MongoDB Memory Server.
 * Uses isolated mongoose connection to avoid parallel test interference.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, type Types, type Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

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

describe('Bulk Preset + MongoKit E2E', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    // Isolated connection — does NOT interfere with other test files
    connection = mongoose.createConnection(mongoServer.getUri('bulk-e2e'));
    await connection.asPromise();

    const schema = new Schema<IProduct>({
      name: { type: String, required: true },
      price: { type: Number, required: true },
      status: { type: String, default: 'active' },
      deletedAt: { type: Date, default: null },
    });

    ProductModel = connection.model<IProduct>('BulkProduct', schema);
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
    const { Repository, methodRegistryPlugin, batchOperationsPlugin } = await import('@classytic/mongokit');
    const { BaseController } = await import('../../src/core/BaseController.js');
    const { HookSystem } = await import('../../src/hooks/HookSystem.js');

    const repo = new Repository(ProductModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
    ]);

    const controller = new BaseController(repo, { resourceName: 'product' });
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

  describe('bulkCreate with MongoKit', () => {
    it('creates multiple documents in one call', async () => {
      const { controller, makeCtx } = await createBulkController();

      const result = await controller.bulkCreate(makeCtx({
        items: [
          { name: 'Widget', price: 10, status: 'active' },
          { name: 'Gadget', price: 20, status: 'active' },
          { name: 'Doohickey', price: 30, status: 'draft' },
        ],
      }));

      expect(result.success).toBe(true);
      expect(result.status).toBe(201);
      expect(result.data).toHaveLength(3);
      expect(result.meta).toEqual({ count: 3 });

      const dbCount = await ProductModel.countDocuments();
      expect(dbCount).toBe(3);
    });

    it('fails validation for invalid documents', async () => {
      const { controller, makeCtx } = await createBulkController();

      await expect(
        controller.bulkCreate(makeCtx({ items: [{ price: 10 }] })),
      ).rejects.toThrow();

      const dbCount = await ProductModel.countDocuments();
      expect(dbCount).toBe(0);
    });
  });

  // ==========================================================================
  // bulkUpdate
  // ==========================================================================

  describe('bulkUpdate with MongoKit', () => {
    it('updates multiple documents matching filter', async () => {
      await ProductModel.create([
        { name: 'A', price: 10, status: 'draft' },
        { name: 'B', price: 20, status: 'draft' },
        { name: 'C', price: 30, status: 'published' },
      ]);

      const { controller, makeCtx } = await createBulkController();

      const result = await controller.bulkUpdate(makeCtx({
        filter: { status: 'draft' },
        data: { $set: { status: 'published' } },
      }));

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.objectContaining({
        matchedCount: 2,
        modifiedCount: 2,
      }));

      const drafts = await ProductModel.countDocuments({ status: 'draft' });
      expect(drafts).toBe(0);
    });

    it('supports $inc operator', async () => {
      await ProductModel.create([
        { name: 'A', price: 10, status: 'active' },
        { name: 'B', price: 20, status: 'active' },
      ]);

      const { controller, makeCtx } = await createBulkController();

      await controller.bulkUpdate(makeCtx({
        filter: { status: 'active' },
        data: { $inc: { price: 5 } },
      }));

      const docs = await ProductModel.find({}).sort('name').lean();
      expect(docs[0].price).toBe(15);
      expect(docs[1].price).toBe(25);
    });
  });

  // ==========================================================================
  // bulkDelete
  // ==========================================================================

  describe('bulkDelete with MongoKit', () => {
    it('deletes multiple documents matching filter', async () => {
      await ProductModel.create([
        { name: 'Keep', price: 10, status: 'active' },
        { name: 'Delete1', price: 20, status: 'archived' },
        { name: 'Delete2', price: 30, status: 'archived' },
      ]);

      const { controller, makeCtx } = await createBulkController();

      const result = await controller.bulkDelete(makeCtx({ filter: { status: 'archived' } }));

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.objectContaining({ deletedCount: 2 }));

      const remaining = await ProductModel.find({}).lean();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('Keep');
    });
  });

  // ==========================================================================
  // Soft-delete batch ops (MongoKit v3.4+)
  // ==========================================================================

  describe('soft-delete batch ops (MongoKit v3.4)', () => {
    async function createSoftDeleteController() {
      const { Repository, methodRegistryPlugin, batchOperationsPlugin, softDeletePlugin } = await import('@classytic/mongokit');
      const { BaseController } = await import('../../src/core/BaseController.js');
      const { HookSystem } = await import('../../src/hooks/HookSystem.js');

      const repo = new Repository(ProductModel, [
        methodRegistryPlugin(),
        batchOperationsPlugin(),
        softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
      ]);

      const controller = new BaseController(repo, { resourceName: 'product' });
      const hooks = new HookSystem();

      return {
        controller,
        makeCtx: (body: unknown) => ({
          params: {}, query: {}, body, headers: {},
          metadata: { arc: { hooks } },
        }),
      };
    }

    it('bulkDelete soft-deletes when softDeletePlugin is active', async () => {
      await ProductModel.create([
        { name: 'A', price: 10, status: 'old' },
        { name: 'B', price: 20, status: 'old' },
        { name: 'C', price: 30, status: 'active' },
      ]);

      const { controller, makeCtx } = await createSoftDeleteController();

      await controller.bulkDelete(makeCtx({ filter: { status: 'old' } }));

      // Documents should still exist (soft-deleted)
      const allDocs = await ProductModel.find({}).lean();
      expect(allDocs).toHaveLength(3);

      const softDeleted = allDocs.filter(d => d.deletedAt !== null);
      expect(softDeleted).toHaveLength(2);
    });

    it('bulkUpdate skips soft-deleted documents', async () => {
      await ProductModel.create([
        { name: 'Active', price: 10, status: 'draft', deletedAt: null },
        { name: 'Deleted', price: 20, status: 'draft', deletedAt: new Date() },
      ]);

      const { controller, makeCtx } = await createSoftDeleteController();

      const result = await controller.bulkUpdate(makeCtx({
        filter: { status: 'draft' },
        data: { $set: { status: 'published' } },
      }));

      expect(result.data).toEqual(expect.objectContaining({ matchedCount: 1, modifiedCount: 1 }));

      const deletedDoc = await ProductModel.findOne({ name: 'Deleted' }).lean();
      expect(deletedDoc!.status).toBe('draft');
    });
  });
});
