/**
 * An event delivered to NOBODY must be reportable.
 *
 * With an outbox wired, `publish()` resolving is what acknowledges the row — so
 * a publish that matched zero subscribers is indistinguishable, in every number
 * the relay reports, from one that ran successfully. The instruction the event
 * carried is simply never carried out. `onUnroutedEvent` is the seam that makes
 * it observable; it is opt-in because a fire-and-forget bus legitimately carries
 * events nobody wants.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import type { DomainEvent } from "../../src/events/eventTypes.js";

const silent = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

function evt(type = "accounting:cod.settled"): DomainEvent {
  return {
    type,
    payload: { settlementId: "s1" },
    meta: { id: "e1", timestamp: new Date() },
  } as unknown as DomainEvent;
}

describe("MemoryEventTransport — onUnroutedEvent", () => {
  it("fires with the event when nothing matched", async () => {
    const onUnroutedEvent = vi.fn();
    const transport = new MemoryEventTransport({ logger: silent, onUnroutedEvent });

    await transport.publish(evt());

    expect(onUnroutedEvent).toHaveBeenCalledTimes(1);
    expect(onUnroutedEvent.mock.calls[0]?.[0]).toMatchObject({ type: "accounting:cod.settled" });
  });

  it("does NOT fire when a subscriber matched — including via a pattern", async () => {
    const onUnroutedEvent = vi.fn();
    const transport = new MemoryEventTransport({ logger: silent, onUnroutedEvent });
    transport.subscribe("accounting:*", async () => {});

    await transport.publish(evt());

    expect(onUnroutedEvent).not.toHaveBeenCalled();
  });

  it("a subscriber that THREW still counts as routed", async () => {
    // Delivered-and-failed is a different problem with a different fix
    // (`onHandlerError: 'throw'` + the relay's retry). Conflating them would
    // send an operator hunting for a missing subscriber that exists.
    const onUnroutedEvent = vi.fn();
    const transport = new MemoryEventTransport({ logger: silent, onUnroutedEvent });
    transport.subscribe("accounting:cod.settled", async () => {
      throw new Error("handler blew up");
    });

    await transport.publish(evt());

    expect(onUnroutedEvent).not.toHaveBeenCalled();
  });

  it("is silent by default — an unrouted event is not an error on a fire-and-forget bus", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const transport = new MemoryEventTransport({ logger });

    await expect(transport.publish(evt())).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a THROWING reporter neither rejects the publish nor blocks delivery", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const transport = new MemoryEventTransport({
      logger,
      onUnroutedEvent: () => {
        throw new Error("reporter blew up");
      },
    });

    await expect(transport.publish(evt())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
