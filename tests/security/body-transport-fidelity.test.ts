/**
 * Better Auth Body Transport Fidelity Tests
 *
 * Verifies that toFetchRequest() preserves content-type semantics
 * when bridging Fastify requests to the Fetch API for Better Auth.
 *
 * Scenarios:
 * - JSON body (application/json) → JSON.stringify
 * - Form-urlencoded body → URLSearchParams reconstruction
 * - String body → pass-through
 * - GET/HEAD requests → no body
 * - rawBody available → prefer rawBody
 */

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createBetterAuthAdapter, type BetterAuthHandler } from '../../src/auth/betterAuth.js';

/**
 * Inspecting auth handler that captures the reconstructed Request
 * body and content-type as received by Better Auth.
 */
function createBodyInspector() {
  let capturedBody = '';
  let capturedContentType = '';
  let capturedMethod = '';

  const handler: BetterAuthHandler = {
    handler: async (request: Request) => {
      capturedMethod = request.method;
      capturedContentType = request.headers.get('content-type') ?? '';
      capturedBody = await request.text();

      // Return a valid session so authenticate() doesn't 401
      const url = new URL(request.url);
      if (url.pathname.endsWith('/get-session')) {
        return new Response(JSON.stringify({
          user: { id: 'u1', name: 'Test' },
          session: { id: 's1' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };

  return {
    handler,
    get body() { return capturedBody; },
    get contentType() { return capturedContentType; },
    get method() { return capturedMethod; },
    reset() { capturedBody = ''; capturedContentType = ''; capturedMethod = ''; },
  };
}

describe('Better Auth Body Transport Fidelity', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  // --------------------------------------------------------------------------
  // JSON body (default path)
  // --------------------------------------------------------------------------

  describe('JSON body (application/json)', () => {
    it('should serialize JSON body via JSON.stringify', async () => {
      const inspector = createBodyInspector();
      app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({ auth: inspector.handler });
      await app.register(plugin);
      await app.ready();

      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'test@example.com', password: 'secret' },
      });

      expect(inspector.method).toBe('POST');
      const parsed = JSON.parse(inspector.body);
      expect(parsed).toEqual({ email: 'test@example.com', password: 'secret' });
    });
  });

  // --------------------------------------------------------------------------
  // Form-urlencoded body
  // --------------------------------------------------------------------------

  describe('Form-urlencoded body', () => {
    it('should reconstruct URLSearchParams for form-urlencoded content', async () => {
      const inspector = createBodyInspector();
      app = Fastify({ logger: false });

      // Fastify needs a content-type parser for form-urlencoded
      // (not registered by default in bare Fastify)
      app.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_req, body, done) => {
          const params = new URLSearchParams(body as string);
          const obj: Record<string, string> = {};
          params.forEach((v, k) => { obj[k] = v; });
          done(null, obj);
        },
      );

      const { plugin } = createBetterAuthAdapter({ auth: inspector.handler });
      await app.register(plugin);
      await app.ready();

      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=test%40example.com&password=secret123',
      });

      expect(inspector.method).toBe('POST');
      // The body should be parseable as URLSearchParams
      const params = new URLSearchParams(inspector.body);
      expect(params.get('email')).toBe('test@example.com');
      expect(params.get('password')).toBe('secret123');
    });

    it('should handle form-urlencoded with empty values gracefully', async () => {
      const inspector = createBodyInspector();
      app = Fastify({ logger: false });

      app.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_req, body, done) => {
          const params = new URLSearchParams(body as string);
          const obj: Record<string, string> = {};
          params.forEach((v, k) => { obj[k] = v; });
          done(null, obj);
        },
      );

      const { plugin } = createBetterAuthAdapter({ auth: inspector.handler });
      await app.register(plugin);
      await app.ready();

      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'username=testuser&remember=',
      });

      const params = new URLSearchParams(inspector.body);
      expect(params.get('username')).toBe('testuser');
    });
  });

  // --------------------------------------------------------------------------
  // String body (pass-through)
  // --------------------------------------------------------------------------

  describe('String body pass-through', () => {
    it('should pass string body as-is when content-type is text', async () => {
      const inspector = createBodyInspector();
      app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({ auth: inspector.handler });

      // Register a custom content-type parser for text/plain
      app.addContentTypeParser('text/plain', { parseAs: 'string' }, (req, body, done) => {
        done(null, body);
      });

      await app.register(plugin);
      await app.ready();

      await app.inject({
        method: 'POST',
        url: '/api/auth/callback',
        headers: { 'content-type': 'text/plain' },
        payload: 'raw-token-data-here',
      });

      expect(inspector.body).toBe('raw-token-data-here');
    });
  });

  // --------------------------------------------------------------------------
  // GET/HEAD requests — no body
  // --------------------------------------------------------------------------

  describe('GET/HEAD requests (no body)', () => {
    it('should not send a body for GET requests', async () => {
      const inspector = createBodyInspector();
      app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({ auth: inspector.handler });
      await app.register(plugin);
      await app.ready();

      await app.inject({ method: 'GET', url: '/api/auth/get-session' });

      expect(inspector.body).toBe('');
    });

    it('should not send a body for HEAD requests', async () => {
      const inspector = createBodyInspector();
      app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({ auth: inspector.handler });
      await app.register(plugin);
      await app.ready();

      await app.inject({ method: 'HEAD', url: '/api/auth/get-session' });

      // HEAD should not carry a body
      expect(inspector.body).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // null/undefined body
  // --------------------------------------------------------------------------

  describe('null body on POST', () => {
    it('should not send body when request.body is null', async () => {
      const inspector = createBodyInspector();
      app = Fastify({ logger: false });
      const { plugin } = createBetterAuthAdapter({ auth: inspector.handler });

      // Register parser that returns null
      app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, _body, done) => {
        done(null, null);
      });

      await app.register(plugin);
      await app.ready();

      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-out',
        headers: { 'content-type': 'application/json' },
      });

      // null body should result in no body sent
      expect(inspector.body).toBe('');
    });
  });
});
