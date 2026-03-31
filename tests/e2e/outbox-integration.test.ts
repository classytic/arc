/**
 * Event Outbox — Arc Integration E2E
 *
 * Proves outbox works with real Arc eventPlugin:
 * store events during business logic, relay to transport, verify delivery.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

describe('Event Outbox — Arc Integration', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  it('stores events during request, relays to Arc transport after', async () => {
    const { eventPlugin } = await import('../../src/events/eventPlugin.js');
    const { EventOutbox, MemoryOutboxStore } = await import('../../src/events/outbox.js');
    const { MemoryEventTransport } = await import('../../src/events/EventTransport.js');

    const transport = new MemoryEventTransport();
    const received: string[] = [];
    await transport.subscribe('*', async (event) => {
      received.push(event.type);
    });

    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store, transport });

    app = Fastify({ logger: false });
    await app.register(eventPlugin, { transport });

    app.post('/orders', async (request) => {
      const body = request.body as { item: string };

      // Business logic stores event in outbox (would be same DB transaction)
      await outbox.store({
        type: 'order.created',
        payload: { item: body.item },
        meta: { id: `evt-${Date.now()}`, timestamp: new Date() },
      });

      return { success: true };
    });

    await app.ready();

    // Create order
    await app.inject({ method: 'POST', url: '/orders', payload: { item: 'widget' } });

    // Events NOT yet delivered (outbox stores, doesn't publish)
    expect(received).toHaveLength(0);

    // Relay pending events
    const relayed = await outbox.relay();
    expect(relayed).toBe(1);

    // Now delivered
    expect(received).toEqual(['order.created']);

    // Nothing left pending
    const pending = await store.getPending(10);
    expect(pending).toHaveLength(0);
  });

  it('relay skips already-acknowledged events', async () => {
    const { EventOutbox, MemoryOutboxStore } = await import('../../src/events/outbox.js');
    const { MemoryEventTransport } = await import('../../src/events/EventTransport.js');

    const transport = new MemoryEventTransport();
    const publishSpy = vi.spyOn(transport, 'publish');
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store, transport });

    await outbox.store({ type: 'a', payload: {}, meta: { id: 'e1', timestamp: new Date() } });
    await outbox.store({ type: 'b', payload: {}, meta: { id: 'e2', timestamp: new Date() } });

    // First relay
    await outbox.relay();
    expect(publishSpy).toHaveBeenCalledTimes(2);

    // Second relay — nothing pending
    publishSpy.mockClear();
    const secondRelay = await outbox.relay();
    expect(secondRelay).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
