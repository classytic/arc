/**
 * Better Auth Org Context Tests
 *
 * Tests the orgContext bridge that populates request.organizationId
 * and request.context.orgRoles from Better Auth's organization plugin.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createBetterAuthAdapter, type BetterAuthHandler } from '../../src/auth/betterAuth.js';

// ============================================================================
// Mock auth handlers
// ============================================================================

/** Auth handler with org membership support */
function createOrgAuthHandler(opts: {
  activeOrgId?: string;
  memberRole?: string;
  memberNotFound?: boolean;
  userRoles?: string[];
} = {}): BetterAuthHandler {
  return {
    handler: async (request: Request) => {
      const url = new URL(request.url);

      // GET /api/auth/get-session
      if (url.pathname.endsWith('/get-session')) {
        return new Response(JSON.stringify({
          user: {
            id: 'user-1',
            name: 'Test User',
            email: 'test@example.com',
            roles: opts.userRoles ?? [],
          },
          session: {
            id: 'session-1',
            activeOrganizationId: opts.activeOrgId ?? null,
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      // GET /api/auth/organization/get-active-member
      if (url.pathname.endsWith('/organization/get-active-member')) {
        if (opts.memberNotFound) {
          return new Response(JSON.stringify(null), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({
          id: 'member-1',
          userId: 'user-1',
          organizationId: opts.activeOrgId,
          role: opts.memberRole ?? 'member',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Better Auth Org Context Bridge', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('populates request.organizationId and orgRoles for org member', async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: 'org-123', memberRole: 'admin,member' }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedOrgId: unknown;
    let capturedContext: unknown;
    app.get('/test', { preHandler: [app.authenticate] }, async (request) => {
      capturedOrgId = (request as any).organizationId;
      capturedContext = (request as any).context;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(capturedOrgId).toBe('org-123');
    expect(capturedContext).toEqual({
      organizationId: 'org-123',
      orgRoles: ['admin', 'member'],
      orgScope: 'member',
    });
  });

  it('sets orgScope=public when no active organization', async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: undefined }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedContext: unknown;
    app.get('/test', { preHandler: [app.authenticate] }, async (request) => {
      capturedContext = (request as any).context;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(capturedContext).toEqual({ orgScope: 'public' });
  });

  it('sets orgScope=bypass for superadmin users', async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: 'org-123', userRoles: ['superadmin'] }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedContext: unknown;
    app.get('/test', { preHandler: [app.authenticate] }, async (request) => {
      capturedContext = (request as any).context;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(capturedContext).toEqual({
      organizationId: 'org-123',
      orgRoles: ['superadmin'],
      orgScope: 'bypass',
    });
  });

  it('sets orgScope=public when user is not a member', async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: 'org-123', memberNotFound: true }),
      orgContext: true,
    });
    await app.register(plugin);

    let capturedContext: unknown;
    app.get('/test', { preHandler: [app.authenticate] }, async (request) => {
      capturedContext = (request as any).context;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(capturedContext).toEqual({ orgScope: 'public' });
  });

  it('supports custom bypassRoles', async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: 'org-1', userRoles: ['god'] }),
      orgContext: { bypassRoles: ['god'] },
    });
    await app.register(plugin);

    let capturedContext: unknown;
    app.get('/test', { preHandler: [app.authenticate] }, async (request) => {
      capturedContext = (request as any).context;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect((capturedContext as any).orgScope).toBe('bypass');
  });

  it('does not set org context when orgContext is disabled', async () => {
    app = Fastify({ logger: false });
    const { plugin } = createBetterAuthAdapter({
      auth: createOrgAuthHandler({ activeOrgId: 'org-123', memberRole: 'admin' }),
      // orgContext not set (defaults to false)
    });
    await app.register(plugin);

    let capturedContext: unknown;
    let capturedOrgId: unknown;
    app.get('/test', { preHandler: [app.authenticate] }, async (request) => {
      capturedContext = (request as any).context;
      capturedOrgId = (request as any).organizationId;
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(capturedContext).toBeUndefined();
    expect(capturedOrgId).toBeUndefined();
  });

  it('returns permissions helper with bound bypass roles', () => {
    const { permissions } = createBetterAuthAdapter({
      auth: createOrgAuthHandler(),
      orgContext: true,
    });

    expect(permissions.requireOrgRole).toBeDefined();
    expect(permissions.requireOrgMembership).toBeDefined();
    expect(typeof permissions.requireOrgRole('admin')).toBe('function');
    expect(typeof permissions.requireOrgMembership()).toBe('function');
  });
});
