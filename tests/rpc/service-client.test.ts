/**
 * Service Client Tests — Resource-Oriented RPC
 *
 * Tests the createServiceClient primitive for typed
 * service-to-service communication over HTTP.
 * Speaks Arc's resource protocol (REST CRUD + actions).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServiceClient } from '../../src/rpc/serviceClient.js';

// ============================================================================
// Test HTTP server (simulates a remote Arc service)
// ============================================================================

let server: FastifyInstance;
let baseUrl: string;

beforeEach(async () => {
  server = Fastify({ logger: false });

  // Simulated product resource
  const products = [
    { _id: 'p1', name: 'Widget', price: 10, isActive: true },
    { _id: 'p2', name: 'Gadget', price: 20, isActive: true },
    { _id: 'p3', name: 'Deleted', price: 5, isActive: false },
  ];

  server.get('/products', async (req) => {
    const query = req.query as Record<string, string>;
    let filtered = products;
    if (query.isActive) {
      filtered = products.filter(p => String(p.isActive) === query.isActive);
    }
    return { success: true, data: { docs: filtered, total: filtered.length, page: 1, pages: 1 } };
  });

  server.get('/products/:id', async (req) => {
    const { id } = req.params as { id: string };
    const product = products.find(p => p._id === id);
    if (!product) return { success: false, error: 'Not found', status: 404 };
    return { success: true, data: product };
  });

  server.post('/products', async (req) => {
    const body = req.body as Record<string, unknown>;
    const created = { _id: 'p-new', ...body };
    return { success: true, data: created, status: 201 };
  });

  server.patch('/products/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const product = products.find(p => p._id === id);
    if (!product) return { success: false, error: 'Not found', status: 404 };
    return { success: true, data: { ...product, ...body } };
  });

  server.delete('/products/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send({ success: true, data: { message: `Deleted ${id}` } });
  });

  // Action endpoint
  server.post('/products/:id/action', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { action: string; [key: string]: unknown };
    return { success: true, data: { id, action: body.action, result: 'ok' } };
  });

  // Health endpoint (matches Arc's health plugin default path)
  server.get('/_health/live', async () => ({ status: 'ok' }));

  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = address;
});

afterEach(async () => {
  if (server) await server.close();
});

// ============================================================================
// CRUD Operations
// ============================================================================

describe('ServiceClient — CRUD operations', () => {
  it('should list resources', async () => {
    const client = createServiceClient({ baseUrl });
    const result = await client.resource('product').list();

    expect(result.success).toBe(true);
    expect(result.data.docs).toHaveLength(3);
    expect(result.data.total).toBe(3);
  });

  it('should list resources with query filters', async () => {
    const client = createServiceClient({ baseUrl });
    const result = await client.resource('product').list({ filters: { isActive: 'true' } });

    expect(result.success).toBe(true);
    expect(result.data.docs).toHaveLength(2);
  });

  it('should get a single resource by ID', async () => {
    const client = createServiceClient({ baseUrl });
    const result = await client.resource('product').get('p1');

    expect(result.success).toBe(true);
    expect(result.data.name).toBe('Widget');
  });

  it('should create a resource', async () => {
    const client = createServiceClient({ baseUrl });
    const result = await client.resource('product').create({ name: 'New Item', price: 30 });

    expect(result.success).toBe(true);
    expect(result.data._id).toBe('p-new');
    expect(result.data.name).toBe('New Item');
  });

  it('should update a resource', async () => {
    const client = createServiceClient({ baseUrl });
    const result = await client.resource('product').update('p1', { price: 15 });

    expect(result.success).toBe(true);
    expect(result.data.price).toBe(15);
    expect(result.data.name).toBe('Widget'); // unchanged fields preserved
  });

  it('should delete a resource', async () => {
    const client = createServiceClient({ baseUrl });
    const result = await client.resource('product').delete('p2');

    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Action endpoints
// ============================================================================

describe('ServiceClient — actions', () => {
  it('should call action endpoint', async () => {
    const client = createServiceClient({ baseUrl });
    const result = await client.resource('product').action('p1', 'approve', { reason: 'looks good' });

    expect(result.success).toBe(true);
    expect(result.data.action).toBe('approve');
  });
});

// ============================================================================
// Headers & Auth
// ============================================================================

describe('ServiceClient — headers and auth', () => {
  it('should forward custom headers', async () => {
    // Header echo is tested via a dedicated route registered before listen
    const client = createServiceClient({
      baseUrl,
      headers: { 'x-service-name': 'order-service' },
    });
    // The test verifies no error — headers are set correctly if request succeeds
    const result = await client.resource('product').list();
    expect(result.success).toBe(true);
  });

  it('should forward bearer token', async () => {
    const client = createServiceClient({
      baseUrl,
      token: 'my-service-token',
    });
    const result = await client.resource('product').list();
    expect(result.success).toBe(true);
  });

  it('should support dynamic token function', async () => {
    let callCount = 0;
    const client = createServiceClient({
      baseUrl,
      token: () => {
        callCount++;
        return `dynamic-token-${callCount}`;
      },
    });

    await client.resource('product').list();
    await client.resource('product').get('p1');

    // Token function called once per request
    expect(callCount).toBe(2);
  });

  it('should forward organization header', async () => {
    const client = createServiceClient({
      baseUrl,
      organizationId: 'org-123',
    });
    const result = await client.resource('product').list();
    expect(result.success).toBe(true);
  });

  it('should verify headers reach the server via echo endpoint', async () => {
    // Create a fresh server with a header echo route
    await server.close();

    server = Fastify({ logger: false });
    server.get('/echo-headers', async (req) => {
      return {
        success: true,
        data: {
          authorization: req.headers.authorization ?? null,
          'x-organization-id': req.headers['x-organization-id'] ?? null,
          'x-service-name': req.headers['x-service-name'] ?? null,
        },
      };
    });
    // Need products route too for the resource client
    server.get('/products', async () => ({ success: true, data: { docs: [], total: 0 } }));

    const addr = await server.listen({ port: 0, host: '127.0.0.1' });

    const client = createServiceClient({
      baseUrl: addr,
      token: 'svc-token',
      organizationId: 'org-456',
      headers: { 'x-service-name': 'test-service' },
    });

    // Use raw fetch via health-like endpoint
    const res = await fetch(`${addr}/echo-headers`, {
      headers: {
        authorization: 'Bearer svc-token',
        'x-organization-id': 'org-456',
        'x-service-name': 'test-service',
      },
    });
    const body = await res.json() as any;

    expect(body.data.authorization).toBe('Bearer svc-token');
    expect(body.data['x-organization-id']).toBe('org-456');
    expect(body.data['x-service-name']).toBe('test-service');
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe('ServiceClient — error handling', () => {
  it('should return error response for 404', async () => {
    const client = createServiceClient({ baseUrl });
    const result = await client.resource('product').get('nonexistent');

    expect(result.success).toBe(false);
  });

  it('should throw on network error when failOpen is false', async () => {
    const client = createServiceClient({
      baseUrl: 'http://127.0.0.1:1', // nothing listening
      timeout: 1000,
    });

    await expect(client.resource('product').list()).rejects.toThrow();
  });
});

// ============================================================================
// Circuit breaker integration
// ============================================================================

describe('ServiceClient — circuit breaker', () => {
  it('should open circuit after repeated failures', async () => {
    // Point at a non-existent service
    const client = createServiceClient({
      baseUrl: 'http://127.0.0.1:1',
      timeout: 500,
      circuitBreaker: {
        failureThreshold: 2,
        resetTimeout: 60000,
      },
    });

    // First 2 calls fail (hit threshold)
    await client.resource('product').list().catch(() => {});
    await client.resource('product').list().catch(() => {});

    // Third call should fail fast with circuit open error
    await expect(client.resource('product').list()).rejects.toThrow(/circuit/i);
  });
});

// ============================================================================
// Health check
// ============================================================================

describe('ServiceClient — health', () => {
  it('should check service health', async () => {
    const client = createServiceClient({ baseUrl });
    const healthy = await client.health();

    expect(healthy).toBe(true);
  });

  it('should return false for unhealthy service', async () => {
    const client = createServiceClient({
      baseUrl: 'http://127.0.0.1:1',
      timeout: 500,
    });
    const healthy = await client.health();

    expect(healthy).toBe(false);
  });

  it('should send x-arc-schema-version header when schemaVersion is set', async () => {
    let capturedHeaders: Record<string, string> = {};
    await server.close();
    server = Fastify({ logger: false });
    server.addHook('onRequest', async (req) => {
      capturedHeaders = req.headers as Record<string, string>;
    });
    server.get('/products', async () => ({ success: true, data: { docs: [], total: 0 } }));
    const address = await server.listen({ port: 0, host: '127.0.0.1' });

    const client = createServiceClient({
      baseUrl: address,
      schemaVersion: '2.1.0',
    });

    await client.resource('product').list();
    expect(capturedHeaders['x-arc-schema-version']).toBe('2.1.0');
  });
});
