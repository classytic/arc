/**
 * BaseController E2E Tests
 *
 * Tests CRUD operations, hook execution, and error handling.
 * Uses instance-scoped HookSystem (no global singleton).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseController } from '../../src/core/BaseController.js';
import { HookSystem } from '../../src/hooks/HookSystem.js';
import { createMockModel, createMockRepository, mockUser, mockContext, setupGlobalHooks } from '../setup.js';
import type { IRequestContext } from '../../src/types/index.js';

setupGlobalHooks();

/** Create a request context with instance-scoped hooks */
function createReq(
  hooks: HookSystem,
  overrides: Partial<IRequestContext> = {}
): IRequestContext {
  return {
    query: {},
    body: {},
    params: {},
    user: mockUser,
    headers: {},
    metadata: { arc: { hooks } },
    ...overrides,
  };
}

describe('BaseController', () => {
  let controller: BaseController;
  let repository: any;
  let Model: any;
  let hooks: HookSystem;

  beforeEach(() => {
    // Create fresh isolated hook system per test
    hooks = new HookSystem();

    // Create fresh model and repository
    Model = createMockModel('TestProduct');
    repository = createMockRepository(Model);
    controller = new BaseController(repository, { resourceName: 'product' });
  });

  describe('create()', () => {
    it('should create a new item', async () => {
      const req = createReq(hooks, {
        body: { name: 'Test Product', price: 100 },
      });

      const response = await controller.create(req);

      expect(response.status).toBe(201);
      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({
        name: 'Test Product',
        price: 100,
      });
    });

    it('should execute beforeCreate hooks', async () => {
      const beforeHook = vi.fn(async (ctx) => {
        return { ...ctx.data, price: ctx.data.price * 2 };
      });

      hooks.before('product', 'create', beforeHook);

      const req = createReq(hooks, {
        body: { name: 'Test Product', price: 100 },
      });

      const response = await controller.create(req);

      expect(beforeHook).toHaveBeenCalled();
      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({ price: 200 });
    });

    it('should execute afterCreate hooks', async () => {
      const afterHook = vi.fn();

      hooks.after('product', 'create', afterHook);

      const req = createReq(hooks, {
        body: { name: 'Test Product', price: 100 },
      });

      await controller.create(req);

      expect(afterHook).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({ name: 'Test Product' }),
        })
      );
    });

    it('should skip hooks if resourceName is undefined', async () => {
      const controllerWithoutResource = new BaseController(repository);
      const beforeHook = vi.fn();
      const afterHook = vi.fn();

      hooks.before('product', 'create', beforeHook);
      hooks.after('product', 'create', afterHook);

      const req = createReq(hooks, {
        body: { name: 'Test Product', price: 100 },
      });

      await controllerWithoutResource.create(req);

      expect(beforeHook).not.toHaveBeenCalled();
      expect(afterHook).not.toHaveBeenCalled();
    });
  });

  describe('update()', () => {
    it('should update an existing item', async () => {
      // Create item first
      const item = await Model.create({
        name: 'Original Product',
        price: 100,
      });

      const req = createReq(hooks, {
        body: { name: 'Updated Product', price: 150 },
        params: { id: item._id.toString() },
      });

      const response = await controller.update(req);

      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({
        name: 'Updated Product',
        price: 150,
      });
    });

    it('should execute beforeUpdate and afterUpdate hooks', async () => {
      const item = await Model.create({ name: 'Original', price: 100 });

      const beforeHook = vi.fn(async (ctx) => {
        return { ...ctx.data, price: ctx.data.price + 10 };
      });
      const afterHook = vi.fn();

      hooks.before('product', 'update', beforeHook);
      hooks.after('product', 'update', afterHook);

      const req = createReq(hooks, {
        body: { name: 'Updated', price: 150 },
        params: { id: item._id.toString() },
      });

      const response = await controller.update(req);

      expect(beforeHook).toHaveBeenCalled();
      expect(afterHook).toHaveBeenCalled();
      expect(response.data).toMatchObject({ price: 160 });
    });
  });

  describe('delete()', () => {
    it('should delete an item', async () => {
      const item = await Model.create({ name: 'Product', price: 100 });

      const req = createReq(hooks, {
        params: { id: item._id.toString() },
      });

      const response = await controller.delete(req);

      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({ message: 'Deleted successfully' });

      // Verify deletion
      const found = await Model.findById(item._id);
      expect(found).toBeNull();
    });

    it('should execute beforeDelete and afterDelete hooks', async () => {
      const item = await Model.create({ name: 'Product', price: 100 });

      const beforeHook = vi.fn();
      const afterHook = vi.fn();

      hooks.before('product', 'delete', beforeHook);
      hooks.after('product', 'delete', afterHook);

      const req = createReq(hooks, {
        params: { id: item._id.toString() },
      });

      await controller.delete(req);

      expect(beforeHook).toHaveBeenCalled();
      expect(afterHook).toHaveBeenCalled();
    });
  });

  describe('get()', () => {
    it('should retrieve a single item by ID', async () => {
      const item = await Model.create({ name: 'Product', price: 100 });

      const req = createReq(hooks, {
        params: { id: item._id.toString() },
      });

      const response = await controller.get(req);

      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({ name: 'Product' });
    });

    it('should return 404 for non-existent item', async () => {
      const req = createReq(hooks, {
        params: { id: '507f1f77bcf86cd799439011' }, // Valid ObjectId that doesn't exist
      });

      const response = await controller.get(req);

      expect(response.success).toBe(false);
      expect(response.status).toBe(404);
      expect(response.error).toBe('Resource not found');
    });
  });

  describe('list()', () => {
    it('should list all items with pagination', async () => {
      await Model.create([
        { name: 'Product 1', price: 100 },
        { name: 'Product 2', price: 200 },
        { name: 'Product 3', price: 300 },
      ]);

      const req = createReq(hooks, {
        query: { page: 1, limit: 10 },
      });

      const response = await controller.list(req);

      expect(response.success).toBe(true);
      expect(response.data?.docs.length).toBeGreaterThanOrEqual(3);
      const names = response.data?.docs.map((p: any) => p.name);
      expect(names).toEqual(expect.arrayContaining(['Product 1', 'Product 2', 'Product 3']));
      expect(response.data?.total).toBeGreaterThanOrEqual(3);
    });

    it('should support filtering', async () => {
      await Model.create([
        { name: 'Expensive Product', price: 1000 },
        { name: 'Cheap Product', price: 10 },
      ]);

      const req = createReq(hooks, {
        query: { 'price[gte]': '500' },
      });

      const response = await controller.list(req);

      expect(response.success).toBe(true);
      expect(response.data?.docs.length).toBeGreaterThanOrEqual(1);
      const expensiveProducts = response.data?.docs.filter((p: any) => p.price >= 500);
      expect(expensiveProducts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Hook Priority', () => {
    it('should execute hooks in priority order', async () => {
      const executionOrder: number[] = [];

      hooks.before('product', 'create', async () => {
        executionOrder.push(1);
      }, 1);

      hooks.before('product', 'create', async () => {
        executionOrder.push(3);
      }, 3);

      hooks.before('product', 'create', async () => {
        executionOrder.push(2);
      }, 2);

      const req = createReq(hooks, {
        body: { name: 'Test', price: 100 },
      });

      await controller.create(req);

      expect(executionOrder).toEqual([1, 2, 3]);
    });
  });

  describe('Error Handling', () => {
    it('should propagate errors from beforeCreate hooks', async () => {
      hooks.before('product', 'create', async () => {
        throw new Error('Validation failed');
      });

      const req = createReq(hooks, {
        body: { name: 'Test', price: 100 },
      });

      await expect(controller.create(req)).rejects.toThrow('Validation failed');
    });

    it('should log but not fail on afterCreate hook errors', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      hooks.after('product', 'create', async () => {
        throw new Error('After hook failed');
      });

      const req = createReq(hooks, {
        body: { name: 'Test', price: 100 },
      });

      // Should not throw
      const response = await controller.create(req);

      expect(response.success).toBe(true);
      expect(response.status).toBe(201);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });
});
