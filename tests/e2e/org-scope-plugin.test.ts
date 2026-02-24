/**
 * Organization Scope Plugin E2E Tests
 *
 * Tests the header-based org identification system (orgScopePlugin):
 *
 * Header Security:
 * - x-organization-id header → sets org context
 * - Missing header + required route → 403
 * - Missing header + optional route → shows all (public)
 * - Header + unauthenticated → 401 (can't filter without auth)
 * - Header + wrong org (not member) → 403
 * - Superadmin bypass → can access any org
 *
 * Membership Validation:
 * - User in org-A can access org-A → 200
 * - User in org-A cannot access org-B → 403
 * - User in multiple orgs can access any of them
 * - Custom validateMembership callback
 *
 * Data Isolation:
 * - Org-A user only sees org-A data (via query._policyFilters)
 * - Org-B user only sees org-B data
 * - Superadmin sees all
 */

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { authPlugin } from '../../src/auth/authPlugin.js';
import { orgScopePlugin } from '../../src/org/orgScopePlugin.js';

const JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars-long!!';

describe('Organization Scope Plugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  /**
   * Create a test app with auth + orgScope plugins.
   * Routes registered via callback BEFORE ready().
   */
  async function createApp(
    orgOpts: Record<string, unknown> = {},
    registerRoutes?: (instance: FastifyInstance) => void,
  ) {
    app = Fastify({ logger: false });
    await app.register(authPlugin, { jwt: { secret: JWT_SECRET } });
    await app.register(orgScopePlugin, orgOpts);

    if (registerRoutes) {
      registerRoutes(app);
    }

    await app.ready();
    return app;
  }

  function issueToken(payload: Record<string, unknown>) {
    return app.auth.issueTokens(payload).accessToken;
  }

  // ========================================================================
  // Header Extraction & Required Mode
  // ========================================================================

  describe('Required org header (default mode)', () => {
    it('should set org context from x-organization-id header', async () => {
      await createApp({}, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async (request) => {
          return {
            organizationId: request.organizationId,
            orgScope: request.context?.orgScope,
          };
        });
      });

      const token = issueToken({
        id: 'user-1',
        roles: ['user'],
        organizations: [{ organizationId: 'org-alpha' }],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'org-alpha',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.organizationId).toBe('org-alpha');
      expect(body.orgScope).toBe('member');
    });

    it('should return 403 when required header is missing', async () => {
      await createApp({}, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async () => ({ data: [] }));
      });

      const token = issueToken({ id: 'user-1', roles: ['user'] });

      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: { authorization: `Bearer ${token}` },
        // No x-organization-id header
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('ORG_HEADER_REQUIRED');
    });

    it('should return 401 when header present but user not authenticated', async () => {
      await createApp({}, (app) => {
        // Use optionalAuthenticate so the route doesn't 401 before reaching orgScope
        app.get('/items', {
          preHandler: [app.optionalAuthenticate, app.organizationScoped({ required: false })],
        }, async () => ({ data: [] }));
      });

      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: { 'x-organization-id': 'org-alpha' },
        // No auth header — user is unauthenticated
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('AUTH_REQUIRED_FOR_ORG');
    });
  });

  // ========================================================================
  // Optional Mode
  // ========================================================================

  describe('Optional org header (required: false)', () => {
    it('should allow request without header (public data, no filtering)', async () => {
      await createApp({}, (app) => {
        app.get('/products', {
          preHandler: [app.organizationScoped({ required: false })],
        }, async (request) => {
          return {
            orgScope: request.context?.orgScope,
            hasOrgFilter: !!request.organizationId,
          };
        });
      });

      const res = await app.inject({
        method: 'GET',
        url: '/products',
        // No auth, no org header
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.orgScope).toBe('public');
      expect(body.hasOrgFilter).toBe(false);
    });

    it('should apply org filter when header is provided with auth', async () => {
      await createApp({}, (app) => {
        app.get('/products', {
          preHandler: [app.optionalAuthenticate, app.organizationScoped({ required: false })],
        }, async (request) => {
          return {
            organizationId: request.organizationId,
            orgScope: request.context?.orgScope,
          };
        });
      });

      const token = issueToken({
        id: 'user-1',
        roles: ['user'],
        organizations: [{ organizationId: 'org-alpha' }],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/products',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'org-alpha',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.organizationId).toBe('org-alpha');
      expect(body.orgScope).toBe('member');
    });
  });

  // ========================================================================
  // Membership Validation (Security)
  // ========================================================================

  describe('Membership validation — header security', () => {
    it('should reject user accessing org they do NOT belong to', async () => {
      await createApp({}, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async () => ({ data: [] }));
      });

      const token = issueToken({
        id: 'user-1',
        roles: ['user'],
        organizations: [{ organizationId: 'org-alpha' }], // Only member of org-alpha
      });

      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'org-beta', // Trying to access org-beta
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('ORG_ACCESS_DENIED');
    });

    it('should allow user accessing org they belong to', async () => {
      await createApp({}, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async (request) => {
          return { organizationId: request.organizationId };
        });
      });

      const token = issueToken({
        id: 'user-1',
        roles: ['user'],
        organizations: [{ organizationId: 'org-alpha' }, { organizationId: 'org-beta' }],
      });

      // Access org-alpha → allowed
      const res1 = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'org-alpha',
        },
      });
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).organizationId).toBe('org-alpha');

      // Access org-beta → also allowed (multi-org user)
      const res2 = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'org-beta',
        },
      });
      expect(res2.statusCode).toBe(200);
      expect(JSON.parse(res2.body).organizationId).toBe('org-beta');
    });

    it('should reject spoofed header with non-member org ID', async () => {
      // Security: user tries to access org they're not in by sending the header
      await createApp({}, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async () => ({ data: 'secret-data' }));
      });

      const token = issueToken({
        id: 'attacker',
        roles: ['user'],
        organizations: [{ organizationId: 'attacker-org' }],
      });

      // Spoof: try to access victim-org via header
      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'victim-org',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('ORG_ACCESS_DENIED');
    });
  });

  // ========================================================================
  // Superadmin Bypass
  // ========================================================================

  describe('Superadmin bypass', () => {
    it('superadmin can access any org without membership', async () => {
      await createApp({ bypassRoles: ['superadmin'] }, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async (request) => {
          return {
            organizationId: request.organizationId,
            orgScope: request.context?.orgScope,
            bypassReason: request.context?.bypassReason,
          };
        });
      });

      const token = issueToken({
        id: 'admin-1',
        roles: ['superadmin'],
        // No organizations list — doesn't matter for superadmin
      });

      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'any-org',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.organizationId).toBe('any-org');
      expect(body.orgScope).toBe('bypass');
      expect(body.bypassReason).toBe('superadmin');
    });

    it('superadmin without header on required route should get global scope', async () => {
      await createApp({ bypassRoles: ['superadmin'] }, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async (request) => {
          return { orgScope: request.context?.orgScope };
        });
      });

      const token = issueToken({ id: 'admin-1', roles: ['superadmin'] });

      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: { authorization: `Bearer ${token}` },
        // No org header — superadmin gets global scope
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).orgScope).toBe('global');
    });
  });

  // ========================================================================
  // Custom Header Name
  // ========================================================================

  describe('Custom header name', () => {
    it('should use custom header name for org extraction', async () => {
      await createApp({ header: 'x-tenant-id' }, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async (request) => {
          return { organizationId: request.organizationId };
        });
      });

      const token = issueToken({
        id: 'user-1',
        roles: ['user'],
        organizations: [{ organizationId: 'tenant-123' }],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-tenant-id': 'tenant-123',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).organizationId).toBe('tenant-123');
    });

    it('should reject when using wrong header name', async () => {
      await createApp({ header: 'x-tenant-id' }, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async () => ({ data: [] }));
      });

      const token = issueToken({ id: 'user-1', roles: ['user'] });

      // Send x-organization-id instead of x-tenant-id — should be treated as missing
      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'org-alpha',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('ORG_HEADER_REQUIRED');
    });
  });

  // ========================================================================
  // Custom Membership Validator
  // ========================================================================

  describe('Custom validateMembership', () => {
    it('should use custom validator for membership check', async () => {
      // Custom validator that only allows even-numbered org IDs
      const validateMembership = async (_user: any, orgId: string) => {
        const num = parseInt(orgId.replace('org-', ''), 10);
        return num % 2 === 0;
      };

      await createApp({ validateMembership }, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async (request) => {
          return { organizationId: request.organizationId };
        });
      });

      const token = issueToken({ id: 'user-1', roles: ['user'] });

      // org-4 (even) → allowed
      const res1 = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'org-4',
        },
      });
      expect(res1.statusCode).toBe(200);

      // org-3 (odd) → rejected
      const res2 = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'org-3',
        },
      });
      expect(res2.statusCode).toBe(403);
    });
  });

  // ========================================================================
  // Org Roles (set from membership)
  // ========================================================================

  describe('Org roles from membership', () => {
    it('should populate orgRoles from user membership data', async () => {
      await createApp({}, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async (request) => {
          return { orgRoles: request.context?.orgRoles };
        });
      });

      const token = issueToken({
        id: 'user-1',
        roles: ['user'],
        organizations: [
          { organizationId: 'org-alpha', roles: ['editor', 'billing'] },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': 'org-alpha',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.orgRoles).toEqual(['editor', 'billing']);
    });
  });

  // ========================================================================
  // Edge Cases
  // ========================================================================

  describe('Edge cases', () => {
    it('should handle whitespace in header value', async () => {
      await createApp({}, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async (request) => {
          return { organizationId: request.organizationId };
        });
      });

      const token = issueToken({
        id: 'user-1',
        roles: ['user'],
        organizations: [{ organizationId: 'org-alpha' }],
      });

      // Header with extra whitespace
      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': '  org-alpha  ',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).organizationId).toBe('org-alpha');
    });

    it('should handle empty string header as missing', async () => {
      await createApp({}, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async () => ({ data: [] }));
      });

      const token = issueToken({ id: 'user-1', roles: ['user'] });

      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: {
          authorization: `Bearer ${token}`,
          'x-organization-id': '',
        },
      });

      // Empty string should be treated as missing → 403
      expect(res.statusCode).toBe(403);
    });

    it('should handle user with roles as string (not array)', async () => {
      await createApp({ bypassRoles: ['superadmin'] }, (app) => {
        app.get('/items', {
          preHandler: [app.authenticate, app.organizationScoped({ required: true })],
        }, async (request) => {
          return { orgScope: request.context?.orgScope };
        });
      });

      // Some auth systems return roles as a single string
      const token = issueToken({ id: 'admin-1', roles: 'superadmin' as any });

      const res = await app.inject({
        method: 'GET',
        url: '/items',
        headers: { authorization: `Bearer ${token}` },
      });

      // Should handle string roles gracefully and bypass
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).orgScope).toBe('global');
    });
  });
});
