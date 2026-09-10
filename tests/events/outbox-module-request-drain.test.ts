/**
 * `requestDrain()` — a unit of work asks for delivery NOW, not at the next tick.
 *
 * Under `dispatch: 'relay'` the outbox row is the delivery, and the relay's
 * interval (5 s by default) would be the customer-visible latency. The nudge
 * closes that to milliseconds; coalescing keeps a burst of placements from
 * becoming a burst of passes.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ARC_EVENT_TRANSPORT,
  createEvent,
  type EventTransport,
} from "../../src/events/EventTransport.js";
import { MemoryOutboxStore } from "../../src/events/outbox.js";
import { createOutboxModule, type OutboxModuleExports } from "../../src/events/outbox-module.js";

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

function boot(transport: EventTransport) {
  const store = new MemoryOutboxStore();
  const mod = createOutboxModule({ store, transport });
  const exp = mod.bootstrap!({
    log: { error: vi.fn() },
    [ARC_EVENT_TRANSPORT]: transport,
  } as never) as OutboxModuleExports;
  return { store, exp };
}

describe("createOutboxModule — requestDrain", () => {
  it("is exported beside store and relay", () => {
    const { exp } = boot({
      name: "t",
      publish: vi.fn(async () => {}),
    } as unknown as EventTransport);
    expect(exp.requestDrain).toBeTypeOf("function");
  });

  it("delivers a pending row without waiting for the schedule", async () => {
    const publish = vi.fn(async () => {});
    const { store, exp } = boot({ name: "t", publish } as unknown as EventTransport);
    await store.save(createEvent("order:created", { n: 1 }));

    exp.requestDrain();
    expect(publish).not.toHaveBeenCalled(); // not synchronous — the caller's response is not delayed
    await tick();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(await store.getPending(10)).toEqual([]);
  });

  it("COALESCES a burst — many requests, one pass", async () => {
    const relayBatch = vi.fn(async () => ({}));
    const { exp } = boot({
      name: "t",
      publish: vi.fn(async () => {}),
    } as unknown as EventTransport);
    (exp.relay as unknown as { relayBatch: typeof relayBatch }).relayBatch = relayBatch;

    for (let i = 0; i < 25; i++) exp.requestDrain();
    await tick();

    expect(relayBatch).toHaveBeenCalledTimes(1);
  });

  it("a request during a pass schedules the NEXT pass — nothing waits for the interval", async () => {
    let resolveFirst: () => void = () => {};
    const relayBatch = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveFirst = r)))
      .mockImplementation(async () => ({}));
    const { exp } = boot({
      name: "t",
      publish: vi.fn(async () => {}),
    } as unknown as EventTransport);
    (exp.relay as unknown as { relayBatch: typeof relayBatch }).relayBatch = relayBatch;

    exp.requestDrain();
    await tick(); // first pass started, still running
    exp.requestDrain(); // lands mid-pass
    await tick();
    resolveFirst();
    await tick();

    expect(relayBatch).toHaveBeenCalledTimes(2);
  });

  it("a failing pass is logged, never thrown into the caller", async () => {
    const error = vi.fn();
    const store = new MemoryOutboxStore();
    const transport = { name: "t", publish: vi.fn(async () => {}) } as unknown as EventTransport;
    const mod = createOutboxModule({ store, transport });
    const exp = mod.bootstrap!({
      log: { error },
      [ARC_EVENT_TRANSPORT]: transport,
    } as never) as OutboxModuleExports;
    (exp.relay as unknown as { relayBatch: () => Promise<unknown> }).relayBatch = async () => {
      throw new Error("store down");
    };

    expect(() => exp.requestDrain()).not.toThrow();
    await tick();

    expect(error).toHaveBeenCalledTimes(1);
  });
});
