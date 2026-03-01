/**
 * Permission Check Exception Handling Tests
 *
 * Verifies that exceptions thrown inside permission check functions
 * are caught and return controlled 403 responses instead of 500 errors.
 *
 * Scenarios:
 * - Permission check throws Error → 403
 * - Permission check throws non-Error → 403
 * - Permission check async rejection → 403
 * - Normal permission deny → 403 (unchanged)
 * - Normal permission allow → 200 (unchanged)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import Fastify, { type FastifyInstance } from 'fastify';
import { defineResource } from '../../src/core/defineResource.js';
import { BaseController } from '../../src/core/BaseController.js';
import { createMongooseAdapter } from '../../src/adapters/mongoose.js';
import { allowPublic } from '../../src/permissions/index.js';
import type { PermissionCheck, PermissionContext } from '../../src/permissions/types.js';
import { setupTestDatabase, teardownTestDatabase, createMockModel, createMockRepository } from '../setup.js';

// --------------------------------------------------------------------------
// Custom permission functions that throw
// --------------------------------------------------------------------------

/** Always throws an Error */
const throwingPermission: PermissionCheck = async (_ctx: PermissionContext) => {
  throw new Error('Database connection lost during permission check');
};

/** Throws a non-Error value */
const throwingNonError: PermissionCheck = async (_ctx: PermissionContext) => {
  throw 'string-error'; // eslint-disable-line no-throw-literal
};

/** Throws after some async work */
const asyncThrowingPermission: PermissionCheck = async (_ctx: PermissionContext) => {
  await new Promise((r) => setTimeout(r, 1));
  throw new TypeError('Cannot read property of undefined');
};

/** Always denies (normal behavior) */
const denyPermission: PermissionCheck = async (_ctx: PermissionContext) => {
  return { granted: false, reason: 'Not allowed' };
};

/** Always allows */
const allowPermission: PermissionCheck = async (_ctx: PermissionContext) => {
  return true;
};

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('Permission Check Exception Handling', () => {
  let mongoUri: string;

  beforeAll(async () => {
    mongoUri = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  let modelCounter = 0;

  async function createAppWithPermission(
    listPerm: PermissionCheck,
    getPerm?: PermissionCheck,
    createPerm?: PermissionCheck,
  ) {
    modelCounter++;
    const Model = createMockModel(`PermExc${modelCounter}`);
    const repo = createMockRepository(Model);
    const controller = new BaseController(repo);

    const resource = defineResource({
      name: `permexc${modelCounter}`,
      prefix: '/items',
      adapter: createMongooseAdapter({ model: Model, repository: repo }),
      controller,
      permissions: {
        list: listPerm,
        get: getPerm ?? allowPublic(),
        create: createPerm ?? allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();
    return app;
  }

  // --------------------------------------------------------------------------
  // Exception → 403 (not 500)
  // --------------------------------------------------------------------------

  describe('exceptions in permission checks', () => {
    it('should return 403 when permission check throws Error', async () => {
      const app = await createAppWithPermission(throwingPermission);

      try {
        const res = await app.inject({ method: 'GET', url: '/items' });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(false);
        expect(body.error).toBe('Permission denied');
      } finally {
        await app.close();
      }
    });

    it('should return 403 when permission check throws non-Error', async () => {
      const app = await createAppWithPermission(throwingNonError);

      try {
        const res = await app.inject({ method: 'GET', url: '/items' });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(false);
        expect(body.error).toBe('Permission denied');
      } finally {
        await app.close();
      }
    });

    it('should return 403 when async permission check rejects', async () => {
      const app = await createAppWithPermission(asyncThrowingPermission);

      try {
        const res = await app.inject({ method: 'GET', url: '/items' });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(false);
        expect(body.error).toBe('Permission denied');
      } finally {
        await app.close();
      }
    });

    it('should NOT return 500 for permission exceptions (regression)', async () => {
      const app = await createAppWithPermission(throwingPermission);

      try {
        const res = await app.inject({ method: 'GET', url: '/items' });

        // The critical assertion: exceptions must NOT bubble to 500
        expect(res.statusCode).not.toBe(500);
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Normal behavior unchanged
  // --------------------------------------------------------------------------

  describe('normal permission behavior unchanged', () => {
    it('should return 401 for denied permission without user context', async () => {
      // No user is attached (no auth middleware), so denial returns 401 not 403
      const app = await createAppWithPermission(denyPermission);

      try {
        const res = await app.inject({ method: 'GET', url: '/items' });

        expect(res.statusCode).toBe(401);
        const body = JSON.parse(res.body);
        expect(body.error).toBe('Not allowed');
      } finally {
        await app.close();
      }
    });

    it('should return 200 for allowed permission', async () => {
      const app = await createAppWithPermission(allowPermission);

      try {
        const res = await app.inject({ method: 'GET', url: '/items' });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('should return 200 for allowPublic()', async () => {
      const app = await createAppWithPermission(allowPublic());

      try {
        const res = await app.inject({ method: 'GET', url: '/items' });

        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Different operations
  // --------------------------------------------------------------------------

  describe('exceptions on different operations', () => {
    it('should handle throwing GET /:id permission', async () => {
      const app = await createAppWithPermission(allowPublic(), throwingPermission);

      try {
        // First create an item
        const createRes = await app.inject({
          method: 'POST',
          url: '/items',
          payload: { name: 'Test' },
        });
        const id = JSON.parse(createRes.body).data._id;

        // GET with throwing permission
        const res = await app.inject({ method: 'GET', url: `/items/${id}` });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toBe('Permission denied');
      } finally {
        await app.close();
      }
    });

    it('should handle throwing POST permission', async () => {
      const app = await createAppWithPermission(allowPublic(), allowPublic(), throwingPermission);

      try {
        const res = await app.inject({
          method: 'POST',
          url: '/items',
          payload: { name: 'Test' },
        });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toBe('Permission denied');
      } finally {
        await app.close();
      }
    });
  });
});
