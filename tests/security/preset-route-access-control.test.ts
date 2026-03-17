/**
 * Security Tests: Preset Route Access Control
 *
 * Validates that preset routes (getBySlug, restore) enforce the same
 * access control guarantees as primary CRUD routes (get, update, delete).
 *
 * Regression tests for:
 * - getBySlug() bypassing policy filters and ownership checks
 * - restore() performing no access control before mutation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseController } from '../../src/core/BaseController.js';
import type { IRequestContext, AnyRecord } from '../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function createContext(
  overrides: Partial<IRequestContext> = {},
  metadata: AnyRecord = {},
): IRequestContext {
  return {
    params: {},
    query: {},
    body: {},
    user: null,
    headers: {},
    ...overrides,
    metadata,
  };
}

function createMockRepository(items: AnyRecord[] = []) {
  const store = new Map<string, AnyRecord>();
  items.forEach((item) => store.set(item._id, item));

  return {
    getAll: vi.fn(async () => Array.from(store.values())),
    getById: vi.fn(async (id: string) => store.get(id) || null),
    create: vi.fn(async (data: AnyRecord) => {
      const item = { ...data, _id: `${Date.now()}` };
      store.set(item._id, item);
      return item;
    }),
    update: vi.fn(async (id: string, data: AnyRecord) => {
      const existing = store.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...data };
      store.set(id, updated);
      return updated;
    }),
    delete: vi.fn(async (id: string) => {
      return store.delete(id);
    }),
    getBySlug: vi.fn(async (slug: string) => {
      return Array.from(store.values()).find((item) => item.slug === slug) || null;
    }),
    restore: vi.fn(async (id: string) => {
      const item = store.get(id);
      if (!item) return null;
      item.deletedAt = null;
      return item;
    }),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Security: Preset Route Access Control', () => {
  // --------------------------------------------------------------------------
  // getBySlug() access control
  // --------------------------------------------------------------------------

  describe('getBySlug() - policy filter enforcement', () => {
    it('should deny access when policy filters do not match', async () => {
      const repo = createMockRepository([
        { _id: '1', slug: 'my-item', status: 'draft', organizationId: 'org-1' },
      ]);

      const controller = new BaseController(repo, {
        presetFields: { slugField: 'slug' },
      });

      const ctx = createContext(
        { params: { slug: 'my-item' } },
        {
          _policyFilters: { status: 'published' }, // Item is 'draft', policy requires 'published'
        },
      );

      const result = await controller.getBySlug(ctx);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
    });

    it('should allow access when policy filters match', async () => {
      const repo = createMockRepository([
        { _id: '1', slug: 'my-item', status: 'published', organizationId: 'org-1' },
      ]);

      const controller = new BaseController(repo, {
        presetFields: { slugField: 'slug' },
      });

      const ctx = createContext(
        { params: { slug: 'my-item' } },
        {
          _policyFilters: { status: 'published' },
        },
      );

      const result = await controller.getBySlug(ctx);

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
    });

    it('should deny cross-org slug access', async () => {
      const repo = createMockRepository([
        { _id: '1', slug: 'shared-slug', organizationId: 'org-2' },
      ]);

      const controller = new BaseController(repo, {
        presetFields: { slugField: 'slug' },
      });

      const ctx = createContext(
        { params: { slug: 'shared-slug' } },
        {
          _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
        },
      );

      const result = await controller.getBySlug(ctx);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
    });

    it('should deny when both policy filters AND org scope fail', async () => {
      const repo = createMockRepository([
        { _id: '1', slug: 'item', status: 'draft', organizationId: 'org-2' },
      ]);

      const controller = new BaseController(repo, {
        presetFields: { slugField: 'slug' },
      });

      const ctx = createContext(
        { params: { slug: 'item' } },
        {
          _policyFilters: { status: 'published' },
          _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
        },
      );

      const result = await controller.getBySlug(ctx);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
    });

    it('should return 404 for non-existent slug', async () => {
      const repo = createMockRepository([]);

      const controller = new BaseController(repo, {
        presetFields: { slugField: 'slug' },
      });

      const ctx = createContext({ params: { slug: 'does-not-exist' } });

      const result = await controller.getBySlug(ctx);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // restore() access control
  // --------------------------------------------------------------------------

  describe('restore() - access control enforcement', () => {
    it('should deny restore when org scope does not match', async () => {
      const repo = createMockRepository([
        { _id: '1', name: 'Deleted Item', organizationId: 'org-2', deletedAt: new Date() },
      ]);

      const controller = new BaseController(repo);

      const ctx = createContext(
        { params: { id: '1' } },
        {
          _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
        },
      );

      const result = await controller.restore(ctx);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      // Verify restore was NOT called
      expect(repo.restore).not.toHaveBeenCalled();
    });

    it('should deny restore when policy filters do not match', async () => {
      const repo = createMockRepository([
        { _id: '1', name: 'Deleted Item', status: 'archived', deletedAt: new Date() },
      ]);

      const controller = new BaseController(repo);

      const ctx = createContext(
        { params: { id: '1' } },
        {
          _policyFilters: { status: 'active' }, // Item is 'archived'
        },
      );

      const result = await controller.restore(ctx);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      expect(repo.restore).not.toHaveBeenCalled();
    });

    it('should deny restore when ownership check fails', async () => {
      const repo = createMockRepository([
        { _id: '1', name: 'Deleted Item', createdBy: 'user-2', deletedAt: new Date() },
      ]);

      const controller = new BaseController(repo);

      const ctx = createContext(
        { params: { id: '1' } },
        {
          _ownershipCheck: { field: 'createdBy', userId: 'user-1' },
        },
      );

      const result = await controller.restore(ctx);

      expect(result.success).toBe(false);
      expect(result.status).toBe(403);
      expect(result.error).toContain('permission');
      expect(repo.restore).not.toHaveBeenCalled();
    });

    it('should allow restore when all access control checks pass', async () => {
      const repo = createMockRepository([
        {
          _id: '1',
          name: 'Deleted Item',
          organizationId: 'org-1',
          status: 'active',
          createdBy: 'user-1',
          deletedAt: new Date(),
        },
      ]);

      const controller = new BaseController(repo);

      const ctx = createContext(
        { params: { id: '1' } },
        {
          _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
          _policyFilters: { status: 'active' },
          _ownershipCheck: { field: 'createdBy', userId: 'user-1' },
        },
      );

      const result = await controller.restore(ctx);

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(repo.restore).toHaveBeenCalledWith('1');
    });

    it('should return 404 for non-existent item', async () => {
      const repo = createMockRepository([]);

      const controller = new BaseController(repo);

      const ctx = createContext({ params: { id: 'nonexistent' } });

      const result = await controller.restore(ctx);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
    });

    it('should return 400 when ID is missing', async () => {
      const repo = createMockRepository([]);

      const controller = new BaseController(repo);

      const ctx = createContext({ params: {} });

      const result = await controller.restore(ctx);

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
    });
  });
});
