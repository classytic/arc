/**
 * Multi-Tenant & Single-Tenant E2E Tests
 *
 * Tests real data isolation through the full Arc stack:
 *
 * Multi-tenant mode (with multiTenantPreset):
 * - Org-A creates items → organizationId auto-injected
 * - Org-A list → only sees org-A items
 * - Org-B list → only sees org-B items
 * - Org-A get org-B's item by ID → 404 (isolated)
 * - Superadmin list → sees all items (bypass)
 * - No org context → 403
 * - Unauthenticated → 401
 * - Update/delete scoped to org
 *
 * Single-tenant mode (no multiTenantPreset):
 * - All items visible to all authenticated users
 * - No org filtering applied
 *
 * Flexible multi-tenant (allowPublic):
 * - Unauthenticated list → sees all (public, no filtering)
 * - Authenticated list with org → sees only org items
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createApp } from '../../src/factory/createApp.js';
import { defineResource } from '../../src/core/defineResource.js';
import { BaseController } from '../../src/core/BaseController.js';
import { createMongooseAdapter } from '../../src/adapters/mongoose.js';
import { requireAuth, allowPublic } from '../../src/permissions/index.js';
import { multiTenantPreset } from '../../src/presets/multiTenant.js';
import { applyPresets } from '../../src/presets/index.js';
import { setupTestDatabase, teardownTestDatabase } from '../setup.js';
import type { FastifyInstance } from 'fastify';

const JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars-long!!';

// Pre-generate valid ObjectIds
const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();
const USER_A1 = new mongoose.Types.ObjectId().toString();
const USER_A2 = new mongoose.Types.ObjectId().toString();
const USER_B1 = new mongoose.Types.ObjectId().toString();
const SUPERADMIN = new mongoose.Types.ObjectId().toString();
const USER_NO_ORG = new mongoose.Types.ObjectId().toString();

// ============================================================================
// Multi-Tenant E2E
// ============================================================================

describe('Multi-Tenant E2E (data isolation)', () => {
  let app: FastifyInstance;

  const InvoiceSchema = new mongoose.Schema(
    {
      title: { type: String, required: true },
      amount: { type: Number, required: true },
      organizationId: { type: mongoose.Schema.Types.ObjectId, index: true },
      createdBy: { type: mongoose.Schema.Types.ObjectId },
    },
    { timestamps: true }
  );

  beforeAll(async () => {
    await setupTestDatabase();

    const InvoiceModel = mongoose.models['MTInvoice'] || mongoose.model('MTInvoice', InvoiceSchema);
    const { Repository } = require('@classytic/mongokit');
    const repo = new Repository(InvoiceModel);
    const ctrl = new BaseController(repo);

    // Apply multiTenant preset
    const resourceConfig = {
      name: 'invoice',
      adapter: createMongooseAdapter({ model: InvoiceModel, repository: repo }),
      controller: ctrl,
      prefix: '/invoices',
      tag: 'Invoices',
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: requireAuth(),
        update: requireAuth(),
        delete: requireAuth(),
      },
    };

    // Apply the preset to get middlewares
    const preset = multiTenantPreset({ bypassRoles: ['superadmin'] });
    const withPreset = {
      ...resourceConfig,
      middlewares: preset.middlewares,
    };

    const resource = defineResource(withPreset);

    app = await createApp({
      preset: 'development',
      auth: { jwt: { secret: JWT_SECRET } },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.register(resource.toPlugin());
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  function issueToken(payload: Record<string, unknown>) {
    return app.auth.issueTokens(payload).accessToken;
  }

  function authHeader(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  // --------------------------------------------------------------------------
  // Create with org injection
  // --------------------------------------------------------------------------

  describe('Create — organizationId auto-injection', () => {
    it('should inject organizationId from user context on create', async () => {
      const token = issueToken({ id: USER_A1, roles: ['user'], organizationId: ORG_A });

      const res = await app.inject({
        method: 'POST',
        url: '/invoices',
        headers: authHeader(token),
        payload: { title: 'Invoice A-1', amount: 100 },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.title).toBe('Invoice A-1');
      expect(body.data.organizationId).toBe(ORG_A);
    });

    it('should reject create without org context', async () => {
      const token = issueToken({ id: USER_NO_ORG, roles: ['user'] }); // No organizationId

      const res = await app.inject({
        method: 'POST',
        url: '/invoices',
        headers: authHeader(token),
        payload: { title: 'Orphan Invoice', amount: 50 },
      });

      // multiTenant injection middleware → 403 (org required)
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('Organization context required');
    });
  });

  // --------------------------------------------------------------------------
  // Seed data for isolation tests
  // --------------------------------------------------------------------------

  describe('Data isolation', () => {
    beforeAll(async () => {
      // Create 3 invoices for Org-A
      const tokenA = issueToken({ id: USER_A1, roles: ['user'], organizationId: ORG_A });
      for (const inv of [
        { title: 'Org-A Invoice 1', amount: 100 },
        { title: 'Org-A Invoice 2', amount: 200 },
        { title: 'Org-A Invoice 3', amount: 300 },
      ]) {
        await app.inject({
          method: 'POST',
          url: '/invoices',
          headers: authHeader(tokenA),
          payload: inv,
        });
      }

      // Create 2 invoices for Org-B
      const tokenB = issueToken({ id: USER_B1, roles: ['user'], organizationId: ORG_B });
      for (const inv of [
        { title: 'Org-B Invoice 1', amount: 500 },
        { title: 'Org-B Invoice 2', amount: 600 },
      ]) {
        await app.inject({
          method: 'POST',
          url: '/invoices',
          headers: authHeader(tokenB),
          payload: inv,
        });
      }
    });

    it('Org-A user should only see Org-A invoices', async () => {
      const token = issueToken({ id: USER_A1, roles: ['user'], organizationId: ORG_A });

      const res = await app.inject({
        method: 'GET',
        url: '/invoices',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // 3 seeded + 1 from the create test above = 4
      expect(body.docs.length).toBe(4);
      body.docs.forEach((d: any) => {
        expect(d.organizationId).toBe(ORG_A);
      });
    });

    it('Org-B user should only see Org-B invoices', async () => {
      const token = issueToken({ id: USER_B1, roles: ['user'], organizationId: ORG_B });

      const res = await app.inject({
        method: 'GET',
        url: '/invoices',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.docs.length).toBe(2);
      body.docs.forEach((d: any) => {
        expect(d.organizationId).toBe(ORG_B);
      });
    });

    it('different user in same org should see same org data', async () => {
      const token = issueToken({ id: USER_A2, roles: ['user'], organizationId: ORG_A });

      const res = await app.inject({
        method: 'GET',
        url: '/invoices',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.docs.length).toBe(4);
    });

    it('Org-A user cannot get Org-B invoice by ID (cross-tenant)', async () => {
      // First get an Org-B invoice ID
      const tokenB = issueToken({ id: USER_B1, roles: ['user'], organizationId: ORG_B });
      const listRes = await app.inject({
        method: 'GET',
        url: '/invoices',
        headers: authHeader(tokenB),
      });
      const orgBInvoiceId = JSON.parse(listRes.body).docs[0]._id;

      // Try to access it as Org-A user
      const tokenA = issueToken({ id: USER_A1, roles: ['user'], organizationId: ORG_A });
      const getRes = await app.inject({
        method: 'GET',
        url: `/invoices/${orgBInvoiceId}`,
        headers: authHeader(tokenA),
      });

      // Should be 404 — policy filter scopes query to ORG_A, so ORG_B's item not found
      expect(getRes.statusCode).toBe(404);
    });

    it('Org-A user cannot update Org-B invoice (cross-tenant)', async () => {
      // Get Org-B invoice ID
      const tokenB = issueToken({ id: USER_B1, roles: ['user'], organizationId: ORG_B });
      const listRes = await app.inject({
        method: 'GET',
        url: '/invoices',
        headers: authHeader(tokenB),
      });
      const orgBInvoiceId = JSON.parse(listRes.body).docs[0]._id;

      // Try to update as Org-A
      const tokenA = issueToken({ id: USER_A1, roles: ['user'], organizationId: ORG_A });
      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/invoices/${orgBInvoiceId}`,
        headers: authHeader(tokenA),
        payload: { title: 'Hacked by Org-A' },
      });

      expect(updateRes.statusCode).toBe(404);
    });

    it('Org-A user cannot delete Org-B invoice (cross-tenant)', async () => {
      const tokenB = issueToken({ id: USER_B1, roles: ['user'], organizationId: ORG_B });
      const listRes = await app.inject({
        method: 'GET',
        url: '/invoices',
        headers: authHeader(tokenB),
      });
      const orgBInvoiceId = JSON.parse(listRes.body).docs[0]._id;

      const tokenA = issueToken({ id: USER_A1, roles: ['user'], organizationId: ORG_A });
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/invoices/${orgBInvoiceId}`,
        headers: authHeader(tokenA),
      });

      expect(deleteRes.statusCode).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // Superadmin bypass
  // --------------------------------------------------------------------------

  describe('Superadmin bypass', () => {
    it('superadmin should see ALL invoices across orgs', async () => {
      const token = issueToken({ id: SUPERADMIN, roles: ['superadmin'], organizationId: ORG_A });

      const res = await app.inject({
        method: 'GET',
        url: '/invoices',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // 4 Org-A + 2 Org-B = 6 total
      expect(body.docs.length).toBe(6);
    });

    it('superadmin should get any invoice regardless of org', async () => {
      // Get Org-B invoice
      const tokenB = issueToken({ id: USER_B1, roles: ['user'], organizationId: ORG_B });
      const listRes = await app.inject({
        method: 'GET',
        url: '/invoices',
        headers: authHeader(tokenB),
      });
      const orgBInvoiceId = JSON.parse(listRes.body).docs[0]._id;

      // Superadmin can access it
      const adminToken = issueToken({ id: SUPERADMIN, roles: ['superadmin'] });
      const getRes = await app.inject({
        method: 'GET',
        url: `/invoices/${orgBInvoiceId}`,
        headers: authHeader(adminToken),
      });

      expect(getRes.statusCode).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Auth enforcement
  // --------------------------------------------------------------------------

  describe('Auth enforcement', () => {
    it('unauthenticated request should get 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/invoices',
      });
      expect(res.statusCode).toBe(401);
    });

    it('user without org context should get 403 on list', async () => {
      const token = issueToken({ id: USER_NO_ORG, roles: ['user'] });

      const res = await app.inject({
        method: 'GET',
        url: '/invoices',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(403);
    });
  });
});

// ============================================================================
// Single-Tenant E2E (no multiTenant preset)
// ============================================================================

describe('Single-Tenant E2E (no org filtering)', () => {
  let app: FastifyInstance;

  const NoteSchema = new mongoose.Schema(
    {
      title: { type: String, required: true },
      content: String,
      createdBy: { type: mongoose.Schema.Types.ObjectId },
    },
    { timestamps: true }
  );

  beforeAll(async () => {
    await setupTestDatabase();

    const NoteModel = mongoose.models['STNote'] || mongoose.model('STNote', NoteSchema);
    const { Repository } = require('@classytic/mongokit');
    const repo = new Repository(NoteModel);
    const ctrl = new BaseController(repo);

    // NO multiTenant preset — single-tenant mode
    const resource = defineResource({
      name: 'note',
      adapter: createMongooseAdapter({ model: NoteModel, repository: repo }),
      controller: ctrl,
      prefix: '/notes',
      tag: 'Notes',
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: requireAuth(),
        update: requireAuth(),
        delete: requireAuth(),
      },
    });

    app = await createApp({
      preset: 'development',
      auth: { jwt: { secret: JWT_SECRET } },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.register(resource.toPlugin());
      },
    });

    await app.ready();

    // Seed data from different "users" (single-tenant = no org filtering)
    const token1 = app.auth.issueTokens({ id: USER_A1, roles: ['user'] }).accessToken;
    const token2 = app.auth.issueTokens({ id: USER_B1, roles: ['user'] }).accessToken;

    for (const title of ['Note by User-A1 #1', 'Note by User-A1 #2']) {
      await app.inject({
        method: 'POST',
        url: '/notes',
        headers: { authorization: `Bearer ${token1}` },
        payload: { title, content: 'Some content' },
      });
    }

    for (const title of ['Note by User-B1 #1', 'Note by User-B1 #2', 'Note by User-B1 #3']) {
      await app.inject({
        method: 'POST',
        url: '/notes',
        headers: { authorization: `Bearer ${token2}` },
        payload: { title, content: 'Some content' },
      });
    }
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it('all users should see ALL notes (no org filtering)', async () => {
    const token = app.auth.issueTokens({ id: USER_A1, roles: ['user'] }).accessToken;

    const res = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.docs.length).toBe(5); // All 5 notes visible
  });

  it('any user can get any note by ID', async () => {
    // User A creates, User B reads
    const tokenA = app.auth.issueTokens({ id: USER_A1, roles: ['user'] }).accessToken;
    const listRes = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const noteId = JSON.parse(listRes.body).docs[0]._id;

    const tokenB = app.auth.issueTokens({ id: USER_B1, roles: ['user'] }).accessToken;
    const getRes = await app.inject({
      method: 'GET',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(getRes.statusCode).toBe(200);
  });

  it('any user can update any note', async () => {
    const token = app.auth.issueTokens({ id: USER_A1, roles: ['user'] }).accessToken;
    const listRes = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: `Bearer ${token}` },
    });
    const noteId = JSON.parse(listRes.body).docs[0]._id;

    const tokenB = app.auth.issueTokens({ id: USER_B1, roles: ['user'] }).accessToken;
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { title: 'Updated by User-B1' },
    });

    expect(updateRes.statusCode).toBe(200);
    expect(JSON.parse(updateRes.body).data.title).toBe('Updated by User-B1');
  });

  it('unauthenticated users still get 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/notes' });
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================================
// Flexible Multi-Tenant (allowPublic routes)
// ============================================================================

describe('Flexible Multi-Tenant (allowPublic list/get)', () => {
  let app: FastifyInstance;

  const CatalogSchema = new mongoose.Schema(
    {
      name: { type: String, required: true },
      price: Number,
      organizationId: { type: mongoose.Schema.Types.ObjectId, index: true },
      createdBy: { type: mongoose.Schema.Types.ObjectId },
    },
    { timestamps: true }
  );

  beforeAll(async () => {
    await setupTestDatabase();

    const CatalogModel = mongoose.models['FlexCatalog'] || mongoose.model('FlexCatalog', CatalogSchema);
    const { Repository } = require('@classytic/mongokit');
    const repo = new Repository(CatalogModel);
    const ctrl = new BaseController(repo);

    // Apply multiTenant with allowPublic for list and get
    const preset = multiTenantPreset({
      bypassRoles: ['superadmin'],
      allowPublic: ['list', 'get'],
    });

    const resource = defineResource({
      name: 'catalog',
      adapter: createMongooseAdapter({ model: CatalogModel, repository: repo }),
      controller: ctrl,
      prefix: '/catalog',
      tag: 'Catalog',
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: requireAuth(),
        update: requireAuth(),
        delete: requireAuth(),
      },
      middlewares: preset.middlewares,
    });

    app = await createApp({
      preset: 'development',
      auth: { jwt: { secret: JWT_SECRET } },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.register(resource.toPlugin());
      },
    });

    await app.ready();

    // Seed: 2 items for Org-A, 1 item for Org-B
    const tokenA = app.auth.issueTokens({ id: USER_A1, roles: ['user'], organizationId: ORG_A }).accessToken;
    const tokenB = app.auth.issueTokens({ id: USER_B1, roles: ['user'], organizationId: ORG_B }).accessToken;

    await app.inject({
      method: 'POST', url: '/catalog',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Org-A Product 1', price: 10 },
    });
    await app.inject({
      method: 'POST', url: '/catalog',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Org-A Product 2', price: 20 },
    });
    await app.inject({
      method: 'POST', url: '/catalog',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: 'Org-B Product 1', price: 30 },
    });
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it('unauthenticated list should see ALL items (public, no org filter)', async () => {
    const res = await app.inject({ method: 'GET', url: '/catalog' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.docs.length).toBe(3); // All items visible
  });

  it('authenticated user WITH org context should see only their org items', async () => {
    // optionalAuthenticate parses the JWT on allowPublic() routes without requiring it.
    // This populates request.user → flexible filter extracts org → applies filter.
    const token = app.auth.issueTokens({ id: USER_A1, roles: ['user'], organizationId: ORG_A }).accessToken;

    const res = await app.inject({
      method: 'GET',
      url: '/catalog',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Only 2 Org-A items — optionalAuthenticate populated user, flexible filter applied
    expect(body.docs.length).toBe(2);
    body.docs.forEach((d: any) => {
      expect(d.organizationId).toBe(ORG_A);
    });
  });

  it('authenticated user WITHOUT org context on allowPublic route sees ALL items', async () => {
    // User has valid JWT but no organizationId — flexible filter passes through (public data)
    const token = app.auth.issueTokens({ id: USER_NO_ORG, roles: ['user'] }).accessToken;

    const res = await app.inject({
      method: 'GET',
      url: '/catalog',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // All 3 items visible — user is authenticated but has no org, so no filtering
    expect(body.docs.length).toBe(3);
  });

  it('unauthenticated get by ID should work (public)', async () => {
    // Get an ID first
    const listRes = await app.inject({ method: 'GET', url: '/catalog' });
    const itemId = JSON.parse(listRes.body).docs[0]._id;

    const getRes = await app.inject({ method: 'GET', url: `/catalog/${itemId}` });
    expect(getRes.statusCode).toBe(200);
  });

  it('create still requires auth + org context', async () => {
    // No auth → 401
    const noAuthRes = await app.inject({
      method: 'POST', url: '/catalog',
      payload: { name: 'Sneaky', price: 999 },
    });
    expect(noAuthRes.statusCode).toBe(401);

    // Auth but no org → 403 (tenant injection requires org)
    const noOrgToken = app.auth.issueTokens({ id: USER_NO_ORG, roles: ['user'] }).accessToken;
    const noOrgRes = await app.inject({
      method: 'POST', url: '/catalog',
      headers: { authorization: `Bearer ${noOrgToken}` },
      payload: { name: 'Orphan', price: 1 },
    });
    expect(noOrgRes.statusCode).toBe(403);
  });
});
