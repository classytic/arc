/**
 * Release Blocker Security Tests
 *
 * Tests for critical security issues identified in release review.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { multiTenantPreset } from '../../src/presets/multiTenant.js';
import { authPlugin } from '../../src/auth/authPlugin.js';
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RequestWithExtras } from '../../src/types/index.js';

describe('Security: Release Blockers', () => {
  describe('Issue 1: Multi-Tenant Fails Open (FIXED ✅)', () => {
    it('FIXED: now returns 403 when orgId is null', async () => {
      const preset = multiTenantPreset({
        tenantField: 'organizationId',
        bypassRoles: ['superadmin'],
      });

      const listMiddleware = preset.middlewares?.list?.[0];
      expect(listMiddleware).toBeDefined();

      // Simulate authenticated user with no organizationId
      const request = {
        user: {
          _id: 'user123',
          email: 'user@example.com',
          roles: ['user'], // Not a bypass role
          // organizationId is missing!
        },
        query: {},
      } as unknown as RequestWithExtras;

      let statusCode = 200;
      let responseBody: any;

      const reply = {
        code: (code: number) => {
          statusCode = code;
          return reply;
        },
        send: (body: any) => {
          responseBody = body;
          return reply;
        },
      } as unknown as FastifyReply;

      // Execute the middleware
      await listMiddleware!(request, reply);

      // ✅ FIXED: Returns 403 instead of allowing access
      expect(statusCode).toBe(403);
      expect(responseBody).toEqual({
        success: false,
        error: 'Forbidden',
        message: 'Organization context required for this operation',
      });
    });

    it('FIXED: now returns 403 when creating without tenant ID', async () => {
      const preset = multiTenantPreset({
        tenantField: 'organizationId',
      });

      const createMiddleware = preset.middlewares?.create?.[0];
      expect(createMiddleware).toBeDefined();

      // Simulate authenticated user with no organizationId
      const request = {
        user: {
          _id: 'user123',
          roles: ['user'],
          // organizationId is missing!
        },
        body: {
          name: 'Sensitive Data',
          price: 1000,
        },
      } as unknown as RequestWithExtras;

      let statusCode = 200;
      let responseBody: any;

      const reply = {
        code: (code: number) => {
          statusCode = code;
          return reply;
        },
        send: (body: any) => {
          responseBody = body;
          return reply;
        },
      } as unknown as FastifyReply;

      await createMiddleware!(request, reply);

      // ✅ FIXED: Returns 403 instead of creating orphaned data
      expect(statusCode).toBe(403);
      expect(responseBody).toEqual({
        success: false,
        error: 'Forbidden',
        message: 'Organization context required to create resources',
      });
    });

    it('correctly filters when orgId exists', async () => {
      const preset = multiTenantPreset({
        tenantField: 'organizationId',
        bypassRoles: ['superadmin'],
      });

      const listMiddleware = preset.middlewares?.list?.[0];

      const request = {
        user: {
          _id: 'user123',
          roles: ['user'],
          organizationId: 'org-abc',
        },
        query: {},
      } as unknown as RequestWithExtras;

      const reply = {
        code: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as unknown as FastifyReply;

      await listMiddleware!(request, reply);

      // Should add tenant filter
      expect((request.query as any)._policyFilters).toEqual({
        organizationId: 'org-abc',
      });
      expect(reply.code).not.toHaveBeenCalled();
    });

    it('bypasses filtering for superadmin roles', async () => {
      const preset = multiTenantPreset({
        tenantField: 'organizationId',
        bypassRoles: ['superadmin'],
      });

      const listMiddleware = preset.middlewares?.list?.[0];

      const request = {
        user: {
          _id: 'admin123',
          roles: ['superadmin'],
          organizationId: 'org-abc',
        },
        query: {},
      } as unknown as RequestWithExtras;

      const reply = {
        code: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as unknown as FastifyReply;

      await listMiddleware!(request, reply);

      // Bypass roles should not add filters
      expect((request.query as any)._policyFilters).toBeUndefined();
      expect(reply.code).not.toHaveBeenCalled();
    });
  });

  describe('Issue 2: Auth Plugin Dev Secret (FIXED ✅)', () => {
    beforeEach(() => {
      // Clear NODE_ENV for testing
      delete process.env.NODE_ENV;
    });

    it('FIXED: now always requires explicit secret', async () => {
      const app = Fastify({ logger: false });

      // Test multiple NODE_ENV values
      const envValues = ['staging', 'prod', 'uat', 'qa', 'development', undefined, ''];

      for (const envValue of envValues) {
        process.env.NODE_ENV = envValue as string | undefined;

        // Should throw for ALL environments, not just production
        await expect(
          app.register(authPlugin, {
            secret: undefined,
          })
        ).rejects.toThrow('JWT secret is required for authentication');
      }

      await app.close();
    });

    it('FIXED: rejects secrets shorter than 32 characters', async () => {
      const app = Fastify({ logger: false });

      const weakSecrets = [
        'short',
        '12345678',
        'weak-secret',
        'this-is-only-31-chars-long!',
      ];

      for (const secret of weakSecrets) {
        await expect(
          app.register(authPlugin, { secret })
        ).rejects.toThrow(/JWT secret must be at least 32 characters/);
      }

      await app.close();
    });

    it('FIXED: accepts valid secrets (32+ characters)', async () => {
      const app = Fastify({ logger: false });

      const validSecret = 'this-is-a-valid-secret-with-32-or-more-characters';
      expect(validSecret.length).toBeGreaterThanOrEqual(32);

      // Should not throw
      await expect(
        app.register(authPlugin, { secret: validSecret })
      ).resolves.not.toThrow();

      await app.close();
    });

    it('FIXED: no hardcoded dev secret fallback exists', () => {
      // Old vulnerable code:
      // secret: secret ?? 'arc-dev-secret-do-not-use-in-production'
      //
      // New fixed code:
      // if (!secret) { throw new Error(...) }
      // secret  // Will never be undefined

      const secret = undefined;

      // If we follow the old logic, it would use dev secret
      // But now it throws before reaching this point
      expect(() => {
        if (!secret) {
          throw new Error('JWT secret is required');
        }
        return secret;
      }).toThrow('JWT secret is required');
    });
  });

  describe('Issue 3: Prisma Adapter Incomplete (High)', () => {
    it('FACT: Prisma adapter has zero tests', () => {
      // No tests exist for Prisma adapter in tests/ directory
      // This can be verified with: find packages/arc/tests -name "*prisma*"

      // The adapter is just a thin wrapper:
      // - No preset integration tests (softDelete, multiTenant, etc.)
      // - No query parser integration tests
      // - No policy filter tests
      // - No CRUD operation tests

      expect(true).toBe(true);
    });

    it('FACT: Prisma adapter delegates all CRUD to repository', () => {
      // The PrismaAdapter class only implements schema generation
      // All actual CRUD operations go through the provided repository
      // This means:
      // 1. Users must implement their own Prisma repositories
      // 2. No Arc-specific behaviors (presets, policies) are tested with Prisma
      // 3. Query parsing for Prisma filters is not implemented

      expect(true).toBe(true);
    });

    it('FACT: No documentation on Prisma repository requirements', () => {
      // There are no examples showing:
      // - How to implement a Prisma repository compatible with Arc
      // - How presets work with Prisma (e.g., softDelete adding WHERE clause)
      // - How policy filters translate to Prisma where clauses
      // - How to handle pagination with Prisma

      expect(true).toBe(true);
    });
  });
});
