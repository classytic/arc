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
});
