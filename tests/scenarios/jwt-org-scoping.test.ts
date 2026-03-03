/**
 * JWT-Only Org Scoping (no Better Auth)
 *
 * Proves Arc works for users who embed organizationId in JWT tokens
 * and use multiTenantPreset for data isolation — without Better Auth.
 *
 * Run with: npx vitest run tests/scenarios/jwt-org-scoping.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createApp } from '../../src/factory/createApp.js';
import { defineResource } from '../../src/core/defineResource.js';
import { BaseController } from '../../src/core/BaseController.js';
import { createMongooseAdapter } from '../../src/adapters/mongoose.js';
import { requireAuth } from '../../src/permissions/index.js';
import { multiTenantPreset } from '../../src/presets/multiTenant.js';
import { setupTestDatabase, teardownTestDatabase } from '../setup.js';
import type { FastifyInstance } from 'fastify';

const JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars-long!!';

const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();
const USER_A = new mongoose.Types.ObjectId().toString();
const USER_B = new mongoose.Types.ObjectId().toString();
const SUPERADMIN = new mongoose.Types.ObjectId().toString();

describe('JWT-Only Org Scoping (no Better Auth)', () => {
  let app: FastifyInstance;

  const TaskSchema = new mongoose.Schema({
    title: { type: String, required: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId },
  }, { timestamps: true });

  beforeAll(async () => {
    await setupTestDatabase();

    const TaskModel = mongoose.models['JwtTask'] || mongoose.model('JwtTask', TaskSchema);
    const { Repository } = require('@classytic/mongokit');
    const repo = new Repository(TaskModel);
    const ctrl = new BaseController(repo);

    const preset = multiTenantPreset();
    const resource = defineResource({
      name: 'task',
      adapter: createMongooseAdapter({ model: TaskModel, repository: repo }),
      controller: ctrl,
      prefix: '/tasks',
      tag: 'Tasks',
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: requireAuth(),
        update: requireAuth(),
        delete: requireAuth(),
      },
      middlewares: preset.middlewares,
    });

    app = await createApp({
      preset: 'development',
      auth: {
        type: 'jwt',
        jwt: { secret: JWT_SECRET },
        authenticate: async (request, { jwt }) => {
          const auth = request.headers.authorization;
          if (!auth?.startsWith('Bearer ')) return null;
          const decoded = jwt!.verify<Record<string, unknown>>(auth.slice(7));
          if (decoded.type === 'refresh') throw new Error('Refresh tokens cannot be used for authentication');

          // Set scope based on elevation header + roles
          const wantsElevation = request.headers['x-arc-scope'] === 'platform';
          const userRoles = (decoded.role ?? []) as string[];
          if (wantsElevation && userRoles.includes('superadmin')) {
            (request as any).scope = { kind: 'elevated', elevatedBy: String(decoded.id) };
          }

          return decoded;
        },
      },
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

  function headers(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  // --------------------------------------------------------------------------
  // Token-embedded org context
  // --------------------------------------------------------------------------

  describe('Token-embedded org context', () => {
    it('should extract organizationId from JWT token claims', async () => {
      const token = issueToken({ id: USER_A, role: ['user'], organizationId: ORG_A });
      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: headers(token),
        payload: { title: 'Task from Org A' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.organizationId).toBe(ORG_A);
    });

    it('should auto-inject organizationId on create via multiTenantPreset', async () => {
      const token = issueToken({ id: USER_A, role: ['user'], organizationId: ORG_A });
      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: headers(token),
        payload: { title: 'No org in body' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      // organizationId auto-injected from token even though not in body
      expect(body.data.organizationId).toBe(ORG_A);
    });

    it('should prevent client from overriding organizationId in body', async () => {
      const token = issueToken({ id: USER_A, role: ['user'], organizationId: ORG_A });
      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: headers(token),
        payload: { title: 'Override attempt', organizationId: ORG_B },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      // multiTenantPreset overwrites body.organizationId with token claim
      expect(body.data.organizationId).toBe(ORG_A);
    });
  });

  // --------------------------------------------------------------------------
  // Data isolation
  // --------------------------------------------------------------------------

  describe('Data isolation via JWT org claims', () => {
    let orgATaskId: string;
    let orgBTaskId: string;

    beforeAll(async () => {
      // Create tasks in both orgs
      const tokenA = issueToken({ id: USER_A, role: ['user'], organizationId: ORG_A });
      const resA = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: headers(tokenA),
        payload: { title: 'Org A Task' },
      });
      orgATaskId = JSON.parse(resA.body).data._id;

      const tokenB = issueToken({ id: USER_B, role: ['user'], organizationId: ORG_B });
      const resB = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers: headers(tokenB),
        payload: { title: 'Org B Task' },
      });
      orgBTaskId = JSON.parse(resB.body).data._id;
    });

    it('Org-A user only sees Org-A records', async () => {
      const token = issueToken({ id: USER_A, role: ['user'], organizationId: ORG_A });
      const res = await app.inject({
        method: 'GET',
        url: '/tasks',
        headers: headers(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const ids = body.docs.map((d: any) => d._id);
      expect(ids).toContain(orgATaskId);
      expect(ids).not.toContain(orgBTaskId);
    });

    it('Org-B user only sees Org-B records', async () => {
      const token = issueToken({ id: USER_B, role: ['user'], organizationId: ORG_B });
      const res = await app.inject({
        method: 'GET',
        url: '/tasks',
        headers: headers(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const ids = body.docs.map((d: any) => d._id);
      expect(ids).toContain(orgBTaskId);
      expect(ids).not.toContain(orgATaskId);
    });

    it('Org-A user gets 404 for Org-B record by ID', async () => {
      const token = issueToken({ id: USER_A, role: ['user'], organizationId: ORG_A });
      const res = await app.inject({
        method: 'GET',
        url: `/tasks/${orgBTaskId}`,
        headers: headers(token),
      });

      expect(res.statusCode).toBe(404);
    });

    it('Org-A user gets 404 updating Org-B record', async () => {
      const token = issueToken({ id: USER_A, role: ['user'], organizationId: ORG_A });
      const res = await app.inject({
        method: 'PATCH',
        url: `/tasks/${orgBTaskId}`,
        headers: headers(token),
        payload: { title: 'Hacked' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // Superadmin bypass
  // --------------------------------------------------------------------------

  describe('Superadmin bypass', () => {
    it('superadmin sees all records across orgs', async () => {
      const token = issueToken({ id: SUPERADMIN, role: ['superadmin'] });
      const res = await app.inject({
        method: 'GET',
        url: '/tasks',
        headers: { ...headers(token), 'x-arc-scope': 'platform' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Superadmin should see tasks from multiple orgs
      const orgs = new Set(body.docs.map((d: any) => d.organizationId));
      expect(orgs.size).toBeGreaterThanOrEqual(2);
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('malformed JWT returns 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tasks',
        headers: { authorization: 'Bearer invalid.token.here' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('missing auth header returns 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tasks',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
