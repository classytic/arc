/**
 * Event Transport Behavioral Contract Tests
 *
 * Documents and enforces the behavioral differences between transports.
 * These tests serve as both documentation and regression prevention.
 */

import { describe, expect, it, vi } from "vitest";
import { createEvent, MemoryEventTransport } from "../../src/events/EventTransport.js";

describe("MemoryEventTransport — behavioral contract", () => {
  it("should execute handlers sequentially (ordered, awaited)", async () => {
    const transport = new MemoryEventTransport();
    const order: number[] = [];

    await transport.subscribe("test", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });

    await transport.subscribe("test", async () => {
      order.push(2);
    });

    await transport.publish(createEvent("test", {}));

    // Memory transport awaits each handler — so handler1 finishes before handler2
    expect(order).toEqual([1, 2]);
  });

  it("should isolate handler errors (one failing handler does not block others)", async () => {
    const transport = new MemoryEventTransport({
      logger: { warn: () => {}, error: () => {} },
    });
    const results: string[] = [];

    await transport.subscribe("test", async () => {
      throw new Error("handler1 failed");
    });

    await transport.subscribe("test", async () => {
      results.push("handler2-ok");
    });

    await transport.publish(createEvent("test", {}));

    // Handler2 should still execute despite handler1 throwing
    expect(results).toEqual(["handler2-ok"]);
  });

  it("should support wildcard subscriptions", async () => {
    const transport = new MemoryEventTransport();
    const received: string[] = [];

    await transport.subscribe("*", async (event) => {
      received.push(event.type);
    });

    await transport.publish(createEvent("order.created", {}));
    await transport.publish(createEvent("product.updated", {}));

    expect(received).toEqual(["order.created", "product.updated"]);
  });

  it("should support prefix pattern subscriptions (resource.*)", async () => {
    const transport = new MemoryEventTransport();
    const received: string[] = [];

    await transport.subscribe("order.*", async (event) => {
      received.push(event.type);
    });

    await transport.publish(createEvent("order.created", {}));
    await transport.publish(createEvent("order.updated", {}));
    await transport.publish(createEvent("product.created", {})); // should NOT match

    expect(received).toEqual(["order.created", "order.updated"]);
  });

  it("should deduplicate same handler registered via both exact and wildcard", async () => {
    const transport = new MemoryEventTransport();
    const handler = vi.fn();

    // Subscribe same handler function via exact match AND wildcard
    await transport.subscribe("order.created", handler);
    await transport.subscribe("*", handler);

    await transport.publish(createEvent("order.created", {}));

    // MemoryEventTransport uses Set dedup — same function reference called once.
    // This prevents accidental double-processing when the same handler
    // is registered via multiple patterns.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should call different handlers independently even when patterns overlap", async () => {
    const transport = new MemoryEventTransport();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    // Different handler functions via overlapping patterns
    await transport.subscribe("order.created", handler1);
    await transport.subscribe("*", handler2);

    await transport.publish(createEvent("order.created", {}));

    // Different function references — both called
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("should include complete metadata in events", async () => {
    const transport = new MemoryEventTransport();
    let receivedEvent: any;

    await transport.subscribe("test", async (event) => {
      receivedEvent = event;
    });

    const event = createEvent(
      "test",
      { amount: 100 },
      {
        resource: "order",
        resourceId: "order-123",
        userId: "user-1",
        organizationId: "org-1",
        correlationId: "req-abc",
      },
    );

    await transport.publish(event);

    expect(receivedEvent.type).toBe("test");
    expect(receivedEvent.payload).toEqual({ amount: 100 });
    expect(receivedEvent.meta.resource).toBe("order");
    expect(receivedEvent.meta.resourceId).toBe("order-123");
    expect(receivedEvent.meta.userId).toBe("user-1");
    expect(receivedEvent.meta.organizationId).toBe("org-1");
    expect(receivedEvent.meta.correlationId).toBe("req-abc");
    expect(receivedEvent.meta.id).toBeDefined(); // auto-generated UUID
    expect(receivedEvent.meta.timestamp).toBeInstanceOf(Date);
  });
});
