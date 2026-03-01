import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eventPlugin } from '../../src/events/eventPlugin.js';
import { MemoryEventTransport } from '../../src/events/EventTransport.js';
import type { DomainEvent, EventTransport, EventHandler } from '../../src/events/EventTransport.js';
import { requestContext } from '../../src/context/requestContext.js';

describe('eventPlugin correlationId injection', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it('auto-injects correlationId from requestContext when not explicitly set', async () => {
    app = Fastify({ logger: false });
    const transport = new MemoryEventTransport();
    await app.register(eventPlugin, { transport });

    const captured: DomainEvent[] = [];
    await app.events.subscribe('*', async (event) => {
      captured.push(event);
    });

    // Publish within a requestContext that has requestId
    await requestContext.storage.run(
      { requestId: 'req-123', startTime: Date.now() },
      async () => {
        await app!.events.publish('order.created', { id: 'o1' });
      },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]!.meta.correlationId).toBe('req-123');
  });

  it('does NOT override an explicit correlationId', async () => {
    app = Fastify({ logger: false });
    const transport = new MemoryEventTransport();
    await app.register(eventPlugin, { transport });

    const captured: DomainEvent[] = [];
    await app.events.subscribe('*', async (event) => {
      captured.push(event);
    });

    await requestContext.storage.run(
      { requestId: 'req-999', startTime: Date.now() },
      async () => {
        await app!.events.publish('order.created', { id: 'o2' }, {
          correlationId: 'explicit-id',
        });
      },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]!.meta.correlationId).toBe('explicit-id');
  });

  it('works without requestContext (no correlationId set)', async () => {
    app = Fastify({ logger: false });
    const transport = new MemoryEventTransport();
    await app.register(eventPlugin, { transport });

    const captured: DomainEvent[] = [];
    await app.events.subscribe('*', async (event) => {
      captured.push(event);
    });

    // Publish outside any requestContext.storage.run
    await app.events.publish('order.created', { id: 'o3' });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.meta.correlationId).toBeUndefined();
  });

  it('onPublish callback fires on successful publish', async () => {
    app = Fastify({ logger: false });
    const transport = new MemoryEventTransport();
    const onPublish = vi.fn();

    await app.register(eventPlugin, { transport, onPublish });

    await app.events.publish('order.created', { id: 'o4' });

    expect(onPublish).toHaveBeenCalledOnce();
    expect(onPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.created',
        payload: { id: 'o4' },
      }),
    );
  });

  it('onPublishError callback fires on transport failure', async () => {
    app = Fastify({ logger: false });

    const failingTransport: EventTransport = {
      name: 'fail',
      async publish() {
        throw new Error('down');
      },
      async subscribe() {
        return () => {};
      },
    };

    const onPublishError = vi.fn();

    await app.register(eventPlugin, {
      transport: failingTransport,
      failOpen: true,
      onPublishError,
    });

    await app.events.publish('order.created', { id: 'o5' });

    expect(onPublishError).toHaveBeenCalledOnce();
    expect(onPublishError).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'order.created' }),
      expect.objectContaining({ message: 'down' }),
    );
  });
});
