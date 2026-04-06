/**
 * Auto-Audit Tests
 *
 * Tests the autoAudit option in auditPlugin that automatically logs
 * CRUD operations via the hook system without manual audit calls.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { arcCorePlugin } from '../../src/core/arcCorePlugin.js';
import { auditPlugin } from '../../src/audit/auditPlugin.js';
import { MemoryAuditStore } from '../../src/audit/stores/memory.js';
import { HookSystem } from '../../src/hooks/HookSystem.js';

describe('Auto-Audit via Hook System', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it('auto-logs create operations', async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });

    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: true,
    });

    await app.ready();

    await hookSystem.executeAfter('product', 'create', { _id: 'p1', name: 'Widget' });

    // Allow async audit logging to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = store.getAll();
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const createEntry = entries.find(
      (e) => e.action === 'create' && e.resource === 'product',
    );
    expect(createEntry).toBeDefined();
    expect(createEntry!.documentId).toBe('p1');
  });

  it('auto-logs update operations with before/after', async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });

    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: true,
    });

    await app.ready();

    await hookSystem.executeAfter(
      'product',
      'update',
      { _id: 'p1', name: 'New Name' },
      { meta: { existing: { _id: 'p1', name: 'Old' } } },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = store.getAll();
    const updateEntry = entries.find(
      (e) => e.action === 'update' && e.resource === 'product',
    );
    expect(updateEntry).toBeDefined();
    expect(updateEntry!.documentId).toBe('p1');
  });

  it('auto-logs delete operations', async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });

    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: true,
    });

    await app.ready();

    await hookSystem.executeAfter('product', 'delete', { _id: 'p1' });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = store.getAll();
    const deleteEntry = entries.find(
      (e) => e.action === 'delete' && e.resource === 'product',
    );
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry!.documentId).toBe('p1');
  });

  it('excludes resources listed in autoAudit.exclude', async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });

    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: { exclude: ['health'] },
    });

    await app.ready();

    await hookSystem.executeAfter('health', 'create', { _id: 'h1', status: 'ok' });
    await hookSystem.executeAfter('product', 'create', { _id: 'p1', name: 'Widget' });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = store.getAll();
    const healthEntries = entries.filter((e) => e.resource === 'health');
    const productEntries = entries.filter((e) => e.resource === 'product');

    expect(healthEntries.length).toBe(0);
    expect(productEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('only audits specified operations', async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });

    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: { operations: ['delete'] },
    });

    await app.ready();

    await hookSystem.executeAfter('product', 'create', { _id: 'p1', name: 'Widget' });
    await hookSystem.executeAfter('product', 'delete', { _id: 'p2' });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = store.getAll();
    const createEntries = entries.filter((e) => e.action === 'create');
    const deleteEntries = entries.filter((e) => e.action === 'delete');

    expect(createEntries.length).toBe(0);
    expect(deleteEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('does not audit when autoAudit is false', async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });

    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: false,
    });

    await app.ready();

    await hookSystem.executeAfter('product', 'create', { _id: 'p1', name: 'Widget' });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = store.getAll();
    expect(entries.length).toBe(0);
  });

  it('captures user and org context from hook scope', async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });

    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: true,
    });

    await app.ready();

    // Simulate hook with user + org scope (same as MCP or REST would provide)
    await hookSystem.executeAfter(
      'order',
      'create',
      { _id: 'o1', total: 99 },
      {
        user: { _id: 'user-abc', role: 'editor' },
        context: { _scope: { kind: 'member', organizationId: 'org-xyz' } } as Record<string, unknown>,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = store.getAll();
    const entry = entries.find((e) => e.resource === 'order');
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe('user-abc');
    expect(entry!.organizationId).toBe('org-xyz');
  });

  it('handles custom action via manual fastify.audit.custom()', async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });

    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: false,
    });

    await app.ready();

    // Simulate manual audit from an additionalRoute with wrapHandler: false
    await (app as unknown as { audit: { custom: (...args: unknown[]) => Promise<void> } }).audit.custom(
      'invoice',
      'inv-1',
      'export_pdf',
      { format: 'A4' },
      { user: { _id: 'u1' }, organizationId: 'org-1' },
    );

    const entries = store.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].resource).toBe('invoice');
    expect(entries[0].action).toBe('custom');
    expect(entries[0].documentId).toBe('inv-1');
    expect(entries[0].userId).toBe('u1');
    expect(entries[0].organizationId).toBe('org-1');
  });

  it('auto-audits wrapHandler: true routes that call controller methods (via hooks)', async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });

    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: true,
    });

    await app.ready();

    // When a wrapHandler: true additional route calls controller.update(),
    // the BaseController triggers hooks.executeAfter('resource', 'update', result, { meta: { existing } })
    // This simulates that call path:
    await hookSystem.executeAfter(
      'product',
      'update',
      { _id: 'p1', name: 'Approved', status: 'approved' },
      {
        user: { _id: 'admin-1' },
        context: { _scope: { kind: 'authenticated' } } as Record<string, unknown>,
        meta: { existing: { _id: 'p1', name: 'Pending', status: 'pending' } },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = store.getAll();
    const entry = entries.find((e) => e.action === 'update' && e.resource === 'product');
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe('admin-1');
    expect(entry!.changes).toContain('name');
    expect(entry!.changes).toContain('status');
  });

  it('auto-audit is no-op when plugin disabled', async () => {
    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, { enabled: false });
    await app.ready();

    // fastify.audit should still exist (no-op logger)
    const audit = (app as unknown as { audit: Record<string, (...args: unknown[]) => Promise<void>> }).audit;
    expect(audit).toBeDefined();
    // Should not throw
    await audit.create('r', '1', {});
    await audit.update('r', '1', {}, {});
    await audit.delete('r', '1', {});
    await audit.custom('r', '1', 'test');
  });
});
