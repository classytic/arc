/**
 * Event Outbox Tests
 *
 * Verifies transactional outbox pattern: events are stored atomically
 * with the business operation, then relayed to the transport.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("EventOutbox", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Core Interface
  // ==========================================================================

  it("should store events in outbox", async () => {
    const { EventOutbox, MemoryOutboxStore } = await import("../../src/events/outbox.js");
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store });

    await outbox.store({
      type: "order.created",
      payload: { orderId: "123", total: 99 },
      meta: { id: "evt-1", timestamp: new Date() },
    });

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("order.created");
  });

  it("should relay pending events to transport", async () => {
    const { EventOutbox, MemoryOutboxStore } = await import("../../src/events/outbox.js");
    const { MemoryEventTransport } = await import("../../src/events/EventTransport.js");

    const store = new MemoryOutboxStore();
    const transport = new MemoryEventTransport();
    const publishSpy = vi.spyOn(transport, "publish");

    const outbox = new EventOutbox({ store, transport });

    await outbox.store({
      type: "order.created",
      payload: { orderId: "123" },
      meta: { id: "evt-1", timestamp: new Date() },
    });

    const relayed = await outbox.relay();
    expect(relayed).toBe(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    // After relay, pending should be empty
    const pending = await store.getPending(10);
    expect(pending).toHaveLength(0);
  });

  it("should mark events as relayed after successful publish", async () => {
    const { EventOutbox, MemoryOutboxStore } = await import("../../src/events/outbox.js");
    const { MemoryEventTransport } = await import("../../src/events/EventTransport.js");

    const store = new MemoryOutboxStore();
    const transport = new MemoryEventTransport();
    const outbox = new EventOutbox({ store, transport });

    await outbox.store({
      type: "order.created",
      payload: { orderId: "1" },
      meta: { id: "evt-1", timestamp: new Date() },
    });
    await outbox.store({
      type: "order.shipped",
      payload: { orderId: "2" },
      meta: { id: "evt-2", timestamp: new Date() },
    });

    await outbox.relay();

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(0);
  });

  it("should NOT mark event as relayed if transport publish fails", async () => {
    const { EventOutbox, MemoryOutboxStore } = await import("../../src/events/outbox.js");

    const store = new MemoryOutboxStore();
    const failingTransport = {
      name: "failing",
      publish: vi.fn().mockRejectedValue(new Error("Transport down")),
      subscribe: vi.fn(),
      close: vi.fn(),
    };

    const outbox = new EventOutbox({ store, transport: failingTransport });

    await outbox.store({
      type: "order.created",
      payload: { orderId: "1" },
      meta: { id: "evt-1", timestamp: new Date() },
    });

    const relayed = await outbox.relay();
    expect(relayed).toBe(0);

    // Event should still be pending
    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
  });

  it("should respect batch size during relay", async () => {
    const { EventOutbox, MemoryOutboxStore } = await import("../../src/events/outbox.js");
    const { MemoryEventTransport } = await import("../../src/events/EventTransport.js");

    const store = new MemoryOutboxStore();
    const transport = new MemoryEventTransport();
    const outbox = new EventOutbox({ store, transport, batchSize: 2 });

    for (let i = 0; i < 5; i++) {
      await outbox.store({
        type: "order.created",
        payload: { orderId: String(i) },
        meta: { id: `evt-${i}`, timestamp: new Date() },
      });
    }

    const relayed = await outbox.relay();
    expect(relayed).toBe(2);

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(3);
  });

  // ==========================================================================
  // MemoryOutboxStore
  // ==========================================================================

  describe("MemoryOutboxStore", () => {
    it("should return events in FIFO order", async () => {
      const { MemoryOutboxStore } = await import("../../src/events/outbox.js");
      const store = new MemoryOutboxStore();

      await store.save({
        type: "a",
        payload: {},
        meta: { id: "evt-1", timestamp: new Date() },
      });
      await store.save({
        type: "b",
        payload: {},
        meta: { id: "evt-2", timestamp: new Date() },
      });

      const pending = await store.getPending(10);
      expect(pending[0].type).toBe("a");
      expect(pending[1].type).toBe("b");
    });

    it("should remove acknowledged events", async () => {
      const { MemoryOutboxStore } = await import("../../src/events/outbox.js");
      const store = new MemoryOutboxStore();

      await store.save({
        type: "a",
        payload: {},
        meta: { id: "evt-1", timestamp: new Date() },
      });

      await store.acknowledge("evt-1");
      const pending = await store.getPending(10);
      expect(pending).toHaveLength(0);
    });
  });
});
