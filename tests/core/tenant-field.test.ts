/**
 * TenantField Type Safety Tests
 *
 * Verifies that BaseController, AccessControl, and QueryResolver
 * handle both `tenantField: 'organizationId'` (multi-tenant)
 * and `tenantField: false` (platform-universal) correctly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BaseController } from '../../src/core/BaseController.js';
import { AccessControl } from '../../src/core/AccessControl.js';
import { QueryResolver, getDefaultQueryParser } from '../../src/core/QueryResolver.js';
import { HookSystem } from '../../src/hooks/HookSystem.js';
import type { IRequestContext } from '../../src/types/index.js';
import { mockUser } from '../setup.js';

// Minimal mock repository
function createMinimalRepo() {
  const store = new Map<string, any>();
  return {
    create: async (data: any) => {
      const id = Math.random().toString(36).slice(2);
      const doc = { _id: id, ...data };
      store.set(id, doc);
      return doc;
    },
    getById: async (id: string) => store.get(id) ?? null,
    getOne: async (filter: any) => {
      for (const doc of store.values()) {
        const match = Object.entries(filter).every(
          ([k, v]) => String(doc[k]) === String(v),
        );
        if (match) return doc;
      }
      return null;
    },
    getAll: async () => ({
      docs: [...store.values()],
      page: 1,
      limit: 20,
      total: store.size,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    }),
    update: async (id: string, data: any) => {
      const existing = store.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...data };
      store.set(id, updated);
      return updated;
    },
    delete: async (id: string) => {
      const existed = store.delete(id);
      return { success: existed, message: existed ? 'Deleted' : 'Not found' };
    },
  };
}

function createReq(overrides: Partial<IRequestContext> = {}): IRequestContext {
  return {
    query: {},
    body: {},
    params: {},
    user: mockUser,
    headers: {},
    metadata: {},
    ...overrides,
  };
}

function createScopedReq(
  orgId: string,
  overrides: Partial<IRequestContext> = {},
): IRequestContext {
  return createReq({
    ...overrides,
    metadata: {
      _scope: {
        kind: 'member',
        organizationId: orgId,
        orgRoles: ['admin'],
      },
      ...(overrides.metadata as any),
    },
  });
}

// ============================================================================
// AccessControl tests
// ============================================================================

describe('AccessControl with tenantField', () => {
  describe('tenantField: string (multi-tenant)', () => {
    const ac = new AccessControl({
      tenantField: 'organizationId',
      idField: '_id',
    });

    it('should include org filter in buildIdFilter when scoped', () => {
      const req = createScopedReq('org-123', { params: {} });
      const filter = ac.buildIdFilter('item-1', req);
      expect(filter).toEqual({
        _id: 'item-1',
        organizationId: 'org-123',
      });
    });

    it('should check org scope on documents', () => {
      const arcContext = {
        _scope: { kind: 'member', organizationId: 'org-123', orgRoles: ['admin'] },
      };
      expect(
        ac.checkOrgScope({ organizationId: 'org-123' }, arcContext),
      ).toBe(true);
      expect(
        ac.checkOrgScope({ organizationId: 'org-456' }, arcContext),
      ).toBe(false);
    });

    it('should deny documents missing the tenant field', () => {
      const arcContext = {
        _scope: { kind: 'member', organizationId: 'org-123', orgRoles: ['admin'] },
      };
      expect(ac.checkOrgScope({ name: 'no-org' }, arcContext)).toBe(false);
    });
  });

  describe('tenantField: false (platform-universal)', () => {
    const ac = new AccessControl({
      tenantField: false,
      idField: '_id',
    });

    it('should NOT include org filter in buildIdFilter', () => {
      const req = createScopedReq('org-123');
      const filter = ac.buildIdFilter('item-1', req);
      expect(filter).toEqual({ _id: 'item-1' });
      expect(filter).not.toHaveProperty('organizationId');
    });

    it('should always pass org scope check', () => {
      const arcContext = {
        _scope: { kind: 'member', organizationId: 'org-123', orgRoles: ['admin'] },
      };
      // Even with an org scope present, platform-universal resources skip the check
      expect(ac.checkOrgScope({}, arcContext)).toBe(true);
      expect(ac.checkOrgScope({ name: 'anything' }, arcContext)).toBe(true);
    });
  });
});

// ============================================================================
// QueryResolver tests
// ============================================================================

describe('QueryResolver with tenantField', () => {
  it('should inject org filter when tenantField is a string', () => {
    const qr = new QueryResolver({
      queryParser: getDefaultQueryParser(),
      maxLimit: 100,
      defaultLimit: 20,
      defaultSort: '-createdAt',
      schemaOptions: {},
      tenantField: 'organizationId',
    });

    const req = createScopedReq('org-abc', { query: {} });
    const result = qr.resolve(req, req.metadata as any);
    expect(result.filters).toHaveProperty('organizationId', 'org-abc');
  });

  it('should NOT inject org filter when tenantField is false', () => {
    const qr = new QueryResolver({
      queryParser: getDefaultQueryParser(),
      maxLimit: 100,
      defaultLimit: 20,
      defaultSort: '-createdAt',
      schemaOptions: {},
      tenantField: false,
    });

    const req = createScopedReq('org-abc', { query: {} });
    const result = qr.resolve(req, req.metadata as any);
    expect(result.filters).not.toHaveProperty('organizationId');
  });
});

// ============================================================================
// BaseController tests
// ============================================================================

describe('BaseController with tenantField', () => {
  describe('tenantField: string (multi-tenant)', () => {
    it('should inject tenant field on create', async () => {
      const repo = createMinimalRepo();
      const controller = new BaseController(repo, {
        tenantField: 'organizationId',
        resourceName: 'test',
      });

      const req = createScopedReq('org-123', {
        body: { name: 'Test Item' },
      });
      const res = await controller.create(req);

      expect(res.success).toBe(true);
      expect(res.data).toHaveProperty('organizationId', 'org-123');
    });
  });

  describe('tenantField: false (platform-universal)', () => {
    it('should NOT inject tenant field on create', async () => {
      const repo = createMinimalRepo();
      const controller = new BaseController(repo, {
        tenantField: false,
        resourceName: 'test',
      });

      const req = createScopedReq('org-123', {
        body: { name: 'Platform Item' },
      });
      const res = await controller.create(req);

      expect(res.success).toBe(true);
      expect(res.data).not.toHaveProperty('organizationId');
    });

    it('should return undefined from getTenantField()', () => {
      const repo = createMinimalRepo();

      // Subclass to test the protected helper
      class TestController extends BaseController {
        exposeTenantField() {
          return this.getTenantField();
        }
      }

      const controllerFalse = new TestController(repo, { tenantField: false });
      expect(controllerFalse.exposeTenantField()).toBeUndefined();

      const controllerString = new TestController(repo, {
        tenantField: 'workspaceId',
      });
      expect(controllerString.exposeTenantField()).toBe('workspaceId');
    });
  });
});
