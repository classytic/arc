/**
 * MemoryEventTransport — Map cleanup tests
 *
 * Verifies that unsubscribing the last handler for a pattern
 * cleans up the Map entry to prevent memory leaks.
 */

import { describe, expect, it } from "vitest";
import { createEvent, MemoryEventTransport } from "../../src/events/EventTransport.js";

describe("MemoryEventTransport — cleanup on unsubscribe", () => {
  it("should remove map entry when last handler for a pattern is unsubscribed", async () => {
    const transport = new MemoryEventTransport();

    const handler1 = async () => {};
    const handler2 = async () => {};

    const unsub1 = await transport.subscribe("order.created", handler1);
    const unsub2 = await transport.subscribe("order.created", handler2);

    // @ts-expect-error — accessing private for test
    const router = transport.router;
    expect(router.size).toBe(1);
    expect(router.route("order.created")).toHaveLength(2);

    unsub1();
    expect(router.route("order.created")).toHaveLength(1);

    // Remove last handler — the pattern itself is dropped
    unsub2();
    expect(router.size).toBe(0);
  });

  it("should not leak entries across many subscribe/unsubscribe cycles", async () => {
    const transport = new MemoryEventTransport();

    // Simulate dynamic subscriptions (e.g., per-request)
    for (let i = 0; i < 100; i++) {
      const unsub = await transport.subscribe(`dynamic.${i}`, async () => {});
      unsub();
    }

    // @ts-expect-error — accessing private for test
    expect(transport.router.size).toBe(0);
  });

  it("should still deliver events to remaining handlers after partial unsubscribe", async () => {
    const transport = new MemoryEventTransport();
    const results: string[] = [];

    const unsub1 = await transport.subscribe("test.event", async (event) => {
      results.push(`handler1:${event.type}`);
    });
    const _unsub2 = await transport.subscribe("test.event", async (event) => {
      results.push(`handler2:${event.type}`);
    });

    // Remove handler1
    unsub1();

    // Publish — only handler2 should fire
    await transport.publish(createEvent("test.event", { data: 1 }));

    expect(results).toEqual(["handler2:test.event"]);
  });
});
