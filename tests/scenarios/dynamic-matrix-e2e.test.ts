/**
 * Dynamic Permission Matrix — E2E Tests
 *
 * Tests createDynamicPermissionMatrix wired into defineResource
 * through the full HTTP stack. Validates matrix-based access,
 * multi-role union, bypass roles, wildcards, and cache behavior.
 *
 * Run with: npx vitest run tests/scenarios/dynamic-matrix-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { vi } from 'vitest';
import { createApp } from '../../src/factory/createApp.js';
import { defineResource } from '../../src/core/defineResource.js';
import { BaseController } from '../../src/core/BaseController.js';
import { createMongooseAdapter } from '../../src/adapters/mongoose.js';
import { createDynamicPermissionMatrix, requireAuth } from '../../src/permissions/index.js';
import { multiTenantPreset } from '../../src/presets/multiTenant.js';
import { setupTestDatabase, teardownTestDatabase } from '../setup.js';
import type { FastifyInstance } from 'fastify';

const JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars-long!!';

const ORG_1 = new mongoose.Types.ObjectId().toString();
const USER_1 = new mongoose.Types.ObjectId().toString();
const USER_2 = new mongoose.Types.ObjectId().toString();
const SUPERADMIN = new mongoose.Types.ObjectId().toString();

// ============================================================================
// Permission matrix (simulates DB-backed policy)
// ============================================================================

const POLICY_MATRIX: Record<string, Record<string, readonly string[]>> = {
  admin: {
    project: ['create', 'read', 'update', 'delete'],
  },
  editor: {
    project: ['create', 'read', 'update'],
  },
  viewer: {
    project: ['read'],
  },
  super_ops: {
    '*': ['*'],
  },
};

const resolverSpy = vi.fn(async () => POLICY_MATRIX);

describe('Dynamic Permission Matrix E2E', () => {
  let app: FastifyInstance;
  let matrix: ReturnType<typeof createDynamicPermissionMatrix>;

  const ProjectSchema = new mongoose.Schema({
    name: { type: String, required: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId },
  }, { timestamps: true });

  beforeAll(async () => {
    await setupTestDatabase();

    const ProjectModel = mongoose.models['DynProject'] || mongoose.model('DynProject', ProjectSchema);
    const { Repository } = require('@classytic/mongokit');
    const repo = new Repository(ProjectModel);
    const ctrl = new BaseController(repo);

    matrix = createDynamicPermissionMatrix({
      resolveRolePermissions: resolverSpy,
      cache: { ttlMs: 60_000 },
    });

    const preset = multiTenantPreset();
    const resource = defineResource({
      name: 'project',
      adapter: createMongooseAdapter({ model: ProjectModel, repository: repo }),
      controller: ctrl,
      prefix: '/projects',
      tag: 'Projects',
      permissions: {
        list: matrix.canAction('project', 'read'),
        get: matrix.canAction('project', 'read'),
        create: matrix.canAction('project', 'create'),
        update: matrix.canAction('project', 'update'),
        delete: matrix.canAction('project', 'delete'),
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
          const userRoles = (decoded.roles ?? []) as string[];
          if (wantsElevation && userRoles.includes('superadmin')) {
            (request as any).scope = { kind: 'elevated', elevatedBy: String(decoded.id) };
          } else if (decoded.organizationId) {
            (request as any).scope = {
              kind: 'member',
              organizationId: String(decoded.organizationId),
              orgRoles: Array.isArray(decoded.orgRoles) ? decoded.orgRoles : [],
            };
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
  // Matrix-based route access
  // --------------------------------------------------------------------------

  describe('Matrix-based route access', () => {
    let projectId: string;

    it('user with project:create permission can POST', async () => {
      const token = issueToken({
        id: USER_1,
        roles: [],
        organizationId: ORG_1,
        orgRoles: ['editor'],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: headers(token),
        payload: { name: 'Editor Project' },
      });

      expect(res.statusCode).toBe(201);
      projectId = JSON.parse(res.body).data._id;
    });

    it('user without project:create permission gets 403', async () => {
      const token = issueToken({
        id: USER_2,
        roles: [],
        organizationId: ORG_1,
        orgRoles: ['viewer'],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: headers(token),
        payload: { name: 'Viewer Project' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('viewer can read projects', async () => {
      const token = issueToken({
        id: USER_2,
        roles: [],
        organizationId: ORG_1,
        orgRoles: ['viewer'],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/projects',
        headers: headers(token),
      });

      expect(res.statusCode).toBe(200);
    });

    it('viewer cannot delete projects', async () => {
      const token = issueToken({
        id: USER_2,
        roles: [],
        organizationId: ORG_1,
        orgRoles: ['viewer'],
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/projects/${projectId}`,
        headers: headers(token),
      });

      expect(res.statusCode).toBe(403);
    });

    it('admin can delete projects', async () => {
      // Create disposable project
      const adminToken = issueToken({
        id: USER_1,
        roles: [],
        organizationId: ORG_1,
        orgRoles: ['admin'],
      });

      const createRes = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: headers(adminToken),
        payload: { name: 'Delete Me' },
      });
      const deleteId = JSON.parse(createRes.body).data._id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/projects/${deleteId}`,
        headers: headers(adminToken),
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Multi-role union
  // --------------------------------------------------------------------------

  describe('Union across multiple org roles', () => {
    it('user with viewer+editor gets union of both permissions', async () => {
      const token = issueToken({
        id: USER_1,
        roles: [],
        organizationId: ORG_1,
        orgRoles: ['viewer', 'editor'],
      });

      // Editor can create, viewer cannot — union grants create
      const res = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: headers(token),
        payload: { name: 'Multi-Role Project' },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  // --------------------------------------------------------------------------
  // Bypass roles
  // --------------------------------------------------------------------------

  describe('Bypass roles', () => {
    it('superadmin bypasses matrix entirely', async () => {
      const token = issueToken({
        id: SUPERADMIN,
        roles: ['superadmin'],
        organizationId: ORG_1,
      });

      // Superadmin should be able to create even with no orgRoles
      // Use elevation header to get elevated scope
      const res = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: { ...headers(token), 'x-arc-scope': 'platform' },
        payload: { name: 'Superadmin Project' },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  // --------------------------------------------------------------------------
  // Cache behavior
  // --------------------------------------------------------------------------

  describe('Cache behavior', () => {
    it('resolver is called for permission resolution', () => {
      // After all the requests above, resolver should have been called
      expect(resolverSpy).toHaveBeenCalled();
    });

    it('clearCache resets resolver call count', async () => {
      const callsBefore = resolverSpy.mock.calls.length;
      await matrix.clearCache();

      // Make a request to trigger re-resolution
      const token = issueToken({
        id: USER_1,
        roles: [],
        organizationId: ORG_1,
        orgRoles: ['viewer'],
      });

      await app.inject({
        method: 'GET',
        url: '/projects',
        headers: headers(token),
      });

      expect(resolverSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
