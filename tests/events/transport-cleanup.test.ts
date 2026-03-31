/**
 * MemoryEventTransport — Map cleanup tests
 *
 * Verifies that unsubscribing the last handler for a pattern
 * cleans up the Map entry to prevent memory leaks.
 */

import { describe, it, expect } from 'vitest';
import { MemoryEventTransport, createEvent } from '../../src/events/EventTransport.js';

describe('MemoryEventTransport — cleanup on unsubscribe', () => {
  it('should remove map entry when last handler for a pattern is unsubscribed', async () => {
    const transport = new MemoryEventTransport();

    const handler1 = async () => {};
    const handler2 = async () => {};

    const unsub1 = await transport.subscribe('order.created', handler1);
    const unsub2 = await transport.subscribe('order.created', handler2);

    // Two handlers registered — internal map should have the pattern
    // @ts-expect-error — accessing private for test
    expect(transport.handlers.has('order.created')).toBe(true);
    // @ts-expect-error
    expect(transport.handlers.get('order.created')!.size).toBe(2);

    // Remove first handler
    unsub1();
    // @ts-expect-error
    expect(transport.handlers.get('order.created')!.size).toBe(1);

    // Remove last handler — map entry should be cleaned up
    unsub2();
    // @ts-expect-error
    expect(transport.handlers.has('order.created')).toBe(false);
  });

  it('should not leak entries across many subscribe/unsubscribe cycles', async () => {
    const transport = new MemoryEventTransport();

    // Simulate dynamic subscriptions (e.g., per-request)
    for (let i = 0; i < 100; i++) {
      const unsub = await transport.subscribe(`dynamic.${i}`, async () => {});
      unsub();
    }

    // @ts-expect-error
    expect(transport.handlers.size).toBe(0);
  });

  it('should still deliver events to remaining handlers after partial unsubscribe', async () => {
    const transport = new MemoryEventTransport();
    const results: string[] = [];

    const unsub1 = await transport.subscribe('test.event', async (event) => {
      results.push('handler1:' + event.type);
    });
    const _unsub2 = await transport.subscribe('test.event', async (event) => {
      results.push('handler2:' + event.type);
    });

    // Remove handler1
    unsub1();

    // Publish — only handler2 should fire
    await transport.publish(createEvent('test.event', { data: 1 }));

    expect(results).toEqual(['handler2:test.event']);
  });
});
