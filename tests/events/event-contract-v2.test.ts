/**
 * Event Contract — v2 additions
 *
 * Pins the newer optional fields on EventMeta (`schemaVersion`, `causationId`,
 * `partitionKey`) and the `createChildEvent` causation helper. Downstream
 * packages (e.g. @classytic/primitives) mirror this shape — keep it stable.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createChildEvent,
  createEvent,
  type DeadLetteredEvent,
  type DomainEvent,
  MemoryEventTransport,
} from "../../src/events/EventTransport.js";

describe("EventMeta v2 fields", () => {
  it("createEvent accepts schemaVersion, causationId, partitionKey", () => {
    const evt = createEvent(
      "order.placed",
      { orderId: "o1" },
      {
        schemaVersion: 2,
        causationId: "parent-id",
        partitionKey: "o1",
        correlationId: "trace-1",
      },
    );

    expect(evt.meta.schemaVersion).toBe(2);
    expect(evt.meta.causationId).toBe("parent-id");
    expect(evt.meta.partitionKey).toBe("o1");
    expect(evt.meta.correlationId).toBe("trace-1");
  });

  it("createEvent leaves new fields undefined when not supplied (back-compat)", () => {
    const evt = createEvent("order.placed", { orderId: "o1" });
    expect(evt.meta.schemaVersion).toBeUndefined();
    expect(evt.meta.causationId).toBeUndefined();
    expect(evt.meta.partitionKey).toBeUndefined();
  });
});

describe("createChildEvent — causation chain", () => {
  it("child.causationId points to parent.id", () => {
    const parent = createEvent("order.placed", { orderId: "o1" });
    const child = createChildEvent(parent, "inventory.reserved", { sku: "a" });

    expect(child.meta.causationId).toBe(parent.meta.id);
  });

  it("child inherits correlationId from parent when set", () => {
    const parent = createEvent("order.placed", { orderId: "o1" }, { correlationId: "trace-99" });
    const child = createChildEvent(parent, "inventory.reserved", { sku: "a" });

    expect(child.meta.correlationId).toBe("trace-99");
  });

  it("child uses parent.id as correlationId when parent has none (root correlation)", () => {
    const parent = createEvent("order.placed", { orderId: "o1" });
    const child = createChildEvent(parent, "inventory.reserved", { sku: "a" });

    expect(child.meta.correlationId).toBe(parent.meta.id);
  });

  it("child inherits userId and organizationId from parent", () => {
    const parent = createEvent(
      "order.placed",
      { orderId: "o1" },
      { userId: "u1", organizationId: "org-1" },
    );
    const child = createChildEvent(parent, "inventory.reserved", { sku: "a" });

    expect(child.meta.userId).toBe("u1");
    expect(child.meta.organizationId).toBe("org-1");
  });

  it("caller override wins over inherited fields", () => {
    const parent = createEvent(
      "order.placed",
      { orderId: "o1" },
      { userId: "u1", correlationId: "trace-a" },
    );
    const child = createChildEvent(
      parent,
      "inventory.reserved",
      { sku: "a" },
      { userId: "system", correlationId: "trace-b" },
    );

    expect(child.meta.userId).toBe("system");
    expect(child.meta.correlationId).toBe("trace-b");
    // causationId is still derived from parent, not overridable by accident
    expect(child.meta.causationId).toBe(parent.meta.id);
  });

  it("child gets a fresh id and timestamp (not copied from parent)", () => {
    const parent = createEvent("order.placed", { orderId: "o1" });
    const child = createChildEvent(parent, "inventory.reserved", { sku: "a" });

    expect(child.meta.id).not.toBe(parent.meta.id);
    expect(child.meta.timestamp).toBeInstanceOf(Date);
  });

  it("three-level chain preserves correlation across all hops", () => {
    const root = createEvent("order.placed", { orderId: "o1" });
    const mid = createChildEvent(root, "inventory.reserved", { sku: "a" });
    const leaf = createChildEvent(mid, "email.queued", { to: "x@y" });

    // Same correlation across the chain
    expect(mid.meta.correlationId).toBe(root.meta.id);
    expect(leaf.meta.correlationId).toBe(root.meta.id);

    // Causation links direct parent, not root
    expect(mid.meta.causationId).toBe(root.meta.id);
    expect(leaf.meta.causationId).toBe(mid.meta.id);
  });
});

describe("DeadLetteredEvent shape", () => {
  it("DeadLetteredEvent type is assignable and carries the original event", () => {
    const event = createEvent("order.placed", { orderId: "o1" });
    const dlq: DeadLetteredEvent<{ orderId: string }> = {
      event: event as DomainEvent<{ orderId: string }>,
      error: { message: "timeout", code: "ETIMEDOUT" },
      attempts: 3,
      firstFailedAt: new Date(Date.now() - 10_000),
      lastFailedAt: new Date(),
      handlerName: "stripeRefund",
    };

    expect(dlq.event.meta.id).toBe(event.meta.id);
    expect(dlq.attempts).toBe(3);
    expect(dlq.error.code).toBe("ETIMEDOUT");
  });
});

describe("Transport.deadLetter() is optional", () => {
  it("MemoryEventTransport does not implement deadLetter — absence is legal", () => {
    const transport = new MemoryEventTransport();
    expect(transport.deadLetter).toBeUndefined();
  });

  it("a transport that implements deadLetter() satisfies the contract", async () => {
    const sink = vi.fn(async () => {});
    const transport = new MemoryEventTransport() as unknown as {
      deadLetter: (dlq: DeadLetteredEvent) => Promise<void>;
    };
    transport.deadLetter = sink;

    const event = createEvent("x", {});
    await transport.deadLetter({
      event,
      error: { message: "failed" },
      attempts: 5,
      firstFailedAt: new Date(),
      lastFailedAt: new Date(),
    });

    expect(sink).toHaveBeenCalledTimes(1);
  });
});
