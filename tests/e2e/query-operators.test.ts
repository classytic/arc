/**
 * Query Operators E2E Tests
 *
 * Tests all query operators through the full Arc + MongoKit stack:
 * - Comparison: gte, lte, gt, lt, ne, in
 * - Sorting: ascending, descending, multi-field
 * - Field selection: select specific fields
 * - Pagination: page, limit, hasNext, hasPrev
 * - Text search: search parameter
 * - Exact match filtering
 * - Boolean filtering
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createApp } from '../../src/factory/createApp.js';
import { defineResource } from '../../src/core/defineResource.js';
import { BaseController } from '../../src/core/BaseController.js';
import { createMongooseAdapter } from '../../src/adapters/mongoose.js';
import { allowPublic } from '../../src/permissions/index.js';
import { setupTestDatabase, teardownTestDatabase } from '../setup.js';
import type { FastifyInstance } from 'fastify';

describe('Query Operators E2E', () => {
  let app: FastifyInstance;

  // Create a model with text index for search testing
  const ProductSchema = new mongoose.Schema(
    {
      name: { type: String, required: true },
      description: String,
      category: String,
      price: { type: Number, required: true },
      stock: { type: Number, default: 0 },
      isActive: { type: Boolean, default: true },
      tags: [String],
    },
    { timestamps: true }
  );

  // Text index for search
  ProductSchema.index({ name: 'text', description: 'text' });

  beforeAll(async () => {
    await setupTestDatabase();

    // Prevent duplicate model registration
    const model = mongoose.models['QueryProduct'] || mongoose.model('QueryProduct', ProductSchema);

    const { Repository } = require('@classytic/mongokit');
    const repo = new Repository(model);
    const controller = new BaseController(repo);

    const productResource = defineResource({
      name: 'queryProduct',
      adapter: createMongooseAdapter({ model, repository: repo }),
      controller,
      prefix: '/products',
      tag: 'Products',
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    app = await createApp({
      preset: 'development',
      auth: { jwt: { secret: 'test-jwt-secret-must-be-at-least-32-chars-long' } },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.register(productResource.toPlugin());
      },
    });

    await app.ready();

    // Seed test data
    await model.create([
      { name: 'Alpha Widget', description: 'Professional alpha grade widget', category: 'widgets', price: 29.99, stock: 100, isActive: true, tags: ['premium', 'bestseller'] },
      { name: 'Beta Gadget', description: 'Consumer beta gadget', category: 'gadgets', price: 49.99, stock: 50, isActive: true, tags: ['new'] },
      { name: 'Gamma Device', description: 'Industrial gamma device', category: 'devices', price: 199.99, stock: 10, isActive: true, tags: ['premium', 'industrial'] },
      { name: 'Delta Tool', description: 'Basic delta hand tool', category: 'tools', price: 9.99, stock: 200, isActive: true, tags: ['budget'] },
      { name: 'Epsilon Gizmo', description: 'Experimental epsilon gizmo', category: 'gadgets', price: 149.99, stock: 5, isActive: false, tags: ['experimental'] },
      { name: 'Zeta Widget', description: 'Economy zeta widget', category: 'widgets', price: 14.99, stock: 0, isActive: false, tags: ['budget', 'clearance'] },
    ]);

    // Wait for text index to build
    await model.ensureIndexes();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  // Helper to GET products and parse response
  async function query(qs: string) {
    const res = await app.inject({ method: 'GET', url: `/products?${qs}` });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  // ========================================================================
  // Comparison Operators
  // ========================================================================

  describe('Comparison operators', () => {
    it('should filter with gte (greater than or equal)', async () => {
      const body = await query('price[gte]=100');
      expect(body.docs.length).toBe(2); // Gamma 199.99, Epsilon 149.99
      body.docs.forEach((d: any) => expect(d.price).toBeGreaterThanOrEqual(100));
    });

    it('should filter with lte (less than or equal)', async () => {
      const body = await query('price[lte]=15');
      expect(body.docs.length).toBe(2); // Delta 9.99, Zeta 14.99
      body.docs.forEach((d: any) => expect(d.price).toBeLessThanOrEqual(15));
    });

    it('should filter with gt (greater than)', async () => {
      const body = await query('price[gt]=49.99');
      // Only Gamma (199.99) and Epsilon (149.99)
      expect(body.docs.length).toBe(2);
      body.docs.forEach((d: any) => expect(d.price).toBeGreaterThan(49.99));
    });

    it('should filter with lt (less than)', async () => {
      const body = await query('price[lt]=15');
      // Delta (9.99) and Zeta (14.99) are both < 15
      expect(body.docs.length).toBe(2);
      body.docs.forEach((d: any) => expect(d.price).toBeLessThan(15));
    });

    it('should filter with ne (not equal)', async () => {
      const body = await query('category[ne]=widgets');
      // gadgets, devices, tools — all non-widget items
      expect(body.docs.length).toBe(4);
      body.docs.forEach((d: any) => expect(d.category).not.toBe('widgets'));
    });

    it('should filter with in (in set)', async () => {
      const body = await query('category[in]=widgets,gadgets');
      // Alpha, Beta, Epsilon, Zeta
      expect(body.docs.length).toBe(4);
      body.docs.forEach((d: any) => {
        expect(['widgets', 'gadgets']).toContain(d.category);
      });
    });

    it('should combine gte and lte for range', async () => {
      const body = await query('price[gte]=10&price[lte]=50');
      // Alpha 29.99, Beta 49.99, Zeta 14.99
      expect(body.docs.length).toBe(3);
      body.docs.forEach((d: any) => {
        expect(d.price).toBeGreaterThanOrEqual(10);
        expect(d.price).toBeLessThanOrEqual(50);
      });
    });
  });

  // ========================================================================
  // Exact Match Filters
  // ========================================================================

  describe('Exact match filters', () => {
    it('should filter by exact category match', async () => {
      const body = await query('category=widgets');
      expect(body.docs.length).toBe(2);
      body.docs.forEach((d: any) => expect(d.category).toBe('widgets'));
    });

    it('should filter by boolean field', async () => {
      const body = await query('isActive=true');
      expect(body.docs.length).toBe(4);
      body.docs.forEach((d: any) => expect(d.isActive).toBe(true));
    });

    it('should filter inactive items', async () => {
      const body = await query('isActive=false');
      expect(body.docs.length).toBe(2);
      body.docs.forEach((d: any) => expect(d.isActive).toBe(false));
    });

    it('should combine exact match with comparison', async () => {
      const body = await query('category=gadgets&price[gte]=100');
      // Only Epsilon (gadget, 149.99)
      expect(body.docs.length).toBe(1);
      expect(body.docs[0].name).toBe('Epsilon Gizmo');
    });
  });

  // ========================================================================
  // Sorting
  // ========================================================================

  describe('Sorting', () => {
    it('should sort ascending by price', async () => {
      const body = await query('sort=price');
      const prices = body.docs.map((d: any) => d.price);
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
      }
    });

    it('should sort descending by price', async () => {
      const body = await query('sort=-price');
      const prices = body.docs.map((d: any) => d.price);
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeLessThanOrEqual(prices[i - 1]);
      }
    });

    it('should sort by name ascending', async () => {
      const body = await query('sort=name');
      const names = body.docs.map((d: any) => d.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });

    it('should sort descending by stock', async () => {
      const body = await query('sort=-stock');
      const stocks = body.docs.map((d: any) => d.stock);
      for (let i = 1; i < stocks.length; i++) {
        expect(stocks[i]).toBeLessThanOrEqual(stocks[i - 1]);
      }
    });
  });

  // ========================================================================
  // Field Selection
  // ========================================================================

  describe('Field selection', () => {
    it('should select specific fields only', async () => {
      const body = await query('select=name,price');
      expect(body.docs.length).toBeGreaterThan(0);
      body.docs.forEach((d: any) => {
        expect(d.name).toBeDefined();
        expect(d.price).toBeDefined();
        expect(d._id).toBeDefined(); // _id is always included
        // Other fields should not be present
        expect(d.description).toBeUndefined();
        expect(d.category).toBeUndefined();
        expect(d.stock).toBeUndefined();
      });
    });

    it('should work with filters and select', async () => {
      const body = await query('category=widgets&select=name,price');
      expect(body.docs.length).toBe(2);
      body.docs.forEach((d: any) => {
        expect(d.name).toBeDefined();
        expect(d.price).toBeDefined();
        expect(d.description).toBeUndefined();
      });
    });
  });

  // ========================================================================
  // Pagination
  // ========================================================================

  describe('Pagination', () => {
    it('should paginate with page and limit', async () => {
      const body = await query('page=1&limit=2&sort=name');

      expect(body.docs.length).toBe(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(2);
      expect(body.total).toBe(6);
      expect(body.pages).toBe(3); // 6 items / 2 per page
      expect(body.hasNext).toBe(true);
      expect(body.hasPrev).toBe(false);
    });

    it('should return second page', async () => {
      const body = await query('page=2&limit=2&sort=name');

      expect(body.docs.length).toBe(2);
      expect(body.page).toBe(2);
      expect(body.hasNext).toBe(true);
      expect(body.hasPrev).toBe(true);
    });

    it('should return last page', async () => {
      const body = await query('page=3&limit=2&sort=name');

      expect(body.docs.length).toBe(2);
      expect(body.page).toBe(3);
      expect(body.hasNext).toBe(false);
      expect(body.hasPrev).toBe(true);
    });

    it('should return empty docs for page beyond range', async () => {
      const body = await query('page=10&limit=2');

      expect(body.docs.length).toBe(0);
      expect(body.page).toBe(10);
      expect(body.total).toBe(6);
    });

    it('should default to reasonable limit', async () => {
      const body = await query('');
      // Default page = 1, default limit should be reasonable
      expect(body.page).toBe(1);
      expect(body.limit).toBeGreaterThan(0);
      expect(body.total).toBe(6);
    });
  });

  // ========================================================================
  // Text Search
  // ========================================================================

  describe('Text search', () => {
    it('should find products by text search (name/description)', async () => {
      const body = await query('search=professional');
      expect(body.docs.length).toBeGreaterThanOrEqual(1);
      // Alpha Widget has "Professional" in description
      const names = body.docs.map((d: any) => d.name);
      expect(names).toContain('Alpha Widget');
    });

    it('should find products by name search', async () => {
      const body = await query('search=gadget');
      expect(body.docs.length).toBeGreaterThanOrEqual(1);
      const names = body.docs.map((d: any) => d.name);
      expect(names).toContain('Beta Gadget');
    });

    it('should return empty for non-matching search', async () => {
      const body = await query('search=nonexistent-product-xyz');
      expect(body.docs.length).toBe(0);
    });

    it('should combine search with filters', async () => {
      const body = await query('search=widget&isActive=true');
      // Alpha Widget (active) but not Zeta Widget (inactive)
      expect(body.docs.length).toBe(1);
      expect(body.docs[0].name).toBe('Alpha Widget');
    });
  });

  // ========================================================================
  // Combined Queries
  // ========================================================================

  describe('Combined queries', () => {
    it('should combine filter + sort + pagination', async () => {
      const body = await query('isActive=true&sort=-price&page=1&limit=2');

      expect(body.docs.length).toBe(2);
      expect(body.total).toBe(4); // 4 active products
      // Sorted descending by price, so first should be most expensive active
      expect(body.docs[0].price).toBeGreaterThanOrEqual(body.docs[1].price);
    });

    it('should combine filter + sort + select', async () => {
      const body = await query('category=gadgets&sort=price&select=name,price');

      expect(body.docs.length).toBe(2);
      // Beta (49.99) before Epsilon (149.99)
      expect(body.docs[0].price).toBeLessThanOrEqual(body.docs[1].price);
      body.docs.forEach((d: any) => {
        expect(d.description).toBeUndefined();
      });
    });

    it('should combine range + sort + limit', async () => {
      const body = await query('price[gte]=10&price[lte]=200&sort=price&limit=3');

      expect(body.docs.length).toBe(3);
      const prices = body.docs.map((d: any) => d.price);
      // Should be ascending
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
      }
    });
  });
});
