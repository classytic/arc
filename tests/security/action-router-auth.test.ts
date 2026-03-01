/**
 * Security Tests: Action Router Auth Handling
 *
 * Validates that createActionRouter correctly handles mixed public/protected actions.
 * Previously, global auth preHandler was applied whenever ANY action was protected,
 * which blocked unauthenticated access to public actions.
 *
 * Regression test for: createActionRouter applying global auth when mixed public/protected.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createActionRouter } from '../../src/core/createActionRouter.js';
import type { PermissionCheck, PermissionContext } from '../../src/types/index.js';

/**
 * Create a public permission check (marks _isPublic = true)
 */
function publicAction(): PermissionCheck {
  const check = (() => true) as PermissionCheck & { _isPublic: boolean };
  check._isPublic = true;
  return check;
}

/**
 * Create a protected permission check requiring auth
 */
function protectedAction(): PermissionCheck {
  const check = ((ctx: PermissionContext) => {
    return !!ctx.user;
  }) as PermissionCheck;
  return check;
}

describe('Security: Action Router Auth Handling', () => {
  describe('mixed public/protected actions', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify();

      // Simulate authenticate decorator that rejects unauthenticated requests
      (app as any).authenticate = async (req: any) => {
        if (!req.user) {
          throw new Error('Unauthorized');
        }
      };

      createActionRouter(app, {
        tag: 'Test',
        actions: {
          status: async (id) => ({ id, status: 'active' }),
          approve: async (id, _data, req) => ({ id, approvedBy: (req.user as any)?.id }),
        },
        actionPermissions: {
          status: publicAction(),
          approve: protectedAction(),
        },
      });

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('should allow unauthenticated access to public actions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/test-id/action',
        payload: { action: 'status' },
        // No auth headers
      });

      // Key assertion: unauthenticated request to public action returns 200, not 401
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('should reject unauthenticated access to protected actions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/test-id/action',
        payload: { action: 'approve' },
        // No auth headers, no user
      });

      // Should get 401 or 403, not 200
      expect(res.statusCode).toBeGreaterThanOrEqual(401);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  describe('all protected actions', () => {
    let app: FastifyInstance;
    let authCalled: boolean;

    beforeAll(async () => {
      app = Fastify();
      authCalled = false;

      // Simulate authenticate decorator
      (app as any).authenticate = async (req: any) => {
        authCalled = true;
        // In this test, always pass (to check preHandler is applied)
        req.user = { id: 'test-user' };
      };

      createActionRouter(app, {
        tag: 'Test',
        actions: {
          approve: async (id) => ({ id, approved: true }),
          reject: async (id) => ({ id, rejected: true }),
        },
        actionPermissions: {
          approve: protectedAction(),
          reject: protectedAction(),
        },
      });

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('should apply global auth preHandler when all actions are protected', async () => {
      authCalled = false;

      const res = await app.inject({
        method: 'POST',
        url: '/test-id/action',
        payload: { action: 'approve' },
      });

      expect(res.statusCode).toBe(200);
      expect(authCalled).toBe(true);
    });
  });

  describe('all public actions', () => {
    let app: FastifyInstance;
    let authCalled: boolean;

    beforeAll(async () => {
      app = Fastify();
      authCalled = false;

      (app as any).authenticate = async () => {
        authCalled = true;
      };

      createActionRouter(app, {
        tag: 'Test',
        actions: {
          status: async (id) => ({ id, status: 'ok' }),
          health: async () => ({ healthy: true }),
        },
        actionPermissions: {
          status: publicAction(),
          health: publicAction(),
        },
      });

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('should NOT apply auth preHandler when all actions are public', async () => {
      authCalled = false;

      const res = await app.inject({
        method: 'POST',
        url: '/test-id/action',
        payload: { action: 'status' },
      });

      expect(res.statusCode).toBe(200);
      expect(authCalled).toBe(false);
    });
  });
});
