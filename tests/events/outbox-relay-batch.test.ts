/**
 * Outbox 2.8.1 follow-up tests — relayBatch + publishMany + retry helper
 *
 * Covers the community follow-up items:
 * 1. `relayBatch()` returns a rich RelayResult with per-kind counts
 * 2. `publishMany` is used when the transport implements it
 * 3. `publishMany` can be disabled via `usePublishMany: false`
 * 4. `publishMany` handles partial success (some events fail, some succeed)
 * 5. `publishMany` handles whole-batch failure (throws)
 * 6. `relay()` backward-compat wrapper still returns a number
 * 7. `exponentialBackoff()` helper produces correct retry delays with jitter
 * 8. End-to-end: real-world payment gateway using exponentialBackoff in store.fail
 * 9. Legacy stores (no fail/claim) still work and report counts correctly
 * 10. Malformed event aborts batch and increments `malformed` counter
 */

import { describe, expect, it, vi } from "vitest";
import type {
  DomainEvent,
  EventTransport,
  PublishManyResult,
} from "../../src/events/EventTransport.js";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import {
  EventOutbox,
  exponentialBackoff,
  MemoryOutboxStore,
  type OutboxStore,
  type RelayResult,
} from "../../src/events/outbox.js";

function makeEvent(id: string, type = "test.event"): DomainEvent {
  return { type, payload: { id }, meta: { id, timestamp: new Date() } };
}

// ============================================================================
// 1. relayBatch — RelayResult shape and counts
// ============================================================================

describe("relayBatch — rich result", () => {
  it("returns zeroed RelayResult when no transport configured", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));
    const outbox = new EventOutbox({ store });

    const result = await outbox.relayBatch();
    expect(result).toEqual({
      relayed: 0,
      attempted: 0,
      publishFailed: 0,
      ackFailed: 0,
      ownershipMismatches: 0,
      malformed: 0,
      failHookErrors: 0,
      deadLettered: 0,
      usedPublishMany: false,
    });
  });

  it("counts relayed events on happy path", async () => {
    const store = new MemoryOutboxStore();
    const transport = new MemoryEventTransport();
    const outbox = new EventOutbox({ store, transport });

    await outbox.store(makeEvent("e1"));
    await outbox.store(makeEvent("e2"));
    await outbox.store(makeEvent("e3"));

    const result = await outbox.relayBatch();
    expect(result.relayed).toBe(3);
    expect(result.attempted).toBe(3);
    expect(result.publishFailed).toBe(0);
    expect(result.ackFailed).toBe(0);
    expect(result.ownershipMismatches).toBe(0);
    expect(result.malformed).toBe(0);
    // MemoryEventTransport implements publishMany
    expect(result.usedPublishMany).toBe(true);
  });

  it("counts publishFailed when transport rejects individual events", async () => {
    const store = new MemoryOutboxStore();
    const errors: string[] = [];

    // Transport with publishMany that fails events 2 and 4
    const transport: EventTransport = {
      name: "partial",
      async publish(ev) {
        if (ev.meta.id === "e2" || ev.meta.id === "e4") {
          throw new Error(`${ev.meta.id} failed`);
        }
      },
      async publishMany(events) {
        const result = new Map<string, Error | null>();
        for (const ev of events) {
          if (ev.meta.id === "e2" || ev.meta.id === "e4") {
            result.set(ev.meta.id, new Error(`${ev.meta.id} failed`));
          } else {
            result.set(ev.meta.id, null);
          }
        }
        return result;
      },
      async subscribe() {
        return () => {};
      },
    };

    const outbox = new EventOutbox({
      store,
      transport,
      onError: (info) => errors.push(info.kind),
    });

    for (let i = 1; i <= 5; i++) await outbox.store(makeEvent(`e${i}`));
    const result = await outbox.relayBatch();

    expect(result.attempted).toBe(5);
    expect(result.relayed).toBe(3); // e1, e3, e5
    expect(result.publishFailed).toBe(2); // e2, e4
    expect(result.usedPublishMany).toBe(true);
    expect(errors.filter((k) => k === "publish_failed")).toHaveLength(2);
  });

  it("counts ackFailed when acknowledge throws after successful publish", async () => {
    const store = new MemoryOutboxStore();
    const transport = new MemoryEventTransport();

    await store.save(makeEvent("e1"));

    // Hijack lease between publish and ack: mutate entry.leaseOwner mid-flight
    vi.spyOn(transport, "publish").mockImplementation(async () => {
      const entry = store._getEntry("e1");
      if (entry) (entry as unknown as { leaseOwner: string }).leaseOwner = "other-worker";
    });
    // Also hijack publishMany to cause the same effect
    vi.spyOn(transport, "publishMany").mockImplementation(async (events) => {
      const entry = store._getEntry("e1");
      if (entry) (entry as unknown as { leaseOwner: string }).leaseOwner = "other-worker";
      const out = new Map<string, Error | null>();
      for (const e of events) out.set(e.meta.id, null);
      return out;
    });

    const outbox = new EventOutbox({ store, transport, consumerId: "worker-A" });
    const result = await outbox.relayBatch();

    expect(result.relayed).toBe(0);
    expect(result.ackFailed).toBe(1);
    expect(result.ownershipMismatches).toBe(1); // ackErr was OutboxOwnershipError
  });
});

// ============================================================================
// 2. relay() backward compatibility
// ============================================================================

describe("relay — backward compatibility", () => {
  it("relay() still returns just the relayed count", async () => {
    const store = new MemoryOutboxStore();
    const transport = new MemoryEventTransport();
    const outbox = new EventOutbox({ store, transport });

    await outbox.store(makeEvent("e1"));
    await outbox.store(makeEvent("e2"));

    const count = await outbox.relay();
    expect(typeof count).toBe("number");
    expect(count).toBe(2);
  });

  it("relay() returns 0 when no transport configured", async () => {
    const outbox = new EventOutbox({ store: new MemoryOutboxStore() });
    const n = await outbox.relay();
    expect(n).toBe(0);
  });
});

// ============================================================================
// 3. publishMany — opt-in and fallback
// ============================================================================

describe("publishMany — auto-detection + opt-out", () => {
  it("uses publishMany when transport implements it", async () => {
    const store = new MemoryOutboxStore();
    const publishSpy = vi.fn(async (_ev: DomainEvent) => {});
    const publishManySpy = vi.fn(
      async (events: readonly DomainEvent[]): Promise<PublishManyResult> => {
        const result = new Map<string, Error | null>();
        for (const e of events) result.set(e.meta.id, null);
        return result;
      },
    );

    const transport: EventTransport = {
      name: "batched",
      publish: publishSpy,
      publishMany: publishManySpy,
      subscribe: async () => () => {},
    };

    const outbox = new EventOutbox({ store, transport });
    await outbox.store(makeEvent("e1"));
    await outbox.store(makeEvent("e2"));
    await outbox.store(makeEvent("e3"));

    const result = await outbox.relayBatch();
    expect(result.usedPublishMany).toBe(true);
    expect(publishManySpy).toHaveBeenCalledTimes(1);
    expect(publishManySpy.mock.calls[0]?.[0]).toHaveLength(3);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("falls back to per-event publish when transport has no publishMany", async () => {
    const store = new MemoryOutboxStore();
    const publishSpy = vi.fn(async (_ev: DomainEvent) => {});

    const transport: EventTransport = {
      name: "simple",
      publish: publishSpy,
      subscribe: async () => () => {},
    };

    const outbox = new EventOutbox({ store, transport });
    await outbox.store(makeEvent("e1"));
    await outbox.store(makeEvent("e2"));

    const result = await outbox.relayBatch();
    expect(result.usedPublishMany).toBe(false);
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it("usePublishMany: false forces per-event path even when transport supports it", async () => {
    const store = new MemoryOutboxStore();
    const publishSpy = vi.fn(async (_ev: DomainEvent) => {});
    const publishManySpy = vi.fn(
      async (_events: readonly DomainEvent[]): Promise<PublishManyResult> => {
        return new Map();
      },
    );

    const transport: EventTransport = {
      name: "batched",
      publish: publishSpy,
      publishMany: publishManySpy,
      subscribe: async () => () => {},
    };

    const outbox = new EventOutbox({
      store,
      transport,
      usePublishMany: false,
    });
    await outbox.store(makeEvent("e1"));
    await outbox.store(makeEvent("e2"));

    const result = await outbox.relayBatch();
    expect(result.usedPublishMany).toBe(false);
    expect(publishManySpy).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it("handles publishMany throwing whole-batch error — synthesizes per-event failure", async () => {
    const store = new MemoryOutboxStore();

    const transport: EventTransport = {
      name: "dead",
      async publish() {
        throw new Error("should not be called");
      },
      async publishMany() {
        throw new Error("network partition");
      },
      async subscribe() {
        return () => {};
      },
    };

    const onErrors: Array<{ kind: string; eventId?: string; message: string }> = [];
    const outbox = new EventOutbox({
      store,
      transport,
      onError: (info) =>
        onErrors.push({
          kind: info.kind,
          eventId: info.event?.meta.id,
          message: info.error.message,
        }),
    });

    for (let i = 1; i <= 3; i++) await outbox.store(makeEvent(`e${i}`));
    const result = await outbox.relayBatch();

    expect(result.relayed).toBe(0);
    expect(result.publishFailed).toBe(3);
    expect(result.usedPublishMany).toBe(true);

    // Each event should be reported as publish_failed with the batch error
    const publishErrors = onErrors.filter((e) => e.kind === "publish_failed");
    expect(publishErrors).toHaveLength(3);
    expect(publishErrors.every((e) => e.message === "network partition")).toBe(true);

    // All three events should have fail() called and remain retryable
    expect(store._getEntry("e1")?.status).toBe("pending");
    expect(store._getEntry("e2")?.status).toBe("pending");
    expect(store._getEntry("e3")?.status).toBe("pending");
  });
});

// ============================================================================
// 4. Legacy stores still work with relayBatch
// ============================================================================

describe("relayBatch — legacy store compat", () => {
  it("works with a legacy store (no claimPending, no fail)", async () => {
    const saved: DomainEvent[] = [];
    const acked: string[] = [];
    const legacyStore: OutboxStore = {
      async save(ev) {
        saved.push(ev);
      },
      async getPending(limit) {
        return saved.slice(0, limit);
      },
      async acknowledge(id) {
        acked.push(id);
        const idx = saved.findIndex((e) => e.meta.id === id);
        if (idx !== -1) saved.splice(idx, 1);
      },
    };

    const transport = new MemoryEventTransport();
    const outbox = new EventOutbox({ store: legacyStore, transport });

    await outbox.store(makeEvent("e1"));
    await outbox.store(makeEvent("e2"));

    const result = await outbox.relayBatch();
    expect(result.relayed).toBe(2);
    expect(result.attempted).toBe(2);
    expect(acked).toEqual(["e1", "e2"]);
  });

  it("legacy store stops batch on publish failure without fail hook", async () => {
    const saved: DomainEvent[] = [];
    const legacyStore: OutboxStore = {
      async save(ev) {
        saved.push(ev);
      },
      async getPending(limit) {
        return saved.slice(0, limit);
      },
      async acknowledge(id) {
        const idx = saved.findIndex((e) => e.meta.id === id);
        if (idx !== -1) saved.splice(idx, 1);
      },
    };

    const publish = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const outbox = new EventOutbox({
      store: legacyStore,
      transport: { name: "x", publish, subscribe: async () => () => {} },
    });

    await outbox.store(makeEvent("e1"));
    await outbox.store(makeEvent("e2"));
    await outbox.store(makeEvent("e3"));

    const result = await outbox.relayBatch();
    expect(result.relayed).toBe(1);
    expect(result.publishFailed).toBe(1);
    // e3 never attempted because we stopped the batch
    expect(publish).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// 5. Malformed event counter
// ============================================================================

describe("relayBatch — malformed tracking", () => {
  it("counts malformed events and aborts the batch", async () => {
    const corruptStore: OutboxStore = {
      async save() {},
      async getPending() {
        return [
          makeEvent("ok-1"),
          { type: "", payload: {}, meta: {} } as unknown as DomainEvent,
          makeEvent("ok-2"),
        ];
      },
      async acknowledge() {},
    };

    const transport = new MemoryEventTransport();
    const publishSpy = vi.spyOn(transport, "publish");

    const outbox = new EventOutbox({ store: corruptStore, transport });
    const result = await outbox.relayBatch();

    expect(result.malformed).toBe(1);
    expect(result.attempted).toBe(1); // Only ok-1 made it into `valid`
    expect(result.relayed).toBe(1); // ok-1 published successfully
    expect(publishSpy).toHaveBeenCalledTimes(1); // ok-2 never reached
  });
});

// ============================================================================
// 6. exponentialBackoff helper
// ============================================================================

describe("exponentialBackoff", () => {
  it("scales delay exponentially on each attempt", () => {
    const now = 1_000_000;
    // jitter=0 for deterministic math
    const d1 = exponentialBackoff({ attempt: 1, baseMs: 1000, jitter: 0, now });
    const d2 = exponentialBackoff({ attempt: 2, baseMs: 1000, jitter: 0, now });
    const d3 = exponentialBackoff({ attempt: 3, baseMs: 1000, jitter: 0, now });
    const d4 = exponentialBackoff({ attempt: 4, baseMs: 1000, jitter: 0, now });

    expect(d1.getTime() - now).toBe(1000);
    expect(d2.getTime() - now).toBe(2000);
    expect(d3.getTime() - now).toBe(4000);
    expect(d4.getTime() - now).toBe(8000);
  });

  it("caps at maxMs", () => {
    const now = 1_000_000;
    // attempt=20 would be 1000 * 2^19 ≈ 500M ms; must cap
    const d = exponentialBackoff({
      attempt: 20,
      baseMs: 1000,
      maxMs: 60_000,
      jitter: 0,
      now,
    });
    expect(d.getTime() - now).toBe(60_000);
  });

  it("jitter adds 0 to +jitterFactor of the base delay", () => {
    const now = 1_000_000;
    // With jitter=0.2, delay should be in [base, base * 1.2]
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const d = exponentialBackoff({ attempt: 1, baseMs: 1000, jitter: 0.2, now });
      samples.push(d.getTime() - now);
    }
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1200);
  });

  it("jitter=0 is deterministic", () => {
    const now = 1_000_000;
    const d1 = exponentialBackoff({ attempt: 5, baseMs: 500, jitter: 0, now });
    const d2 = exponentialBackoff({ attempt: 5, baseMs: 500, jitter: 0, now });
    expect(d1.getTime()).toBe(d2.getTime());
  });

  it("honors custom baseMs", () => {
    const now = 1_000_000;
    const d = exponentialBackoff({
      attempt: 3,
      baseMs: 250,
      jitter: 0,
      now,
    });
    // 250 * 2^2 = 1000
    expect(d.getTime() - now).toBe(1000);
  });

  it("clamps attempt to >= 1", () => {
    const now = 1_000_000;
    const d0 = exponentialBackoff({ attempt: 0, baseMs: 1000, jitter: 0, now });
    const dNeg = exponentialBackoff({ attempt: -5, baseMs: 1000, jitter: 0, now });
    // Both treated as attempt=1 → delay = 1000
    expect(d0.getTime() - now).toBe(1000);
    expect(dNeg.getTime() - now).toBe(1000);
  });

  it("clamps jitter to [0, 1]", () => {
    const now = 1_000_000;
    // jitter=2 is invalid but should clamp to 1 — delay in [base, base*2]
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const d = exponentialBackoff({ attempt: 1, baseMs: 1000, jitter: 2, now });
      samples.push(d.getTime() - now);
    }
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(2000);
  });
});

// ============================================================================
// 7. Real-world scenario: payment gateway with exponentialBackoff
// ============================================================================

describe("real-world: payment gateway with exponentialBackoff in store.fail", () => {
  it("handles transient failures with retry, escalates to dead-letter after budget", async () => {
    const store = new MemoryOutboxStore();
    const attemptsByEvent = new Map<string, number>();

    const transport: EventTransport = {
      name: "gateway",
      async publish(event) {
        const n = (attemptsByEvent.get(event.meta.id) ?? 0) + 1;
        attemptsByEvent.set(event.meta.id, n);
        if (event.meta.id === "pay-transient" && n < 3) {
          throw new Error("503 temporarily unavailable");
        }
        if (event.meta.id === "pay-permanent") {
          throw new Error("402 payment required");
        }
      },
      subscribe: async () => () => {},
    };

    // Wrap store.fail to use exponentialBackoff + MAX_ATTEMPTS budget
    const MAX_ATTEMPTS = 3;
    const originalFail = store.fail.bind(store);
    store.fail = async (eventId, error, options) => {
      const entry = store._getEntry(eventId);
      const attempts = entry?.attempts ?? 0;
      if (attempts >= MAX_ATTEMPTS) {
        await originalFail(eventId, error, { ...options, deadLetter: true });
        return;
      }
      // Short base for test speed (5ms base, capped at 50ms)
      const retryAt = exponentialBackoff({
        attempt: attempts,
        baseMs: 5,
        maxMs: 50,
        jitter: 0,
      });
      await originalFail(eventId, error, { ...options, retryAt });
    };

    const outbox = new EventOutbox({
      store,
      transport,
      consumerId: "payment-worker",
    });

    await outbox.store(makeEvent("pay-ok", "payment.charge"));
    await outbox.store(makeEvent("pay-transient", "payment.charge"));
    await outbox.store(makeEvent("pay-permanent", "payment.charge"));

    // Drain up to 20 iterations respecting visibleAt
    const start = Date.now();
    while (Date.now() - start < 2000) {
      const pending = await store.getPending(10);
      if (pending.length === 0) {
        // Check if all either delivered or dead
        const transient = store._getEntry("pay-transient");
        const permanent = store._getEntry("pay-permanent");
        if (transient?.status !== "pending" && permanent?.status !== "pending") {
          break;
        }
      }
      await outbox.relayBatch();
      // Tiny sleep to let visibleAt windows expire
      await new Promise((r) => setTimeout(r, 10));
    }

    // pay-ok: delivered on first try
    expect(store._getEntry("pay-ok")?.status).toBe("delivered");
    // pay-transient: recovered after 2 failures → delivered
    expect(store._getEntry("pay-transient")?.status).toBe("delivered");
    expect(attemptsByEvent.get("pay-transient")).toBeGreaterThanOrEqual(3);
    // pay-permanent: dead-lettered after budget
    expect(store._getEntry("pay-permanent")?.status).toBe("dead_letter");
  });
});

// ============================================================================
// 8. publishMany partial success — mixed outcomes in one batch
// ============================================================================

describe("publishMany — mixed outcomes", () => {
  it("separates successes from failures and applies ack/fail per event", async () => {
    const store = new MemoryOutboxStore();

    const transport: EventTransport = {
      name: "mixed",
      async publish() {
        /* never called — publishMany preferred */
      },
      async publishMany(events) {
        const out = new Map<string, Error | null>();
        for (const e of events) {
          if (e.meta.id.startsWith("fail-")) {
            out.set(e.meta.id, new Error(`${e.meta.id} rejected`));
          } else {
            out.set(e.meta.id, null);
          }
        }
        return out;
      },
      subscribe: async () => () => {},
    };

    const outbox = new EventOutbox({ store, transport, consumerId: "w1" });

    await outbox.store(makeEvent("ok-1"));
    await outbox.store(makeEvent("fail-2"));
    await outbox.store(makeEvent("ok-3"));
    await outbox.store(makeEvent("fail-4"));
    await outbox.store(makeEvent("ok-5"));

    const result = await outbox.relayBatch();

    expect(result.relayed).toBe(3);
    expect(result.publishFailed).toBe(2);
    expect(result.usedPublishMany).toBe(true);

    // ok-* should be delivered, fail-* should be pending with lastError set
    expect(store._getEntry("ok-1")?.status).toBe("delivered");
    expect(store._getEntry("ok-3")?.status).toBe("delivered");
    expect(store._getEntry("ok-5")?.status).toBe("delivered");
    expect(store._getEntry("fail-2")?.status).toBe("pending");
    expect(store._getEntry("fail-2")?.lastError?.message).toBe("fail-2 rejected");
    expect(store._getEntry("fail-4")?.status).toBe("pending");
  });
});

// ============================================================================
// 9. MemoryEventTransport reference publishMany
// ============================================================================

describe("MemoryEventTransport.publishMany", () => {
  it("delegates to publish for each event and returns per-event outcomes", async () => {
    const transport = new MemoryEventTransport();
    const received: string[] = [];
    await transport.subscribe("*", async (e) => {
      received.push(e.meta.id);
    });

    const result = await transport.publishMany([makeEvent("a"), makeEvent("b"), makeEvent("c")]);

    expect(result.size).toBe(3);
    expect(result.get("a")).toBeNull();
    expect(result.get("b")).toBeNull();
    expect(result.get("c")).toBeNull();
    expect(received).toEqual(["a", "b", "c"]);
  });
});

// ============================================================================
// 10. Terminology sanity — delivered is canonical in MemoryOutboxStore
// ============================================================================

describe("terminology: delivered is canonical", () => {
  it("MemoryOutboxStore stores deliveredAt on success, not acknowledgedAt", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("e1"));
    await store.acknowledge("e1");

    const entry = store._getEntry("e1");
    expect(entry?.status).toBe("delivered");
    expect(entry?.deliveredAt).toBeTypeOf("number");
    expect((entry as unknown as Record<string, unknown>)?.acknowledgedAt).toBeUndefined();
  });

  it("purge only removes events in 'delivered' state", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("delivered-1"));
    await store.save(makeEvent("pending-1"));
    await store.save(makeEvent("dead-1"));

    await store.claimPending({ consumerId: "w1", limit: 10, leaseMs: 60_000 });
    await store.acknowledge("delivered-1", { consumerId: "w1" });
    await store.fail("dead-1", { message: "permanent" }, { consumerId: "w1", deadLetter: true });
    // pending-1 stays pending (release lease explicitly)
    await store.fail("pending-1", { message: "transient" }, { consumerId: "w1" });

    const purged = await store.purge(-1); // purge all delivered
    expect(purged).toBe(1);

    expect(store._getEntry("delivered-1")).toBeUndefined();
    expect(store._getEntry("pending-1")?.status).toBe("pending");
    expect(store._getEntry("dead-1")?.status).toBe("dead_letter");
  });
});

// Type assertion — compile-time check that RelayResult is publicly exported
const _compileCheck: RelayResult = {
  relayed: 0,
  attempted: 0,
  publishFailed: 0,
  ackFailed: 0,
  ownershipMismatches: 0,
  malformed: 0,
  failHookErrors: 0,
  usedPublishMany: false,
};
void _compileCheck;
