/**
 * SSE Plugin Tests
 *
 * Tests Server-Sent Events endpoint registration, response headers,
 * event streaming, and connection lifecycle.
 *
 * Note: SSE endpoints use reply.raw (raw Node streams) which bypass
 * Fastify's inject(). Tests use real HTTP connections with AbortController.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eventPlugin } from '../../src/events/eventPlugin.js';
import ssePlugin from '../../src/plugins/sse.js';
import http from 'node:http';

// ============================================================================
// Helper: fetch SSE endpoint with timeout
// ============================================================================

function fetchSSE(url: string, timeoutMs = 500): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      const timer = setTimeout(() => {
        res.destroy();
        resolve({
          statusCode: res.statusCode!,
          headers: res.headers as Record<string, string>,
          body,
        });
      }, timeoutMs);

      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({
          statusCode: res.statusCode!,
          headers: res.headers as Record<string, string>,
          body,
        });
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    req.on('error', reject);
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('SSE Plugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) {
      try { await app.close(); } catch {}
    }
  });

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  describe('registration', () => {
    it('throws when events plugin is not registered (hard dependency)', async () => {
      app = Fastify({ logger: false });
      // Do NOT register eventPlugin — SSE declares arc-events as a dependency
      // Fastify checks dependencies during boot, so the error surfaces from ready()
      let threw = false;
      try {
        await app.register(ssePlugin, { requireAuth: false });
        await app.ready();
      } catch (err: any) {
        threw = true;
        expect(err.message).toMatch(/arc-events/);
      }
      expect(threw).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // SSE response headers + streaming
  // --------------------------------------------------------------------------

  describe('response headers and streaming', () => {
    it('returns correct SSE headers at default path', async () => {
      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(ssePlugin, { requireAuth: false, heartbeat: 100 });
      await app.listen({ port: 0, host: '127.0.0.1' });

      const address = app.server.address() as { port: number };
      const result = await fetchSSE(`http://127.0.0.1:${address.port}/events/stream`, 300);

      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toBe('text/event-stream');
      expect(result.headers['cache-control']).toBe('no-cache');
      expect(result.headers['connection']).toBe('keep-alive');
    });

    it('registers at custom path', async () => {
      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(ssePlugin, { path: '/api/events', requireAuth: false, heartbeat: 100 });
      await app.listen({ port: 0, host: '127.0.0.1' });

      const address = app.server.address() as { port: number };
      const result = await fetchSSE(`http://127.0.0.1:${address.port}/api/events`, 300);

      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toBe('text/event-stream');
    });

    it('sends heartbeat comments', async () => {
      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(ssePlugin, { requireAuth: false, heartbeat: 50 });
      await app.listen({ port: 0, host: '127.0.0.1' });

      const address = app.server.address() as { port: number };
      // Wait long enough for at least one heartbeat
      const result = await fetchSSE(`http://127.0.0.1:${address.port}/events/stream`, 200);

      expect(result.body).toContain(': heartbeat');
    });

    it('streams published domain events', async () => {
      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(ssePlugin, { requireAuth: false, heartbeat: 60000 });
      await app.listen({ port: 0, host: '127.0.0.1' });

      const address = app.server.address() as { port: number };

      // Start SSE connection, then publish an event after a short delay
      const ssePromise = fetchSSE(`http://127.0.0.1:${address.port}/events/stream`, 500);

      // Wait a bit for the SSE connection to establish, then publish
      await new Promise((r) => setTimeout(r, 100));
      await app.events.publish('order.created', { orderId: '123' });

      const result = await ssePromise;

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('event: order.created');
      expect(result.body).toContain('"orderId":"123"');
    });
  });

  // --------------------------------------------------------------------------
  // Graceful cleanup
  // --------------------------------------------------------------------------

  describe('cleanup', () => {
    it('cleans up on server close without errors', async () => {
      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(ssePlugin, { requireAuth: false, heartbeat: 100 });
      await app.listen({ port: 0, host: '127.0.0.1' });

      const address = app.server.address() as { port: number };

      // Start a connection
      const ssePromise = fetchSSE(`http://127.0.0.1:${address.port}/events/stream`, 5000);

      // Wait for it to connect, then close the server
      await new Promise((r) => setTimeout(r, 100));
      await app.close();

      // The fetch should resolve (connection drops)
      const result = await ssePromise;
      expect(result.statusCode).toBe(200);
    });
  });
});
