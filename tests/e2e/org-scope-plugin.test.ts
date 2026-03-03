/**
 * Request Scope E2E Tests
 *
 * Tests the request.scope system that replaced orgScopePlugin:
 *
 * Scope Resolution:
 * - request.scope = { kind: 'public' } — default, no auth
 * - request.scope = { kind: 'authenticated' } — logged in, no org
 * - request.scope = { kind: 'member', organizationId, orgRoles } — org member
 * - request.scope = { kind: 'elevated', elevatedBy } — platform admin
 *
 * resolveOrgFromHeader:
 * - x-organization-id header + membership -> member scope
 * - Missing header -> scope stays authenticated
 * - Header + non-member -> 403
 * - Header + unauthenticated -> 401
 *
 * Scope Type Guards:
 * - isMember(), isElevated(), hasOrgAccess(), isAuthenticated()
 * - getOrgId(), getOrgRoles(), getTeamId()
 *
 * Elevation:
 * - Elevated scope bypasses org membership checks
 * - Elevated without org -> global access
 * - Elevated with org -> scoped to that org
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createApp } from '../../src/factory/createApp.js';
import {
  isMember,
  isElevated,
  hasOrgAccess,
  isAuthenticated,
  getOrgId,
  getOrgRoles,
  getTeamId,
  PUBLIC_SCOPE,
  AUTHENTICATED_SCOPE,
} from '../../src/scope/types.js';
import type { RequestScope } from '../../src/scope/types.js';

const JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars-long!!';

/**
 * Test helper: preHandler hook that resolves `request.scope` from JWT user claims.
 * Must run AFTER fastify.authenticate (which sets request.user and scope = authenticated).
 *
 * This simulates what resolveOrgFromHeader or Better Auth adapters do in production.
 */
function scopeFromJwtPreHandler(
  opts: {
    superadminRoles?: string[];
    membershipDb?: Record<string, Record<string, string[]>>;
    header?: string;
    customValidator?: (userId: string, orgId: string) => Promise<{ roles: string[] } | null>;
  } = {}
) {
  const {
    superadminRoles = [],
    membershipDb,
    header = 'x-organization-id',
    customValidator,
  } = opts;

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = (request as any).user as Record<string, unknown> | undefined;
    if (!user) return;

    const userRoles = (Array.isArray(user.role) ? user.role : []) as string[];
    const userId = String(user.id ?? user._id ?? '');

    // Elevated scope for platform admins
    if (superadminRoles.some((r) => userRoles.includes(r))) {
      const orgId = request.headers[header] as string | undefined;
      (request as any).scope = {
        kind: 'elevated',
        organizationId: orgId || undefined,
        elevatedBy: userId,
      } satisfies RequestScope;
      return;
    }

    // Resolve org from header
    const orgId = request.headers[header] as string | undefined;
    if (!orgId) return; // No header -> stay authenticated

    // Custom validator
    if (customValidator) {
      const result = await customValidator(userId, orgId);
      if (!result) {
        reply.code(403).send({
          success: false,
          error: 'Forbidden',
          message: 'Not a member of this organization',
          code: 'ORG_ACCESS_DENIED',
        });
        return;
      }
      (request as any).scope = {
        kind: 'member',
        organizationId: orgId,
        orgRoles: result.roles,
      } satisfies RequestScope;
      return;
    }

    // Membership database lookup
    if (membershipDb) {
      const roles = membershipDb[userId]?.[orgId];
      if (!roles) {
        reply.code(403).send({
          success: false,
          error: 'Forbidden',
          message: 'Not a member of this organization',
          code: 'ORG_ACCESS_DENIED',
        });
        return;
      }
      (request as any).scope = {
        kind: 'member',
        organizationId: orgId,
        orgRoles: roles,
      } satisfies RequestScope;
      return;
    }

    // Simple: just set member scope from header (no validation)
    (request as any).scope = {
      kind: 'member',
      organizationId: orgId,
      orgRoles: ['member'],
    } satisfies RequestScope;
  };
}

describe('Request Scope System', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  function issueToken(payload: Record<string, unknown>) {
    return app.auth.issueTokens(payload).accessToken;
  }

  function authHeader(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  // ========================================================================
  // Scope Type Guards (Unit Tests)
  // ========================================================================

  describe('Scope type guards', () => {
    it('should identify public scope', () => {
      const scope: RequestScope = { kind: 'public' };
      expect(isMember(scope)).toBe(false);
      expect(isElevated(scope)).toBe(false);
      expect(hasOrgAccess(scope)).toBe(false);
      expect(isAuthenticated(scope)).toBe(false);
      expect(getOrgId(scope)).toBeUndefined();
      expect(getOrgRoles(scope)).toEqual([]);
      expect(getTeamId(scope)).toBeUndefined();
    });

    it('should identify authenticated scope', () => {
      const scope: RequestScope = { kind: 'authenticated' };
      expect(isMember(scope)).toBe(false);
      expect(isElevated(scope)).toBe(false);
      expect(hasOrgAccess(scope)).toBe(false);
      expect(isAuthenticated(scope)).toBe(true);
      expect(getOrgId(scope)).toBeUndefined();
      expect(getOrgRoles(scope)).toEqual([]);
    });

    it('should identify member scope', () => {
      const scope: RequestScope = {
        kind: 'member',
        organizationId: 'org-123',
        orgRoles: ['admin', 'editor'],
      };
      expect(isMember(scope)).toBe(true);
      expect(isElevated(scope)).toBe(false);
      expect(hasOrgAccess(scope)).toBe(true);
      expect(isAuthenticated(scope)).toBe(true);
      expect(getOrgId(scope)).toBe('org-123');
      expect(getOrgRoles(scope)).toEqual(['admin', 'editor']);
    });

    it('should identify member scope with team', () => {
      const scope: RequestScope = {
        kind: 'member',
        organizationId: 'org-123',
        orgRoles: ['member'],
        teamId: 'team-456',
      };
      expect(getTeamId(scope)).toBe('team-456');
    });

    it('should identify elevated scope', () => {
      const scope: RequestScope = {
        kind: 'elevated',
        elevatedBy: 'admin-1',
      };
      expect(isMember(scope)).toBe(false);
      expect(isElevated(scope)).toBe(true);
      expect(hasOrgAccess(scope)).toBe(true);
      expect(isAuthenticated(scope)).toBe(true);
      expect(getOrgId(scope)).toBeUndefined();
    });

    it('should identify elevated scope with org', () => {
      const scope: RequestScope = {
        kind: 'elevated',
        organizationId: 'org-789',
        elevatedBy: 'admin-1',
      };
      expect(getOrgId(scope)).toBe('org-789');
    });

    it('should export correct constant scopes', () => {
      expect(PUBLIC_SCOPE).toEqual({ kind: 'public' });
      expect(AUTHENTICATED_SCOPE).toEqual({ kind: 'authenticated' });
    });
  });

  // ========================================================================
  // Default Scope Behavior
  // ========================================================================

  describe('Default scope', () => {
    it('unauthenticated request should have public scope', async () => {
      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', async (request) => {
            return { scope: (request as any).scope };
          });
        },
      });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/items' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).scope.kind).toBe('public');
    });

    it('authenticated request should have authenticated scope by default', async () => {
      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate],
          }, async (request) => {
            return { scope: (request as any).scope };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-1', role: ['user'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).scope.kind).toBe('authenticated');
    });
  });

  // ========================================================================
  // Scope from Header (membership validation)
  // ========================================================================

  describe('Scope from header — org membership validation', () => {
    const membershipDb: Record<string, Record<string, string[]>> = {
      'user-1': {
        'org-alpha': ['editor', 'billing'],
        'org-beta': ['member'],
      },
      'user-2': {
        'org-alpha': ['viewer'],
      },
    };

    it('should set member scope from x-organization-id header', async () => {
      const scopeHook = scopeFromJwtPreHandler({ membershipDb });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async (request) => {
            const scope = (request as any).scope as RequestScope;
            return {
              kind: scope.kind,
              organizationId: getOrgId(scope),
              orgRoles: getOrgRoles(scope),
            };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-1', role: ['user'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-organization-id': 'org-alpha' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.kind).toBe('member');
      expect(body.organizationId).toBe('org-alpha');
      expect(body.orgRoles).toEqual(['editor', 'billing']);
    });

    it('should keep authenticated scope when header is missing', async () => {
      const scopeHook = scopeFromJwtPreHandler({ membershipDb });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async (request) => {
            return { scope: (request as any).scope };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-1', role: ['user'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).scope.kind).toBe('authenticated');
    });

    it('should reject user accessing org they do NOT belong to', async () => {
      const scopeHook = scopeFromJwtPreHandler({ membershipDb });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async () => ({ data: [] }));
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-1', role: ['user'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-organization-id': 'org-gamma' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('ORG_ACCESS_DENIED');
    });

    it('should allow multi-org user to access any of their orgs', async () => {
      const scopeHook = scopeFromJwtPreHandler({ membershipDb });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async (request) => {
            return { organizationId: getOrgId((request as any).scope) };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-1', role: ['user'] });

      const res1 = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-organization-id': 'org-alpha' },
      });
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).organizationId).toBe('org-alpha');

      const res2 = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-organization-id': 'org-beta' },
      });
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).organizationId).toBe('org-beta');
    });

    it('should reject spoofed header with non-member org ID', async () => {
      const scopeHook = scopeFromJwtPreHandler({ membershipDb });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async () => ({ data: 'secret-data' }));
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-2', role: ['user'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-organization-id': 'org-beta' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('ORG_ACCESS_DENIED');
    });

    it('unauthenticated request should get 401', async () => {
      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate],
          }, async () => ({ data: [] }));
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: { 'x-organization-id': 'org-alpha' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should populate orgRoles from membership data', async () => {
      const scopeHook = scopeFromJwtPreHandler({ membershipDb });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async (request) => {
            return { orgRoles: getOrgRoles((request as any).scope) };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-1', role: ['user'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-organization-id': 'org-alpha' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).orgRoles).toEqual(['editor', 'billing']);
    });
  });

  // ========================================================================
  // Custom Header Name
  // ========================================================================

  describe('Custom header name', () => {
    it('should use custom header name for org extraction', async () => {
      const scopeHook = scopeFromJwtPreHandler({ header: 'x-tenant-id' });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async (request) => {
            return { organizationId: getOrgId((request as any).scope) };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-1', role: ['user'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-tenant-id': 'tenant-123' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).organizationId).toBe('tenant-123');
    });

    it('should not resolve org when using wrong header name', async () => {
      const scopeHook = scopeFromJwtPreHandler({ header: 'x-tenant-id' });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async (request) => {
            return { scope: (request as any).scope };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-1', role: ['user'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-organization-id': 'org-alpha' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).scope.kind).toBe('authenticated');
    });
  });

  // ========================================================================
  // Custom Membership Validator
  // ========================================================================

  describe('Custom membership validator', () => {
    it('should use custom validator for membership check', async () => {
      // Custom validator: only allows even-numbered org IDs
      const customValidator = async (_userId: string, orgId: string) => {
        const num = parseInt(orgId.replace('org-', ''), 10);
        return num % 2 === 0 ? { roles: ['member'] } : null;
      };
      const scopeHook = scopeFromJwtPreHandler({ customValidator });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async (request) => {
            return { organizationId: getOrgId((request as any).scope) };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-1', role: ['user'] });

      // org-4 (even) -> allowed
      const res1 = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-organization-id': 'org-4' },
      });
      expect(res1.statusCode).toBe(200);

      // org-3 (odd) -> rejected
      const res2 = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-organization-id': 'org-3' },
      });
      expect(res2.statusCode).toBe(403);
    });
  });

  // ========================================================================
  // Elevated Scope (Platform Admin Bypass)
  // ========================================================================

  describe('Elevated scope (platform admin)', () => {
    it('elevated scope bypasses membership check', async () => {
      const membershipDb: Record<string, Record<string, string[]>> = {};
      const scopeHook = scopeFromJwtPreHandler({
        superadminRoles: ['superadmin'],
        membershipDb,
      });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async (request) => {
            const scope = (request as any).scope as RequestScope;
            return {
              kind: scope.kind,
              elevatedBy: isElevated(scope) ? scope.elevatedBy : undefined,
            };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'admin-1', role: ['superadmin'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: { ...authHeader(token), 'x-organization-id': 'any-org' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.kind).toBe('elevated');
      expect(body.elevatedBy).toBe('admin-1');
    });

    it('elevated scope without org header stays elevated (global access)', async () => {
      const scopeHook = scopeFromJwtPreHandler({
        superadminRoles: ['superadmin'],
      });

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, scopeHook],
          }, async (request) => {
            const scope = (request as any).scope as RequestScope;
            return { kind: scope.kind };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'admin-1', role: ['superadmin'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).kind).toBe('elevated');
    });
  });

  // ========================================================================
  // Edge Cases
  // ========================================================================

  describe('Edge cases', () => {
    it('should handle scope set directly on request via preHandler hook', async () => {
      const customScopeHook = async (request: FastifyRequest) => {
        const user = (request as any).user;
        if (user) {
          (request as any).scope = {
            kind: 'member',
            organizationId: 'direct-org',
            orgRoles: ['admin'],
          } satisfies RequestScope;
        }
      };

      app = await createApp({
        preset: 'development',
        auth: { type: 'jwt', jwt: { secret: JWT_SECRET } },
        logger: false, helmet: false, rateLimit: false,
        plugins: async (fastify) => {
          fastify.get('/items', {
            preHandler: [fastify.authenticate, customScopeHook],
          }, async (request) => {
            const scope = (request as any).scope as RequestScope;
            return {
              kind: scope.kind,
              organizationId: getOrgId(scope),
              orgRoles: getOrgRoles(scope),
            };
          });
        },
      });
      await app.ready();

      const token = issueToken({ id: 'user-1', role: ['user'] });
      const res = await app.inject({
        method: 'GET', url: '/items',
        headers: authHeader(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.kind).toBe('member');
      expect(body.organizationId).toBe('direct-org');
      expect(body.orgRoles).toEqual(['admin']);
    });
  });
});
