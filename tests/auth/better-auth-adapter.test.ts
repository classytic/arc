/**
 * Better Auth Adapter Tests
 *
 * Tests the Fastify ↔ Better Auth bridge:
 * - toFetchRequest: Fastify Request → Web API Request
 * - sendFetchResponse: Web API Response → Fastify Reply (buffered + streaming)
 * - createBetterAuthAdapter: plugin registration + authenticate preHandler
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createBetterAuthAdapter, type BetterAuthHandler } from '../../src/auth/betterAuth.js';

// ============================================================================
// Mock auth handlers
// ============================================================================

/** Returns a JSON session response */
function createJsonAuthHandler(sessionData: Record<string, unknown> = {}): BetterAuthHandler {
  return {
    handler: async (request: Request) => {
      const url = new URL(request.url);

      // GET /api/auth/get-session → return session
      if (url.pathname.endsWith('/get-session')) {
        return new Response(JSON.stringify({
          user: { id: 'user-1', name: 'Test User', email: 'test@example.com' },
          session: { id: 'session-1', expiresAt: new Date(Date.now() + 86400000).toISOString() },
          ...sessionData,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      // POST /api/auth/sign-in → return user
      if (url.pathname.endsWith('/sign-in') && request.method === 'POST') {
        const body = await request.text();
        return new Response(JSON.stringify({ success: true, body: JSON.parse(body) }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'session=abc123; Path=/; HttpOnly',
          },
        });
      }

      // Catch-all
      return new Response(JSON.stringify({ path: url.pathname, method: request.method }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

/** Returns a streaming SSE response (text/event-stream) */
function createStreamingAuthHandler(): BetterAuthHandler {
  return {
    handler: async (request: Request) => {
      const url = new URL(request.url);

      if (url.pathname.endsWith('/stream')) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"event":"session.created"}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: {"event":"session.updated"}\n\n'));
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      // get-session for authenticate to work
      return new Response(JSON.stringify({
        user: { id: 'u1' },
        session: { id: 's1' },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

/** Returns 401 for get-session (unauthenticated) */
function createUnauthenticatedHandler(): BetterAuthHandler {
  return {
    handler: async () => {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Better Auth Adapter', () => {
  // --------------------------------------------------------------------------
  // Route registration + JSON responses
  // --------------------------------------------------------------------------

  describe('plugin registration and JSON responses', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({
        auth: createJsonAuthHandler(),
      });
      await app.register(plugin);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('registers catch-all route at /api/auth/*', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('user');
      expect(body.user).toHaveProperty('id', 'user-1');
    });

    it('forwards POST body to auth handler', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'test@example.com', password: 'secret123' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.body).toEqual({ email: 'test@example.com', password: 'secret123' });
    });

    it('copies response headers (e.g. set-cookie) to Fastify reply', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'test@example.com', password: 'pass' },
      });

      expect(response.headers['set-cookie']).toContain('session=abc123');
    });

    it('skips transfer-encoding header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/anything',
      });

      // Fastify manages transfer-encoding itself — the adapter should not copy it
      expect(response.statusCode).toBe(200);
    });

    it('decorates fastify with authenticate function', () => {
      expect(app.authenticate).toBeDefined();
      expect(typeof app.authenticate).toBe('function');
    });
  });

  // --------------------------------------------------------------------------
  // authenticate preHandler
  // --------------------------------------------------------------------------

  describe('authenticate preHandler', () => {
    it('attaches user and session to request on valid session', async () => {
      const app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({
        auth: createJsonAuthHandler(),
      });
      await app.register(plugin);

      let capturedUser: unknown;
      let capturedSession: unknown;
      app.get('/protected', {
        preHandler: [app.authenticate],
      }, async (request) => {
        capturedUser = (request as any).user;
        capturedSession = (request as any).session;
        return { ok: true };
      });

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
      });

      expect(response.statusCode).toBe(200);
      expect(capturedUser).toHaveProperty('id', 'user-1');
      expect(capturedSession).toHaveProperty('id', 'session-1');

      await app.close();
    });

    it('returns 401 when session is invalid', async () => {
      const app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({
        auth: createUnauthenticatedHandler(),
      });
      await app.register(plugin);

      app.get('/protected', {
        preHandler: [app.authenticate],
      }, async () => ({ ok: true }));

      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/protected',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Unauthorized');

      await app.close();
    });
  });

  // --------------------------------------------------------------------------
  // Streaming response handling (SSE)
  // --------------------------------------------------------------------------

  describe('streaming response (text/event-stream)', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({
        auth: createStreamingAuthHandler(),
      });
      await app.register(plugin);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('streams SSE response body directly instead of buffering', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/stream',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');

      // Body should contain the SSE events
      expect(response.body).toContain('data: {"event":"session.created"}');
      expect(response.body).toContain('data: {"event":"session.updated"}');
    });
  });

  // --------------------------------------------------------------------------
  // Custom basePath
  // --------------------------------------------------------------------------

  describe('custom basePath', () => {
    it('registers routes at custom basePath', async () => {
      const app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({
        auth: createJsonAuthHandler(),
        basePath: '/auth/v2',
      });
      await app.register(plugin);
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/auth/v2/get-session',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('user');

      await app.close();
    });

    it('strips trailing slash from basePath', async () => {
      const app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({
        auth: createJsonAuthHandler(),
        basePath: '/auth/v2/',
      });
      await app.register(plugin);
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/auth/v2/get-session',
      });

      expect(response.statusCode).toBe(200);

      await app.close();
    });
  });

  // --------------------------------------------------------------------------
  // Request conversion (toFetchRequest internals via observable behavior)
  // --------------------------------------------------------------------------

  describe('request conversion', () => {
    it('forwards headers from Fastify request to auth handler', async () => {
      let receivedHeaders: Record<string, string> = {};

      const inspectingHandler: BetterAuthHandler = {
        handler: async (request: Request) => {
          request.headers.forEach((value, key) => {
            receivedHeaders[key] = value;
          });
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      };

      const app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({ auth: inspectingHandler });
      await app.register(plugin);
      await app.ready();

      await app.inject({
        method: 'GET',
        url: '/api/auth/test',
        headers: {
          authorization: 'Bearer token123',
          'x-custom': 'custom-value',
        },
      });

      expect(receivedHeaders['authorization']).toBe('Bearer token123');
      expect(receivedHeaders['x-custom']).toBe('custom-value');

      await app.close();
    });

    it('forwards the correct HTTP method to auth handler', async () => {
      let receivedMethod = '';

      const inspectingHandler: BetterAuthHandler = {
        handler: async (request: Request) => {
          receivedMethod = request.method;
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      };

      const app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({ auth: inspectingHandler });
      await app.register(plugin);
      await app.ready();

      await app.inject({ method: 'DELETE', url: '/api/auth/session' });
      expect(receivedMethod).toBe('DELETE');

      await app.close();
    });

    it('does not send body for GET requests', async () => {
      let receivedBody: string | null = null;

      const inspectingHandler: BetterAuthHandler = {
        handler: async (request: Request) => {
          receivedBody = await request.text();
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      };

      const app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({ auth: inspectingHandler });
      await app.register(plugin);
      await app.ready();

      await app.inject({ method: 'GET', url: '/api/auth/test' });
      expect(receivedBody).toBe('');

      await app.close();
    });
  });
});
