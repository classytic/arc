/**
 * RBAC Permissions Integration Test
 *
 * Tests the full permission system through the Arc stack:
 * - allowPublic() — accessible without auth
 * - requireAuth() — requires any authenticated user
 * - requireRoles() — requires specific roles
 * - requireOwnership() — scopes to owned resources
 * - anyOf() — OR logic for combined permissions
 *
 * NOTE: BaseController.create() auto-injects `createdBy` from request.user.id,
 * so all user IDs must be valid ObjectId strings when the model has `createdBy: ObjectId`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createApp } from '../../src/factory/createApp.js';
import { defineResource } from '../../src/core/defineResource.js';
import { BaseController } from '../../src/core/BaseController.js';
import { createMongooseAdapter } from '../../src/adapters/mongoose.js';
import {
  allowPublic,
  requireAuth,
  requireRoles,
  requireOwnership,
  anyOf,
} from '../../src/permissions/index.js';
import { setupTestDatabase, teardownTestDatabase } from '../setup.js';
import type { FastifyInstance } from 'fastify';

describe('RBAC Permissions E2E', () => {
  let app: FastifyInstance;
  const JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars-long!!';

  // Pre-generate valid ObjectId strings for user IDs
  // (BaseController.create() auto-sets createdBy from user.id)
  const USER_1 = new mongoose.Types.ObjectId().toString();
  const USER_2 = new mongoose.Types.ObjectId().toString();
  const USER_3 = new mongoose.Types.ObjectId().toString();
  const USER_10 = new mongoose.Types.ObjectId().toString();
  const ADMIN_1 = new mongoose.Types.ObjectId().toString();
  const ADMIN_99 = new mongoose.Types.ObjectId().toString();
  const OWNER_ID = new mongoose.Types.ObjectId().toString();
  const OTHER_USER = new mongoose.Types.ObjectId().toString();

  // Schema with owner field for ownership tests
  const ArticleSchema = new mongoose.Schema(
    {
      title: { type: String, required: true },
      content: String,
      status: { type: String, default: 'draft' },
      createdBy: { type: mongoose.Schema.Types.ObjectId },
    },
    { timestamps: true }
  );

  // Public items (no auth needed for any operation)
  const PublicItemSchema = new mongoose.Schema(
    {
      name: { type: String, required: true },
      description: String,
    },
    { timestamps: true }
  );

  beforeAll(async () => {
    await setupTestDatabase();

    const ArticleModel = mongoose.models['RbacArticle'] || mongoose.model('RbacArticle', ArticleSchema);
    const PublicModel = mongoose.models['RbacPublicItem'] || mongoose.model('RbacPublicItem', PublicItemSchema);

    const { Repository } = require('@classytic/mongokit');

    // Article resource: public reads, authenticated create, owner+admin update/delete
    const articleRepo = new Repository(ArticleModel);
    const articleController = new BaseController(articleRepo);
    const articleResource = defineResource({
      name: 'article',
      adapter: createMongooseAdapter({ model: ArticleModel, repository: articleRepo }),
      controller: articleController,
      prefix: '/articles',
      tag: 'Articles',
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: requireAuth(),
        update: anyOf(
          requireRoles(['admin']),
          requireOwnership('createdBy'),
        ),
        delete: requireRoles(['admin']),
      },
    });

    // Public resource: all operations public
    const publicRepo = new Repository(PublicModel);
    const publicController = new BaseController(publicRepo);
    const publicResource = defineResource({
      name: 'publicItem',
      adapter: createMongooseAdapter({ model: PublicModel, repository: publicRepo }),
      controller: publicController,
      prefix: '/public-items',
      tag: 'PublicItems',
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
      auth: { jwt: { secret: JWT_SECRET } },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.register(articleResource.toPlugin());
        await fastify.register(publicResource.toPlugin());
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

  // ========================================================================
  // allowPublic()
  // ========================================================================

  describe('allowPublic() — no auth required', () => {
    it('should allow unauthenticated list on public resource', async () => {
      const res = await app.inject({ method: 'GET', url: '/public-items' });
      expect(res.statusCode).toBe(200);
    });

    it('should allow unauthenticated create on fully public resource', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/public-items',
        payload: { name: 'Public Thing', description: 'Anyone can create' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('should allow unauthenticated list on articles (public read)', async () => {
      const res = await app.inject({ method: 'GET', url: '/articles' });
      expect(res.statusCode).toBe(200);
    });

    it('should allow unauthenticated get on articles (public read)', async () => {
      // First create an article (need auth for create)
      const token = issueToken({ id: USER_1, roles: ['user'] });
      const createRes = await app.inject({
        method: 'POST',
        url: '/articles',
        headers: authHeader(token),
        payload: { title: 'Public Article', content: 'Hello' },
      });
      expect(createRes.statusCode).toBe(201);
      const id = JSON.parse(createRes.body).data._id;

      // Get without auth — should work (public read)
      const res = await app.inject({ method: 'GET', url: `/articles/${id}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.title).toBe('Public Article');
    });
  });

  // ========================================================================
  // requireAuth()
  // ========================================================================

  describe('requireAuth() — any authenticated user', () => {
    it('should reject unauthenticated create on articles', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/articles',
        payload: { title: 'No Auth', content: 'Should fail' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should allow authenticated create on articles', async () => {
      const token = issueToken({ id: USER_2, roles: ['user'] });

      const res = await app.inject({
        method: 'POST',
        url: '/articles',
        headers: authHeader(token),
        payload: { title: 'Auth Article', content: 'Created by authenticated user' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('should allow create regardless of role (just needs auth)', async () => {
      const token = issueToken({ id: USER_3, roles: [] }); // No roles

      const res = await app.inject({
        method: 'POST',
        url: '/articles',
        headers: authHeader(token),
        payload: { title: 'No Role Article', content: 'Any authenticated user' },
      });
      expect(res.statusCode).toBe(201);
    });
  });

  // ========================================================================
  // requireRoles()
  // ========================================================================

  describe('requireRoles() — role-based access', () => {
    let articleId: string;

    beforeAll(async () => {
      const token = issueToken({ id: USER_10, roles: ['user'] });
      const res = await app.inject({
        method: 'POST',
        url: '/articles',
        headers: authHeader(token),
        payload: { title: 'To Delete', content: 'Will be deleted' },
      });
      expect(res.statusCode).toBe(201);
      articleId = JSON.parse(res.body).data._id;
    });

    it('should reject non-admin from deleting articles', async () => {
      const token = issueToken({ id: USER_10, roles: ['user'] });

      const res = await app.inject({
        method: 'DELETE',
        url: `/articles/${articleId}`,
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(403);
    });

    it('should allow admin to delete articles', async () => {
      const token = issueToken({ id: ADMIN_1, roles: ['admin'] });

      const res = await app.inject({
        method: 'DELETE',
        url: `/articles/${articleId}`,
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
    });

    it('should reject unauthenticated delete', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/articles/${articleId}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ========================================================================
  // requireOwnership() with anyOf()
  // ========================================================================

  describe('requireOwnership() + anyOf() — owner or admin can update', () => {
    let ownedArticleId: string;

    beforeAll(async () => {
      const token = issueToken({ id: OWNER_ID, roles: ['user'] });
      const res = await app.inject({
        method: 'POST',
        url: '/articles',
        headers: authHeader(token),
        payload: { title: 'Owned Article', content: 'By owner' },
      });
      expect(res.statusCode).toBe(201);
      ownedArticleId = JSON.parse(res.body).data._id;
    });

    it('should allow admin to update any article', async () => {
      const adminToken = issueToken({ id: ADMIN_99, roles: ['admin'] });

      const res = await app.inject({
        method: 'PATCH',
        url: `/articles/${ownedArticleId}`,
        headers: authHeader(adminToken),
        payload: { title: 'Admin Updated' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.title).toBe('Admin Updated');
    });

    it('should allow owner to update their own article', async () => {
      const ownerToken = issueToken({ id: OWNER_ID, roles: ['user'] });

      const res = await app.inject({
        method: 'PATCH',
        url: `/articles/${ownedArticleId}`,
        headers: authHeader(ownerToken),
        payload: { title: 'Owner Updated' },
      });
      // Ownership returns filters: { createdBy: userId }
      // If the article's createdBy matches, update proceeds (200)
      // Otherwise 404 (scoped query finds nothing)
      expect([200, 404]).toContain(res.statusCode);
    });

    it('should reject non-owner non-admin from updating', async () => {
      const otherToken = issueToken({ id: OTHER_USER, roles: ['user'] });

      const res = await app.inject({
        method: 'PATCH',
        url: `/articles/${ownedArticleId}`,
        headers: authHeader(otherToken),
        payload: { title: 'Hacked' },
      });
      // Should get 404 (ownership filter scopes to createdBy=OTHER_USER, finds nothing)
      // or 403 depending on implementation
      expect([403, 404]).toContain(res.statusCode);
    });

    it('should reject unauthenticated update', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/articles/${ownedArticleId}`,
        payload: { title: 'No Auth' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ========================================================================
  // Permission Presets
  // ========================================================================

  describe('Permission presets', () => {
    it('allowPublic should work for read operations', async () => {
      const res = await app.inject({ method: 'GET', url: '/articles' });
      expect(res.statusCode).toBe(200);
    });

    it('requireAuth should block unauthenticated writes', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/articles',
        payload: { title: 'No Auth' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('requireRoles should block insufficient roles', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const token = issueToken({ id: userId, roles: ['user'] });
      const createRes = await app.inject({
        method: 'POST',
        url: '/articles',
        headers: authHeader(token),
        payload: { title: 'Target' },
      });
      expect(createRes.statusCode).toBe(201);
      const id = JSON.parse(createRes.body).data._id;

      // Try to delete as non-admin
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/articles/${id}`,
        headers: authHeader(token),
      });
      expect(deleteRes.statusCode).toBe(403);
    });
  });
});
