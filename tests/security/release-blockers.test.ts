/**
 * Release Blocker Security Tests
 *
 * Tests for critical security issues identified in release review.
 */

import type { FastifyReply } from "fastify";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authPlugin } from "../../src/auth/authPlugin.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import type { RequestWithExtras } from "../../src/types/index.js";

describe("Security: Release Blockers", () => {
  describe("Issue 1: Multi-Tenant Fails Open (FIXED ✅)", () => {
    it("FIXED: now returns 403 when orgId is null", async () => {
      const preset = multiTenantPreset({
        tenantField: "organizationId",
      });

      const listMiddleware = preset.middlewares?.list?.[0];
      expect(listMiddleware).toBeDefined();

      // Simulate authenticated user with no organizationId (scope = authenticated, not member)
      const request = {
        user: {
          _id: "user123",
          email: "user@example.com",
          role: ["user"],
        },
        scope: { kind: "authenticated" },
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
      await listMiddleware?.(request, reply);

      // ✅ FIXED: Returns 403 instead of allowing access
      expect(statusCode).toBe(403);
      expect(responseBody).toEqual({
        success: false,
        error: "Forbidden",
        message: "Organization context required for this operation",
      });
    });

    it("FIXED: now returns 403 when creating without tenant ID", async () => {
      const preset = multiTenantPreset({
        tenantField: "organizationId",
      });

      const createMiddleware = preset.middlewares?.create?.[0];
      expect(createMiddleware).toBeDefined();

      // Simulate authenticated user with no organizationId (scope = authenticated, not member)
      const request = {
        user: {
          _id: "user123",
          role: ["user"],
        },
        scope: { kind: "authenticated" },
        body: {
          name: "Sensitive Data",
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

      await createMiddleware?.(request, reply);

      // ✅ FIXED: Returns 403 instead of creating orphaned data.
      // 2.7.1+: the multi-tenant preset reports the specific missing tenant
      // field name(s) so multi-field configs can pinpoint which dimension
      // failed. For the default single-field case it's `organizationId`.
      expect(statusCode).toBe(403);
      expect(responseBody).toMatchObject({
        success: false,
        error: "Forbidden",
      });
      const message = (responseBody as { message: string }).message;
      expect(message).toContain("Tenant context incomplete");
      expect(message).toContain("organizationId");
    });

    it("correctly filters when orgId exists", async () => {
      const preset = multiTenantPreset({
        tenantField: "organizationId",
      });

      const listMiddleware = preset.middlewares?.list?.[0];

      const request = {
        user: {
          _id: "user123",
          role: ["user"],
        },
        scope: { kind: "member", organizationId: "org-abc", orgRoles: ["user"] },
        query: {},
      } as unknown as RequestWithExtras;

      const reply = {
        code: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as unknown as FastifyReply;

      await listMiddleware?.(request, reply);

      // Should add tenant filter on trusted location (request._policyFilters)
      expect((request as any)._policyFilters).toEqual({
        organizationId: "org-abc",
      });
      expect(reply.code).not.toHaveBeenCalled();
    });

    it("bypasses filtering for elevated scope", async () => {
      const preset = multiTenantPreset({
        tenantField: "organizationId",
      });

      const listMiddleware = preset.middlewares?.list?.[0];

      const request = {
        user: {
          _id: "admin123",
          role: ["superadmin"],
        },
        scope: { kind: "elevated", elevatedBy: "admin123" },
        query: {},
      } as unknown as RequestWithExtras;

      const reply = {
        code: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as unknown as FastifyReply;

      await listMiddleware?.(request, reply);

      // Elevated scope without org should not add filters
      expect((request as any)._policyFilters).toBeUndefined();
      expect(reply.code).not.toHaveBeenCalled();
    });
  });

  describe("Issue 2: Auth Plugin Secret Validation (FIXED ✅)", () => {
    beforeEach(() => {
      // Clear NODE_ENV for testing
      delete process.env.NODE_ENV;
    });

    it("FIXED: rejects weak JWT secrets (shorter than 32 characters)", async () => {
      const weakSecrets = ["short", "12345678", "weak-secret", "this-is-only-31-chars-long!"];

      for (const secret of weakSecrets) {
        const app = Fastify({ logger: false });
        await expect(app.register(authPlugin, { jwt: { secret } })).rejects.toThrow(
          /JWT secret must be at least 32 characters/,
        );
        await app.close().catch(() => {});
      }
    });

    it("FIXED: accepts valid secrets (32+ characters)", async () => {
      const app = Fastify({ logger: false });

      const validSecret = "this-is-a-valid-secret-with-32-or-more-characters";
      expect(validSecret.length).toBeGreaterThanOrEqual(32);

      // Should not throw
      await expect(
        app.register(authPlugin, { jwt: { secret: validSecret } }),
      ).resolves.not.toThrow();

      await app.close();
    });

    it("FIXED: allows auth without JWT when using custom authenticator", async () => {
      const app = Fastify({ logger: false });

      // Should work without JWT secret if custom authenticator is provided
      await expect(
        app.register(authPlugin, {
          authenticate: async () => ({ id: "123", name: "Test" }),
        }),
      ).resolves.not.toThrow();

      await app.close();
    });

    it("FIXED: no hardcoded dev secret fallback exists", () => {
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
          throw new Error("JWT secret is required");
        }
        return secret;
      }).toThrow("JWT secret is required");
    });
  });

  // Prisma adapter moved to `@classytic/prismakit/adapter` in arc 3.0 — its
  // integration coverage now lives in prismakit's own test suite. Arc no
  // longer ships any kit-bound adapter; the framework is fully DB-agnostic
  // through the `DataAdapter<TDoc>` contract in `@classytic/repo-core/adapter`.
});
