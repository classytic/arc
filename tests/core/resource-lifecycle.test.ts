import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { arcCorePlugin } from '../../src/core/arcCorePlugin.js';
import { eventPlugin } from '../../src/events/eventPlugin.js';
import { MemoryEventTransport } from '../../src/events/EventTransport.js';
import type { DomainEvent } from '../../src/events/EventTransport.js';

describe('Resource lifecycle events', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it('arc.ready is emitted on server ready', async () => {
    app = Fastify({ logger: false });
    const transport = new MemoryEventTransport();

    await app.register(eventPlugin, { transport });
    await app.register(arcCorePlugin, { emitEvents: true });

    const captured: DomainEvent[] = [];
    await app.events.subscribe('arc.ready', async (event) => {
      captured.push(event);
    });

    await app.ready();

    // Allow async event delivery
    await new Promise((r) => setTimeout(r, 20));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload).toEqual(
      expect.objectContaining({
        resources: expect.any(Number),
        hooks: expect.any(Number),
        timestamp: expect.any(String),
      }),
    );
  });

  it('does not error when events plugin is not registered', async () => {
    app = Fastify({ logger: false });

    // Register only arcCorePlugin (no eventPlugin)
    await app.register(arcCorePlugin, { emitEvents: true });

    // app.ready() should resolve without errors even though events are enabled
    await expect(app.ready()).resolves.toBeDefined();
  });

  it('CRUD events include correlationId from requestContext', async () => {
    app = Fastify({ logger: false });
    const transport = new MemoryEventTransport();

    await app.register(eventPlugin, { transport });
    await app.register(arcCorePlugin, { emitEvents: true });

    const captured: DomainEvent[] = [];
    await app.events.subscribe('product.created', async (event) => {
      captured.push(event);
    });

    // Define a route that triggers an after hook via the hookSystem.
    // arcCorePlugin registers after('*', 'create', ...) hooks that emit events.
    // executeAfter will run those hooks, which publish 'product.created'.
    app.post('/trigger', async (request, _reply) => {
      await app!.arc.hooks.executeAfter('product', 'create', { _id: 'p1' });
      return { ok: true };
    });

    await app.ready();

    // Inject a request — arcCorePlugin's onRequest hook sets up requestContext
    const response = await app.inject({
      method: 'POST',
      url: '/trigger',
    });

    expect(response.statusCode).toBe(200);

    // Allow async event delivery
    await new Promise((r) => setTimeout(r, 20));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.meta.correlationId).toBeDefined();
    expect(typeof captured[0]!.meta.correlationId).toBe('string');
  });
});
