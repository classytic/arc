/**
 * Audit Trail Tests
 *
 * Comprehensive tests for audit entry creation, change detection,
 * memory store, and query interface.
 */

import { describe, it, expect } from 'vitest';

describe('Audit Trail', () => {
  // ==========================================================================
  // createAuditEntry
  // ==========================================================================

  describe('createAuditEntry', () => {
    it('should create entry with before/after snapshots', async () => {
      const { createAuditEntry } = await import('../../src/audit/stores/interface.js');

      const entry = createAuditEntry('product', 'prod-1', 'update', {
        user: { _id: 'u1' },
        organizationId: 'org-1',
        requestId: 'req-1',
        ipAddress: '1.2.3.4',
      }, {
        before: { name: 'Old Name', price: 10 },
        after: { name: 'New Name', price: 10 },
      });

      expect(entry.resource).toBe('product');
      expect(entry.documentId).toBe('prod-1');
      expect(entry.action).toBe('update');
      expect(entry.userId).toBe('u1');
      expect(entry.organizationId).toBe('org-1');
      expect(entry.before).toEqual({ name: 'Old Name', price: 10 });
      expect(entry.after).toEqual({ name: 'New Name', price: 10 });
      expect(entry.changes).toEqual(['name']); // price unchanged
      expect(entry.id).toMatch(/^aud_/);
      expect(entry.timestamp).toBeInstanceOf(Date);
    });

    it('should detect multiple changed fields', async () => {
      const { createAuditEntry } = await import('../../src/audit/stores/interface.js');

      const entry = createAuditEntry('product', 'prod-1', 'update', { user: { _id: 'u1' } }, {
        before: { name: 'A', price: 10, status: 'draft' },
        after: { name: 'B', price: 20, status: 'draft' },
      });

      expect(entry.changes).toContain('name');
      expect(entry.changes).toContain('price');
      expect(entry.changes).not.toContain('status');
    });

    it('should handle create action (no before)', async () => {
      const { createAuditEntry } = await import('../../src/audit/stores/interface.js');

      const entry = createAuditEntry('product', 'prod-1', 'create', { user: { _id: 'u1' } }, {
        after: { name: 'New', price: 10 },
      });

      expect(entry.action).toBe('create');
      expect(entry.before).toBeUndefined();
      expect(entry.after).toEqual({ name: 'New', price: 10 });
    });

    it('should handle delete action (no after)', async () => {
      const { createAuditEntry } = await import('../../src/audit/stores/interface.js');

      const entry = createAuditEntry('product', 'prod-1', 'delete', { user: { _id: 'u1' } }, {
        before: { name: 'Deleted', price: 10 },
      });

      expect(entry.action).toBe('delete');
      expect(entry.before).toBeDefined();
      expect(entry.after).toBeUndefined();
    });

    it('should include custom metadata', async () => {
      const { createAuditEntry } = await import('../../src/audit/stores/interface.js');

      const entry = createAuditEntry('product', 'prod-1', 'update', { user: { _id: 'u1' } }, {
        metadata: { reason: 'price correction', approvedBy: 'admin' },
      });

      expect(entry.metadata).toEqual({ reason: 'price correction', approvedBy: 'admin' });
    });
  });

  // ==========================================================================
  // MemoryAuditStore
  // ==========================================================================

  describe('MemoryAuditStore', () => {
    it('should store and query audit entries', async () => {
      const { MemoryAuditStore, createAuditEntry } = await import('../../src/audit/stores/index.js');

      const store = new MemoryAuditStore();

      const entry = createAuditEntry('product', 'prod-1', 'create', {
        user: { _id: 'u1' },
        organizationId: 'org-1',
      });

      await store.log(entry);

      const results = await store.query!({ resource: 'product' });
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe('prod-1');
    });

    it('should filter by documentId', async () => {
      const { MemoryAuditStore, createAuditEntry } = await import('../../src/audit/stores/index.js');

      const store = new MemoryAuditStore();

      await store.log(createAuditEntry('product', 'prod-1', 'create', { user: { _id: 'u1' } }));
      await store.log(createAuditEntry('product', 'prod-2', 'create', { user: { _id: 'u1' } }));

      const results = await store.query!({ documentId: 'prod-1' });
      expect(results).toHaveLength(1);
    });

    it('should filter by userId', async () => {
      const { MemoryAuditStore, createAuditEntry } = await import('../../src/audit/stores/index.js');

      const store = new MemoryAuditStore();

      await store.log(createAuditEntry('product', 'prod-1', 'create', { user: { _id: 'u1' } }));
      await store.log(createAuditEntry('product', 'prod-2', 'create', { user: { _id: 'u2' } }));

      const results = await store.query!({ userId: 'u2' });
      expect(results).toHaveLength(1);
    });

    it('should filter by action', async () => {
      const { MemoryAuditStore, createAuditEntry } = await import('../../src/audit/stores/index.js');

      const store = new MemoryAuditStore();

      await store.log(createAuditEntry('product', 'prod-1', 'create', { user: { _id: 'u1' } }));
      await store.log(createAuditEntry('product', 'prod-1', 'update', { user: { _id: 'u1' } }));
      await store.log(createAuditEntry('product', 'prod-1', 'delete', { user: { _id: 'u1' } }));

      const results = await store.query!({ action: 'update' });
      expect(results).toHaveLength(1);
    });

    it('should respect limit', async () => {
      const { MemoryAuditStore, createAuditEntry } = await import('../../src/audit/stores/index.js');

      const store = new MemoryAuditStore();

      for (let i = 0; i < 10; i++) {
        await store.log(createAuditEntry('product', `prod-${i}`, 'create', { user: { _id: 'u1' } }));
      }

      const results = await store.query!({ limit: 3 });
      expect(results).toHaveLength(3);
    });
  });
});
