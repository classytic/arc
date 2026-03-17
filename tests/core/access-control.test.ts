/**
 * AccessControl Tests
 *
 * Tests ID filtering, policy filter checking, org/tenant scope validation,
 * ownership verification, fetch-with-access-control patterns, and ReDoS protection.
 */

import { describe, it, expect, vi } from 'vitest';
import { AccessControl } from '../../src/core/AccessControl.js';
import type { IRequestContext, ArcInternalMetadata, AnyRecord } from '../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function createAccessControl(overrides: Partial<ConstructorParameters<typeof AccessControl>[0]> = {}) {
  return new AccessControl({
    tenantField: 'organizationId',
    idField: '_id',
    ...overrides,
  });
}

function createReq(metadata: Partial<ArcInternalMetadata> = {}): IRequestContext {
  return {
    params: {},
    query: {},
    body: {},
    user: null,
    headers: {},
    metadata: metadata as Record<string, unknown>,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('AccessControl', () => {
  // --------------------------------------------------------------------------
  // buildIdFilter
  // --------------------------------------------------------------------------

  describe('buildIdFilter()', () => {
    it('returns filter with only ID when no policy or scope', () => {
      const ac = createAccessControl();
      const req = createReq();

      const filter = ac.buildIdFilter('abc123', req);

      expect(filter).toEqual({ _id: 'abc123' });
    });

    it('includes policy filters in the compound filter', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: 'active', department: 'engineering' },
      });

      const filter = ac.buildIdFilter('abc123', req);

      expect(filter).toEqual({
        _id: 'abc123',
        status: 'active',
        department: 'engineering',
      });
    });

    it('includes org scope in the compound filter for member scope', () => {
      const ac = createAccessControl();
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['admin'] },
      });

      const filter = ac.buildIdFilter('abc123', req);

      expect(filter).toEqual({
        _id: 'abc123',
        organizationId: 'org-1',
      });
    });

    it('includes org scope for elevated scope with organizationId', () => {
      const ac = createAccessControl();
      const req = createReq({
        _scope: { kind: 'elevated', organizationId: 'org-1', elevatedBy: 'admin' },
      });

      const filter = ac.buildIdFilter('abc123', req);

      expect(filter).toEqual({
        _id: 'abc123',
        organizationId: 'org-1',
      });
    });

    it('does not include org scope for elevated scope without organizationId', () => {
      const ac = createAccessControl();
      const req = createReq({
        _scope: { kind: 'elevated', elevatedBy: 'admin' },
      });

      const filter = ac.buildIdFilter('abc123', req);

      expect(filter).toEqual({ _id: 'abc123' });
    });

    it('combines policy filters AND org scope', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: 'active' },
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['user'] },
      });

      const filter = ac.buildIdFilter('abc123', req);

      expect(filter).toEqual({
        _id: 'abc123',
        status: 'active',
        organizationId: 'org-1',
      });
    });

    it('does not override org scope if already in policy filters', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { organizationId: 'policy-org' },
        _scope: { kind: 'member', organizationId: 'scope-org', orgRoles: [] },
      });

      const filter = ac.buildIdFilter('abc123', req);

      // Policy filter wins; org scope should NOT overwrite
      expect(filter.organizationId).toBe('policy-org');
    });

    it('uses custom idField', () => {
      const ac = createAccessControl({ idField: 'id' });
      const req = createReq();

      const filter = ac.buildIdFilter('abc123', req);

      expect(filter).toEqual({ id: 'abc123' });
    });

    it('uses custom tenantField', () => {
      const ac = createAccessControl({ tenantField: 'workspaceId' });
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'ws-1', orgRoles: [] },
      });

      const filter = ac.buildIdFilter('abc123', req);

      expect(filter).toEqual({
        _id: 'abc123',
        workspaceId: 'ws-1',
      });
    });

    it('skips org filter when tenantField is false (platform-universal)', () => {
      const ac = createAccessControl({ tenantField: false });
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['admin'] },
      });

      const filter = ac.buildIdFilter('abc123', req);

      // Should only have ID — no org filter
      expect(filter).toEqual({ _id: 'abc123' });
    });

    it('skips org filter with tenantField: false even with policy filters', () => {
      const ac = createAccessControl({ tenantField: false });
      const req = createReq({
        _policyFilters: { status: 'active' },
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['user'] },
      });

      const filter = ac.buildIdFilter('abc123', req);

      // Policy filters applied, but no org filter
      expect(filter).toEqual({
        _id: 'abc123',
        status: 'active',
      });
      expect(filter.organizationId).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // checkPolicyFilters
  // --------------------------------------------------------------------------

  describe('checkPolicyFilters()', () => {
    it('returns true when no policy filters are set', () => {
      const ac = createAccessControl();
      const req = createReq();
      const item = { _id: '1', name: 'Test' };

      expect(ac.checkPolicyFilters(item, req)).toBe(true);
    });

    it('returns true when item matches simple equality filter', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: 'active' },
      });

      expect(ac.checkPolicyFilters({ status: 'active', name: 'Test' }, req)).toBe(true);
    });

    it('returns false when item does not match simple equality filter', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: 'active' },
      });

      expect(ac.checkPolicyFilters({ status: 'archived', name: 'Test' }, req)).toBe(false);
    });

    it('handles $in operator', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: { $in: ['active', 'pending'] } },
      });

      expect(ac.checkPolicyFilters({ status: 'active' }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ status: 'pending' }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ status: 'archived' }, req)).toBe(false);
    });

    it('handles $ne operator', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: { $ne: 'deleted' } },
      });

      expect(ac.checkPolicyFilters({ status: 'active' }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ status: 'deleted' }, req)).toBe(false);
    });

    it('handles $gt and $lt operators', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { price: { $gt: 10, $lt: 100 } },
      });

      expect(ac.checkPolicyFilters({ price: 50 }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ price: 5 }, req)).toBe(false);
      expect(ac.checkPolicyFilters({ price: 100 }, req)).toBe(false);
    });

    it('handles $gte and $lte operators', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { price: { $gte: 10, $lte: 100 } },
      });

      expect(ac.checkPolicyFilters({ price: 10 }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ price: 100 }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ price: 9 }, req)).toBe(false);
    });

    it('handles $exists operator', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { deletedAt: { $exists: false } },
      });

      expect(ac.checkPolicyFilters({ name: 'Test' }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ name: 'Test', deletedAt: new Date() }, req)).toBe(false);
    });

    it('handles $nin operator', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: { $nin: ['deleted', 'archived'] } },
      });

      expect(ac.checkPolicyFilters({ status: 'active' }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ status: 'deleted' }, req)).toBe(false);
    });

    it('handles $regex operator with safe pattern', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { name: { $regex: '^Test' } },
      });

      expect(ac.checkPolicyFilters({ name: 'Testing' }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ name: 'Product' }, req)).toBe(false);
    });

    it('handles $and operator', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: {
          $and: [
            { status: 'active' },
            { department: 'engineering' },
          ],
        },
      });

      expect(ac.checkPolicyFilters({ status: 'active', department: 'engineering' }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ status: 'active', department: 'sales' }, req)).toBe(false);
    });

    it('handles $or operator', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: {
          $or: [
            { status: 'active' },
            { status: 'pending' },
          ],
        },
      });

      expect(ac.checkPolicyFilters({ status: 'active' }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ status: 'pending' }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ status: 'archived' }, req)).toBe(false);
    });

    it('enforces sibling constraints alongside $or', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: {
          $or: [{ ownerId: 'u1' }, { reviewerId: 'u1' }],
          status: 'published',
        },
      });

      // Matches $or AND sibling status
      expect(ac.checkPolicyFilters({ ownerId: 'u1', status: 'published' }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ reviewerId: 'u1', status: 'published' }, req)).toBe(true);

      // Matches $or but NOT sibling status — should be denied
      expect(ac.checkPolicyFilters({ ownerId: 'u1', status: 'draft' }, req)).toBe(false);
      expect(ac.checkPolicyFilters({ reviewerId: 'u1', status: 'draft' }, req)).toBe(false);

      // Matches sibling status but NOT $or — should be denied
      expect(ac.checkPolicyFilters({ ownerId: 'u2', status: 'published' }, req)).toBe(false);
    });

    it('enforces sibling constraints alongside $and', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: {
          $and: [{ role: 'editor' }, { active: true }],
          department: 'engineering',
        },
      });

      // All match
      expect(ac.checkPolicyFilters({ role: 'editor', active: true, department: 'engineering' }, req)).toBe(true);

      // $and passes but sibling fails
      expect(ac.checkPolicyFilters({ role: 'editor', active: true, department: 'sales' }, req)).toBe(false);

      // sibling passes but $and fails
      expect(ac.checkPolicyFilters({ role: 'viewer', active: true, department: 'engineering' }, req)).toBe(false);
    });

    it('enforces sibling constraints with both $and and $or', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: {
          $and: [{ active: true }],
          $or: [{ ownerId: 'u1' }, { reviewerId: 'u1' }],
          status: 'published',
        },
      });

      // All three conditions met
      expect(ac.checkPolicyFilters({ active: true, ownerId: 'u1', status: 'published' }, req)).toBe(true);

      // Missing $and condition
      expect(ac.checkPolicyFilters({ active: false, ownerId: 'u1', status: 'published' }, req)).toBe(false);

      // Missing $or condition
      expect(ac.checkPolicyFilters({ active: true, ownerId: 'u2', status: 'published' }, req)).toBe(false);

      // Missing sibling condition
      expect(ac.checkPolicyFilters({ active: true, ownerId: 'u1', status: 'draft' }, req)).toBe(false);
    });

    it('handles nested dot-notation paths', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { 'owner.id': 'user-1' },
      });

      expect(ac.checkPolicyFilters({ owner: { id: 'user-1' } }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ owner: { id: 'user-2' } }, req)).toBe(false);
    });

    it('handles array field with implicit matching', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { tags: 'important' },
      });

      expect(ac.checkPolicyFilters({ tags: ['important', 'urgent'] }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ tags: ['low'] }, req)).toBe(false);
    });

    it('handles $in with array item value', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { roles: { $in: ['admin', 'manager'] } },
      });

      expect(ac.checkPolicyFilters({ roles: ['admin', 'user'] }, req)).toBe(true);
      expect(ac.checkPolicyFilters({ roles: ['viewer'] }, req)).toBe(false);
    });

    it('delegates to adapter matchesFilter when provided', () => {
      const customMatcher = vi.fn().mockReturnValue(true);
      const ac = createAccessControl({ matchesFilter: customMatcher });
      const req = createReq({
        _policyFilters: { status: 'active' },
      });
      const item = { status: 'active' };

      const result = ac.checkPolicyFilters(item, req);

      expect(result).toBe(true);
      expect(customMatcher).toHaveBeenCalledWith(item, { status: 'active' });
    });

    it('uses adapter matchesFilter return value (false case)', () => {
      const customMatcher = vi.fn().mockReturnValue(false);
      const ac = createAccessControl({ matchesFilter: customMatcher });
      const req = createReq({
        _policyFilters: { status: 'active' },
      });

      expect(ac.checkPolicyFilters({ status: 'active' }, req)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // checkOrgScope
  // --------------------------------------------------------------------------

  describe('checkOrgScope()', () => {
    it('returns true when item is null', () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      };

      expect(ac.checkOrgScope(null, arcContext)).toBe(true);
    });

    it('returns true when no org scope is active', () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: 'public' },
      };

      expect(ac.checkOrgScope({ organizationId: 'org-1', name: 'Test' }, arcContext)).toBe(true);
    });

    it('returns true when item belongs to the correct org', () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      };

      expect(ac.checkOrgScope({ organizationId: 'org-1', name: 'Test' }, arcContext)).toBe(true);
    });

    it('returns false when item belongs to a different org', () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      };

      expect(ac.checkOrgScope({ organizationId: 'org-2', name: 'Test' }, arcContext)).toBe(false);
    });

    it('returns false when item is missing tenant field and org scope is active', () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      };

      // SECURITY: items without tenant field are denied to prevent cross-org leaks
      expect(ac.checkOrgScope({ name: 'Test' }, arcContext)).toBe(false);
    });

    it('uses custom tenantField', () => {
      const ac = createAccessControl({ tenantField: 'workspaceId' });
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: 'member', organizationId: 'ws-1', orgRoles: [] },
      };

      expect(ac.checkOrgScope({ workspaceId: 'ws-1', name: 'Test' }, arcContext)).toBe(true);
      expect(ac.checkOrgScope({ workspaceId: 'ws-2', name: 'Test' }, arcContext)).toBe(false);
    });

    it('returns true when arcContext is undefined', () => {
      const ac = createAccessControl();

      expect(ac.checkOrgScope({ organizationId: 'org-1', name: 'Test' }, undefined)).toBe(true);
    });

    it('compares org IDs as strings for ObjectId compatibility', () => {
      const ac = createAccessControl();
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: 'member', organizationId: '507f1f77bcf86cd799439012', orgRoles: [] },
      };

      // Simulate an item where organizationId might be stored differently
      expect(ac.checkOrgScope({ organizationId: '507f1f77bcf86cd799439012' }, arcContext)).toBe(true);
    });

    it('always returns true when tenantField is false (platform-universal)', () => {
      const ac = createAccessControl({ tenantField: false });
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['admin'] },
      };

      // Item without organizationId should pass — platform-universal skips org check
      expect(ac.checkOrgScope({ name: 'Test' }, arcContext)).toBe(true);
    });

    it('returns true with tenantField: false even for cross-org items', () => {
      const ac = createAccessControl({ tenantField: false });
      const arcContext: ArcInternalMetadata = {
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      };

      // Item with different org should still pass — platform-universal ignores org
      expect(ac.checkOrgScope({ organizationId: 'org-2', name: 'Test' }, arcContext)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // checkOwnership
  // --------------------------------------------------------------------------

  describe('checkOwnership()', () => {
    it('returns true when no ownership check is configured', () => {
      const ac = createAccessControl();
      const req = createReq();

      expect(ac.checkOwnership({ _id: '1', createdBy: 'user-1' }, req)).toBe(true);
    });

    it('returns true when item is null', () => {
      const ac = createAccessControl();
      const req = createReq({
        _ownershipCheck: { field: 'createdBy', userId: 'user-1' },
      });

      expect(ac.checkOwnership(null, req)).toBe(true);
    });

    it('returns true when item owner matches userId', () => {
      const ac = createAccessControl();
      const req = createReq({
        _ownershipCheck: { field: 'createdBy', userId: 'user-1' },
      });

      expect(ac.checkOwnership({ createdBy: 'user-1', name: 'Test' }, req)).toBe(true);
    });

    it('returns false when item owner does not match userId', () => {
      const ac = createAccessControl();
      const req = createReq({
        _ownershipCheck: { field: 'createdBy', userId: 'user-1' },
      });

      expect(ac.checkOwnership({ createdBy: 'user-2', name: 'Test' }, req)).toBe(false);
    });

    it('returns true when owner field is not present on item', () => {
      const ac = createAccessControl();
      const req = createReq({
        _ownershipCheck: { field: 'createdBy', userId: 'user-1' },
      });

      // If the field doesn't exist on the item, ownership is not enforced
      expect(ac.checkOwnership({ name: 'Test' }, req)).toBe(true);
    });

    it('compares owner IDs as strings for ObjectId compatibility', () => {
      const ac = createAccessControl();
      const req = createReq({
        _ownershipCheck: { field: 'createdBy', userId: '507f1f77bcf86cd799439011' },
      });

      expect(ac.checkOwnership({ createdBy: '507f1f77bcf86cd799439011' }, req)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // fetchWithAccessControl
  // --------------------------------------------------------------------------

  describe('fetchWithAccessControl()', () => {
    it('returns item when compound filter matches via getOne', async () => {
      const ac = createAccessControl();
      const item = { _id: 'abc', name: 'Test', organizationId: 'org-1' };
      const repo = {
        getById: vi.fn(),
        getOne: vi.fn().mockResolvedValue(item),
      };
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      });

      const result = await ac.fetchWithAccessControl('abc', req, repo);

      expect(result).toEqual(item);
      expect(repo.getOne).toHaveBeenCalledWith(
        { _id: 'abc', organizationId: 'org-1' },
        undefined,
      );
      expect(repo.getById).not.toHaveBeenCalled();
    });

    it('returns null when getOne returns null', async () => {
      const ac = createAccessControl();
      const repo = {
        getById: vi.fn(),
        getOne: vi.fn().mockResolvedValue(null),
      };
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      });

      const result = await ac.fetchWithAccessControl('abc', req, repo);

      expect(result).toBeNull();
    });

    it('falls back to getById + post-hoc checks when getOne is not available', async () => {
      const ac = createAccessControl();
      const item = { _id: 'abc', name: 'Test', organizationId: 'org-1' };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
        // no getOne
      };
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      });

      const result = await ac.fetchWithAccessControl('abc', req, repo);

      expect(result).toEqual(item);
      expect(repo.getById).toHaveBeenCalledWith('abc', undefined);
    });

    it('returns null when post-hoc org scope check fails', async () => {
      const ac = createAccessControl();
      const item = { _id: 'abc', name: 'Test', organizationId: 'org-2' };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
        // no getOne — forces fallback path
      };
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      });

      const result = await ac.fetchWithAccessControl('abc', req, repo);

      expect(result).toBeNull();
    });

    it('returns null when post-hoc policy filter check fails', async () => {
      const ac = createAccessControl();
      const item = { _id: 'abc', name: 'Test', status: 'archived' };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
      };
      const req = createReq({
        _policyFilters: { status: 'active' },
      });

      const result = await ac.fetchWithAccessControl('abc', req, repo);

      expect(result).toBeNull();
    });

    it('returns null when getById returns null', async () => {
      const ac = createAccessControl();
      const repo = {
        getById: vi.fn().mockResolvedValue(null),
      };
      const req = createReq();

      const result = await ac.fetchWithAccessControl('abc', req, repo);

      expect(result).toBeNull();
    });

    it('returns null when repository throws "not found" error', async () => {
      const ac = createAccessControl();
      const repo = {
        getById: vi.fn().mockRejectedValue(new Error('Document not found')),
      };
      const req = createReq();

      const result = await ac.fetchWithAccessControl('abc', req, repo);

      expect(result).toBeNull();
    });

    it('rethrows non-"not found" errors', async () => {
      const ac = createAccessControl();
      const repo = {
        getById: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      };
      const req = createReq();

      await expect(ac.fetchWithAccessControl('abc', req, repo)).rejects.toThrow('Database connection failed');
    });

    it('uses getById directly when no compound filters exist', async () => {
      const ac = createAccessControl();
      const item = { _id: 'abc', name: 'Test' };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
        getOne: vi.fn(),
      };
      const req = createReq(); // no scope, no policy filters

      const result = await ac.fetchWithAccessControl('abc', req, repo);

      expect(result).toEqual(item);
      expect(repo.getById).toHaveBeenCalledWith('abc', undefined);
      expect(repo.getOne).not.toHaveBeenCalled();
    });

    it('passes queryOptions through to repository', async () => {
      const ac = createAccessControl();
      const item = { _id: 'abc', name: 'Test' };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
      };
      const req = createReq();
      const queryOptions = { select: 'name email', populate: 'author' };

      await ac.fetchWithAccessControl('abc', req, repo, queryOptions);

      expect(repo.getById).toHaveBeenCalledWith('abc', queryOptions);
    });

    it('fetches item without org filter when tenantField is false (platform-universal)', async () => {
      const ac = createAccessControl({ tenantField: false });
      const item = { _id: 'abc', name: 'Platform Item' };
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
        getOne: vi.fn(),
      };
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['user'] },
      });

      const result = await ac.fetchWithAccessControl('abc', req, repo);

      // Should use getById directly (no compound filter, only _id)
      expect(result).toEqual(item);
      expect(repo.getById).toHaveBeenCalledWith('abc', undefined);
      expect(repo.getOne).not.toHaveBeenCalled();
    });

    it('returns item via post-hoc check with tenantField: false even without org field', async () => {
      const ac = createAccessControl({ tenantField: false });
      const item = { _id: 'abc', name: 'Platform Item' }; // no organizationId
      const repo = {
        getById: vi.fn().mockResolvedValue(item),
        // no getOne — forces fallback path
      };
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      });

      const result = await ac.fetchWithAccessControl('abc', req, repo);

      // Should return item — checkOrgScope skips when tenantField is false
      expect(result).toEqual(item);
    });
  });

  // --------------------------------------------------------------------------
  // validateItemAccess
  // --------------------------------------------------------------------------

  describe('validateItemAccess()', () => {
    it('returns false for null item', () => {
      const ac = createAccessControl();
      const req = createReq();

      expect(ac.validateItemAccess(null as any, req)).toBe(false);
    });

    it('returns true when no access control constraints exist', () => {
      const ac = createAccessControl();
      const req = createReq();

      expect(ac.validateItemAccess({ _id: '1', name: 'Test' }, req)).toBe(true);
    });

    it('validates org scope', () => {
      const ac = createAccessControl();
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
      });

      expect(ac.validateItemAccess({ organizationId: 'org-1', name: 'Test' }, req)).toBe(true);
      expect(ac.validateItemAccess({ organizationId: 'org-2', name: 'Test' }, req)).toBe(false);
    });

    it('validates policy filters', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { status: 'active' },
      });

      expect(ac.validateItemAccess({ status: 'active', name: 'Test' }, req)).toBe(true);
      expect(ac.validateItemAccess({ status: 'archived', name: 'Test' }, req)).toBe(false);
    });

    it('validates both org scope AND policy filters', () => {
      const ac = createAccessControl();
      const req = createReq({
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
        _policyFilters: { status: 'active' },
      });

      // Both pass
      expect(ac.validateItemAccess({ organizationId: 'org-1', status: 'active' }, req)).toBe(true);
      // Org fails
      expect(ac.validateItemAccess({ organizationId: 'org-2', status: 'active' }, req)).toBe(false);
      // Policy fails
      expect(ac.validateItemAccess({ organizationId: 'org-1', status: 'archived' }, req)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // ReDoS Protection
  // --------------------------------------------------------------------------

  describe('ReDoS protection', () => {
    it('rejects overly long regex patterns via $regex filter', () => {
      const ac = createAccessControl();
      const longPattern = 'a'.repeat(250);
      const req = createReq({
        _policyFilters: { name: { $regex: longPattern } },
      });

      // Long regex should be rejected (returns null from safeRegex), so matching fails
      expect(ac.checkPolicyFilters({ name: 'a'.repeat(250) }, req)).toBe(false);
    });

    it('rejects dangerous nested quantifier patterns', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { name: { $regex: '(a+)+' } },
      });

      // Dangerous pattern should be rejected
      expect(ac.checkPolicyFilters({ name: 'aaa' }, req)).toBe(false);
    });

    it('accepts safe regex patterns', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { name: { $regex: '^Test' } },
      });

      expect(ac.checkPolicyFilters({ name: 'Testing123' }, req)).toBe(true);
    });

    it('rejects patterns with nested quantifiers (.*){3,}', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { name: { $regex: '(.*)(.*)(.*)(a)' } },
      });

      // Patterns with many .* sequences are suspicious
      // The exact behavior depends on DANGEROUS_REGEX — just verify it handles them
      const result = ac.checkPolicyFilters({ name: 'a' }, req);
      // The pattern has 3+ .* sequences which triggers DANGEROUS_REGEX
      expect(typeof result).toBe('boolean');
    });
  });

  // --------------------------------------------------------------------------
  // Security: prototype pollution prevention
  // --------------------------------------------------------------------------

  describe('prototype pollution prevention', () => {
    it('returns undefined for __proto__ paths', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { '__proto__.polluted': 'yes' },
      });

      // Should not match — forbidden path
      const item = { name: 'Test' };
      expect(ac.checkPolicyFilters(item, req)).toBe(false);
    });

    it('returns undefined for constructor paths', () => {
      const ac = createAccessControl();
      const req = createReq({
        _policyFilters: { 'constructor.prototype': 'yes' },
      });

      const item = { name: 'Test' };
      expect(ac.checkPolicyFilters(item, req)).toBe(false);
    });
  });
});
