/**
 * Real-world consumer test for @classytic/arc
 *
 * Verifies that an external app installing arc via `file:` against the
 * built dist can use loadResources(), createApp, audit, and CRUD endpoints.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp, loadResources } from '@classytic/arc/factory';
import { auditPlugin, MemoryAuditStore } from '@classytic/arc/audit';

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  console.log('[ok] mongo connected');

  const auditStore = new MemoryAuditStore();

  // Auto-discover all *.resource.ts in ./src/resources/**
  const resources = await loadResources(import.meta.url);
  console.log(`[ok] loadResources discovered ${resources.length} resources:`,
    resources.map((r) => r.name));

  if (resources.length === 0) {
    throw new Error('FAIL: loadResources discovered 0 resources');
  }

  const app = await createApp({
    preset: 'testing',
    auth: false,
    resourcePrefix: '/api/v1',
    resources,
    plugins: async (fastify) => {
      await fastify.register(auditPlugin, {
        enabled: true,
        stores: [],
        customStores: [auditStore],
        autoAudit: { perResource: true },
      });
    },
  });

  await app.ready();
  console.log('[ok] app ready');

  // Verify routes exist
  // Product (audit: true) — should be under /api/v1/products
  const create = await app.inject({
    method: 'POST',
    url: '/api/v1/products',
    payload: { name: 'Test Widget', price: 99 },
  });
  if (create.statusCode !== 201) {
    throw new Error(`FAIL: POST /api/v1/products → ${create.statusCode} ${create.body}`);
  }
  console.log('[ok] POST /api/v1/products → 201');

  const id = create.json().data._id;

  const list = await app.inject({ method: 'GET', url: '/api/v1/products' });
  if (list.statusCode !== 200) {
    throw new Error(`FAIL: GET /api/v1/products → ${list.statusCode}`);
  }
  console.log(`[ok] GET /api/v1/products → 200, ${list.json().docs.length} item(s)`);

  // Webhook (skipGlobalPrefix: true) — should be at root /hooks
  const hookList = await app.inject({ method: 'GET', url: '/hooks' });
  if (hookList.statusCode !== 200) {
    throw new Error(`FAIL: GET /hooks → ${hookList.statusCode}`);
  }
  console.log('[ok] GET /hooks → 200 (skipGlobalPrefix works)');

  // Webhook should NOT be under prefix
  const wrongPath = await app.inject({ method: 'GET', url: '/api/v1/hooks' });
  if (wrongPath.statusCode !== 404) {
    throw new Error(`FAIL: /api/v1/hooks should be 404 but was ${wrongPath.statusCode}`);
  }
  console.log('[ok] GET /api/v1/hooks → 404 (correctly not prefixed)');

  // Wait for audit hook to fire
  await new Promise((r) => setTimeout(r, 100));

  // Check audit was logged for product (audit: true) but NOT for order (no audit flag)
  const orderCreate = await app.inject({
    method: 'POST',
    url: '/api/v1/orders',
    payload: { item: 'pizza', total: 25 },
  });
  if (orderCreate.statusCode !== 201) {
    throw new Error(`FAIL: POST /api/v1/orders → ${orderCreate.statusCode}`);
  }
  console.log('[ok] POST /api/v1/orders → 201');

  await new Promise((r) => setTimeout(r, 100));

  const auditEntries = auditStore.getAll();
  console.log(`[ok] audit store has ${auditEntries.length} entries`);
  console.log('     entries:', auditEntries.map((e) => `${e.resource}.${e.action}`));

  // Should have product.create but NOT order.create (order has no audit flag)
  const productAudits = auditEntries.filter((e) => e.resource === 'product');
  const orderAudits = auditEntries.filter((e) => e.resource === 'order');

  if (productAudits.length !== 1) {
    throw new Error(`FAIL: expected 1 product audit, got ${productAudits.length}`);
  }
  if (orderAudits.length !== 0) {
    throw new Error(`FAIL: expected 0 order audits (no audit flag), got ${orderAudits.length}`);
  }
  console.log('[ok] per-resource audit working: product audited, order skipped');

  // Test nested query operators (price[gte]=10&price[lte]=200)
  const filtered = await app.inject({
    method: 'GET',
    url: '/api/v1/products?price[gte]=10&price[lte]=200',
  });
  if (filtered.statusCode !== 200) {
    throw new Error(`FAIL: nested query → ${filtered.statusCode} ${filtered.body}`);
  }
  console.log(`[ok] GET /api/v1/products?price[gte]=10&price[lte]=200 → 200`);

  await app.close();
  await mongoose.disconnect();
  await mongo.stop();

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ALL CHECKS PASSED — arc 2.6.2 works');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch((err) => {
  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('  CONSUMER TEST FAILED');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(err);
  process.exit(1);
});
