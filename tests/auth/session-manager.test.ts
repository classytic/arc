/**
 * Session Manager Tests
 *
 * Tests the full session lifecycle:
 * - Session creation with signed cookies
 * - Authentication via session cookie
 * - Session revocation (single, all, all-except-current)
 * - Session refresh (throttled by updateAge)
 * - requireFresh preHandler
 * - MemorySessionStore cleanup
 * - Tampered cookie rejection
 * - Expired session handling
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createSessionManager, MemorySessionStore } from '../../src/auth/sessionManager.js';

const SECRET = 'a-secure-session-secret-that-is-at-least-32-characters!!';

describe('Session Manager', () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;

  afterEach(async () => {
    await app?.close().catch(() => {});
    store?.close();
  });

  async function createApp(opts: Record<string, unknown> = {}) {
    store = new MemorySessionStore({ cleanupIntervalMs: 60_000 });
    const sessions = createSessionManager({
      store,
      secret: SECRET,
      maxAge: 7 * 24 * 60 * 60, // 7 days
      updateAge: 24 * 60 * 60,  // 24h
      freshAge: 10 * 60,        // 10 min
      cookie: { secure: false }, // Disable secure for testing
      ...opts,
    });

    app = Fastify({ logger: false });
    await app.register(sessions.plugin);

    // Login route — creates a session
    app.post('/login', async (request, reply) => {
      const body = request.body as { userId: string; metadata?: Record<string, unknown> };
      const { cookie } = await app.sessionManager.createSession(body.userId, body.metadata);
      reply.header('Set-Cookie', cookie);
      return { success: true };
    });

    // Protected route
    app.get('/me', {
      preHandler: [app.authenticate],
    }, async (request) => {
      return { user: (request as any).user, session: (request as any).session };
    });

    // Sensitive route (requireFresh)
    app.post('/change-password', {
      preHandler: [app.authenticate, sessions.requireFresh],
    }, async () => {
      return { success: true, message: 'Password changed' };
    });

    // Logout route
    app.post('/logout', {
      preHandler: [app.authenticate],
    }, async (request) => {
      const session = (request as any).session;
      await app.sessionManager.revokeSession(session.id);
      return { success: true };
    });

    // Logout all sessions
    app.post('/logout-all', {
      preHandler: [app.authenticate],
    }, async (request) => {
      const user = (request as any).user;
      await app.sessionManager.revokeAllSessions(user.id);
      return { success: true };
    });

    // Logout other sessions
    app.post('/logout-others', {
      preHandler: [app.authenticate],
    }, async (request) => {
      const user = (request as any).user;
      const session = (request as any).session;
      await app.sessionManager.revokeOtherSessions(user.id, session.id);
      return { success: true };
    });

    // Refresh session
    app.post('/refresh', {
      preHandler: [app.authenticate],
    }, async (request) => {
      const session = (request as any).session;
      const result = await app.sessionManager.refreshSession(session.id);
      return { success: true, session: result };
    });

    await app.ready();
    return { app, sessions };
  }

  /** Helper: login and get the session cookie */
  async function login(userId = 'user-1', metadata?: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { userId, metadata },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toBeDefined();
    // Extract just the cookie name=value part
    const cookieValue = setCookie.split(';')[0]!;
    return cookieValue;
  }

  // ========================================================================
  // Session Creation
  // ========================================================================

  describe('Session Creation', () => {
    it('should create a session and return a signed cookie', async () => {
      await createApp();
      const cookie = await login('user-1');

      expect(cookie).toContain('arc.session=');
      // Signed cookie format: arc.session=<uuid>.<signature>
      const value = cookie.split('=')[1]!;
      const decoded = decodeURIComponent(value);
      expect(decoded).toContain('.');
    });

    it('should set correct cookie attributes', async () => {
      await createApp();
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        payload: { userId: 'user-1' },
      });

      const setCookie = res.headers['set-cookie'] as string;
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');
      expect(setCookie).toContain('Max-Age=604800'); // 7 days
    });

    it('should store session with metadata', async () => {
      await createApp();
      const cookie = await login('user-1', { role: 'admin', ip: '127.0.0.1' });

      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user.id).toBe('user-1');
      expect(body.user.role).toBe('admin');
      expect(body.user.ip).toBe('127.0.0.1');
    });

    it('should track session in MemorySessionStore stats', async () => {
      await createApp();
      expect(store.getStats().sessions).toBe(0);

      await login('user-1');
      expect(store.getStats().sessions).toBe(1);
      expect(store.getStats().users).toBe(1);

      await login('user-1'); // Second session for same user
      expect(store.getStats().sessions).toBe(2);
      expect(store.getStats().users).toBe(1);

      await login('user-2'); // Different user
      expect(store.getStats().sessions).toBe(3);
      expect(store.getStats().users).toBe(2);
    });
  });

  // ========================================================================
  // Authentication
  // ========================================================================

  describe('Authentication', () => {
    it('should authenticate with valid session cookie', async () => {
      await createApp();
      const cookie = await login('user-42');

      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user.id).toBe('user-42');
      expect(body.session).toBeDefined();
      expect(body.session.userId).toBe('user-42');
    });

    it('should return 401 when no cookie present', async () => {
      await createApp();

      const res = await app.inject({
        method: 'GET',
        url: '/me',
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.message).toBe('No session cookie');
    });

    it('should reject tampered cookie signature', async () => {
      await createApp();
      const cookie = await login('user-1');

      // Tamper with the signature portion of the cookie value
      // Cookie format: arc.session=<uuid>.<signature>
      // The cookie name itself has a dot (arc.session) so we must only
      // modify the value portion (after the first '=')
      const eqIdx = cookie.indexOf('=');
      const cookieName = cookie.slice(0, eqIdx);
      const decoded = decodeURIComponent(cookie.slice(eqIdx + 1));
      const lastDot = decoded.lastIndexOf('.');
      const tampered = decoded.slice(0, lastDot) + '.tampered-signature';
      const tamperedCookie = `${cookieName}=${encodeURIComponent(tampered)}`;

      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { cookie: tamperedCookie },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.message).toBe('Invalid session');
      // Should clear the cookie
      const setCookie = res.headers['set-cookie'] as string;
      expect(setCookie).toContain('Max-Age=0');
    });

    it('should reject expired session', async () => {
      await createApp({ maxAge: 1 }); // 1 second

      const cookie = await login('user-1');

      // Wait for session to expire
      await new Promise((r) => setTimeout(r, 1500));

      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { cookie },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject cookie with invalid format (no dot)', async () => {
      await createApp();

      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { cookie: 'arc.session=no-dot-in-value' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ========================================================================
  // Session Revocation
  // ========================================================================

  describe('Session Revocation', () => {
    it('should revoke a single session (logout)', async () => {
      await createApp();
      const cookie = await login('user-1');

      // Logout
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie },
      });
      expect(logoutRes.statusCode).toBe(200);

      // Session should be invalid now
      const meRes = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { cookie },
      });
      expect(meRes.statusCode).toBe(401);
    });

    it('should revoke all sessions for a user', async () => {
      await createApp();
      const cookie1 = await login('user-1');
      const cookie2 = await login('user-1');
      const otherCookie = await login('user-2');

      // Revoke all for user-1
      const res = await app.inject({
        method: 'POST',
        url: '/logout-all',
        headers: { cookie: cookie1 },
      });
      expect(res.statusCode).toBe(200);

      // Both user-1 sessions should be invalid
      const me1 = await app.inject({ method: 'GET', url: '/me', headers: { cookie: cookie1 } });
      expect(me1.statusCode).toBe(401);

      const me2 = await app.inject({ method: 'GET', url: '/me', headers: { cookie: cookie2 } });
      expect(me2.statusCode).toBe(401);

      // user-2 session should still work
      const me3 = await app.inject({ method: 'GET', url: '/me', headers: { cookie: otherCookie } });
      expect(me3.statusCode).toBe(200);
    });

    it('should revoke other sessions (keep current)', async () => {
      await createApp();
      const cookie1 = await login('user-1');
      const cookie2 = await login('user-1');
      const cookie3 = await login('user-1');

      // Revoke others, keep cookie1
      const res = await app.inject({
        method: 'POST',
        url: '/logout-others',
        headers: { cookie: cookie1 },
      });
      expect(res.statusCode).toBe(200);

      // cookie1 should still work
      const me1 = await app.inject({ method: 'GET', url: '/me', headers: { cookie: cookie1 } });
      expect(me1.statusCode).toBe(200);

      // cookie2 and cookie3 should be revoked
      const me2 = await app.inject({ method: 'GET', url: '/me', headers: { cookie: cookie2 } });
      expect(me2.statusCode).toBe(401);

      const me3 = await app.inject({ method: 'GET', url: '/me', headers: { cookie: cookie3 } });
      expect(me3.statusCode).toBe(401);
    });

    it('should update store stats after revocation', async () => {
      await createApp();
      await login('user-1');
      await login('user-1');
      expect(store.getStats().sessions).toBe(2);

      const cookie = await login('user-1');
      expect(store.getStats().sessions).toBe(3);

      // Revoke all
      await app.inject({
        method: 'POST',
        url: '/logout-all',
        headers: { cookie },
      });

      expect(store.getStats().sessions).toBe(0);
      expect(store.getStats().users).toBe(0);
    });
  });

  // ========================================================================
  // Session Refresh
  // ========================================================================

  describe('Session Refresh', () => {
    it('should refresh session via explicit endpoint', async () => {
      await createApp();
      const cookie = await login('user-1');

      // Get original session data
      const me1 = await app.inject({ method: 'GET', url: '/me', headers: { cookie } });
      const originalSession = JSON.parse(me1.body).session;

      // Wait a tick
      await new Promise((r) => setTimeout(r, 50));

      // Refresh
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/refresh',
        headers: { cookie },
      });
      expect(refreshRes.statusCode).toBe(200);
      const refreshBody = JSON.parse(refreshRes.body);
      expect(refreshBody.session.updatedAt).toBeGreaterThanOrEqual(originalSession.updatedAt);
    });

    it('should NOT auto-refresh within updateAge window', async () => {
      await createApp({ updateAge: 3600 }); // 1 hour
      const cookie = await login('user-1');

      // Multiple requests within 1 hour should NOT trigger auto-refresh (no Set-Cookie)
      const res = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      // Should NOT have a Set-Cookie header (updateAge not exceeded)
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeUndefined();
    });
  });

  // ========================================================================
  // requireFresh
  // ========================================================================

  describe('requireFresh', () => {
    it('should allow access to fresh session', async () => {
      await createApp({ freshAge: 600 }); // 10 minutes
      const cookie = await login('user-1');

      // Session just created, so it's fresh
      const res = await app.inject({
        method: 'POST',
        url: '/change-password',
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.message).toBe('Password changed');
    });

    it('should reject stale session', async () => {
      await createApp({ freshAge: 1 }); // 1 second freshAge
      const cookie = await login('user-1');

      // Wait for session to become stale (> freshAge)
      await new Promise((r) => setTimeout(r, 1500));

      const res = await app.inject({
        method: 'POST',
        url: '/change-password',
        headers: { cookie },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('SessionNotFresh');
      expect(body.code).toBe('SESSION_NOT_FRESH');
    });

    it('should return 401 when no session at all', async () => {
      await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/change-password',
        // No cookie
      });

      // authenticate preHandler fires first → 401
      expect(res.statusCode).toBe(401);
    });
  });

  // ========================================================================
  // Secret Validation
  // ========================================================================

  describe('Secret Validation', () => {
    it('should reject secret shorter than 32 characters', () => {
      expect(() => {
        createSessionManager({
          store: new MemorySessionStore(),
          secret: 'short-secret',
        });
      }).toThrow('Session secret must be at least 32 characters');
    });
  });

  // ========================================================================
  // MemorySessionStore
  // ========================================================================

  describe('MemorySessionStore', () => {
    it('should return null for non-existent session', async () => {
      const s = new MemorySessionStore();
      const result = await s.get('nonexistent-id');
      expect(result).toBeNull();
      s.close();
    });

    it('should auto-expire sessions on get', async () => {
      const s = new MemorySessionStore();
      await s.set('test-session', {
        userId: 'user-1',
        createdAt: Date.now() - 10000,
        updatedAt: Date.now() - 10000,
        expiresAt: Date.now() - 1000, // Already expired
      });

      const result = await s.get('test-session');
      expect(result).toBeNull();
      s.close();
    });

    it('should handle deleteAllExcept when session not in set', async () => {
      const s = new MemorySessionStore();
      await s.set('s1', {
        userId: 'user-1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + 100000,
      });

      // Delete all except a non-existent session
      await s.deleteAllExcept('user-1', 'nonexistent');
      expect(s.getStats().sessions).toBe(0);
      s.close();
    });

    it('should close and clear all data', () => {
      const s = new MemorySessionStore();
      s.close();
      expect(s.getStats().sessions).toBe(0);
      expect(s.getStats().users).toBe(0);
    });
  });
});
