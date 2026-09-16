/**
 * `requestDrain()` — a unit of work asks for delivery NOW, not at the next tick.
 *
 * Under `dispatch: 'relay'` the outbox row is the delivery, and the relay's
 * interval (5 s by default) would be the customer-visible latency. The nudge
 * closes that to milliseconds; coalescing keeps a burst of placements from
 * becoming a burst of passes.
 */
import { describe, expect, it, vi } from "vitest";
import { type RequestStore, requestContext } from "../../src/context/requestContext.js";
import {
  ARC_EVENT_TRANSPORT,
  createEvent,
  type EventTransport,
  MemoryEventTransport,
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

/**
 * The scope boundary. `requestDrain` is documented as "call it after commit",
 * i.e. from inside a request — and `setImmediate` PRESERVES the caller's
 * AsyncLocalStorage store, so deferring does not escape it. A pass drains
 * whatever is pending, which is other requests' rows for other tenants, so
 * inheriting the nudging request's scope would hand every one of them that
 * request's `organizationId`, `user` and `requestScopedCache`, and stamp
 * anything they publish with its `requestId` as `correlationId`.
 *
 * These run the REAL path — relay → `MemoryEventTransport.publish` →
 * `runWorkScope` → handler — because the bug lives in the interaction, not in
 * any one of them.
 */
describe("createOutboxModule — requestDrain scope isolation", () => {
  const silent = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  const callerStore = (): RequestStore => ({
    kind: "request",
    requestId: "req-CALLER",
    startTime: 0,
    organizationId: "org-CALLER",
    user: { id: "user-CALLER" },
  });

  async function bootWithSubscriber(pattern = "order:*") {
    const transport = new MemoryEventTransport({ logger: silent });
    const seen: Array<RequestStore | undefined> = [];
    await transport.subscribe(pattern, async () => {
      seen.push(requestContext.get());
    });
    const store = new MemoryOutboxStore();
    const mod = createOutboxModule({ store, transport });
    const exp = mod.bootstrap!({
      log: { error: vi.fn() },
      [ARC_EVENT_TRANSPORT]: transport,
    } as never) as OutboxModuleExports;
    return { store, exp, seen };
  }

  it("a pass nudged from inside a request does NOT inherit that request's scope", async () => {
    const { store, exp, seen } = await bootWithSubscriber();
    // Written by some OTHER request — the row this caller must not colour.
    await store.save(createEvent("order:created", { n: 1 }));

    const caller = callerStore();
    requestContext.run(caller, () => {
      exp.requestDrain();
    });
    await tick();

    expect(seen).toHaveLength(1);
    const scope = seen[0];
    expect(scope).toBeDefined();
    // Its OWN scope, not the caller's object.
    expect(scope).not.toBe(caller);
    expect(scope?.kind).toBe("event");
    // The three fields a leak would carry across.
    expect(scope?.requestId).not.toBe("req-CALLER");
    expect(scope?.organizationId).toBeUndefined();
    expect(scope?.user).toBeUndefined();
  });

  it("each row in one nudged pass gets its own scope — no sharing across rows", async () => {
    const { store, exp, seen } = await bootWithSubscriber();
    await store.save(createEvent("order:created", { n: 1 }));
    await store.save(createEvent("order:created", { n: 2 }));

    requestContext.run(callerStore(), () => {
      exp.requestDrain();
    });
    await tick();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("the caller's own scope is intact after nudging", async () => {
    const { exp } = await bootWithSubscriber();
    const caller = callerStore();

    const [during, after] = requestContext.run(caller, () => {
      exp.requestDrain();
      return [requestContext.get(), requestContext.get()];
    });

    // `exit` must not leak OUTWARD: the request that nudged keeps its context
    // for the rest of its own handler.
    expect(during).toBe(caller);
    expect(after).toBe(caller);
  });

  it("INHERIT still holds for a publish the caller actually owns", async () => {
    // The fix must not turn into "always open a fresh scope". A direct,
    // awaited publish inside a request is that request's own work and must
    // keep sharing its store — that is what `runWorkScope`'s inherit rule buys.
    const transport = new MemoryEventTransport({ logger: silent });
    let seen: RequestStore | undefined;
    await transport.subscribe("order:*", async () => {
      seen = requestContext.get();
    });

    const caller = callerStore();
    await requestContext.run(caller, () => transport.publish(createEvent("order:created", {})));

    expect(seen).toBe(caller);
  });
});
