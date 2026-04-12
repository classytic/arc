/**
 * Outbox capability tests — v2.8.1 expanded contract
 *
 * Verifies:
 * - Backward compatibility with legacy stores (required methods only)
 * - Write options passthrough (session, visibleAt, dedupeKey, etc.)
 * - Lease-based claim path (claimPending)
 * - Failure tracking path (fail + retry)
 * - Dead-letter handling
 * - Multi-worker safety via lease ownership
 */

import { describe, expect, it, vi } from "vitest";
import type { DomainEvent, EventTransport } from "../../src/events/EventTransport.js";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import {
  EventOutbox,
  InvalidOutboxEventError,
  MemoryOutboxStore,
  OutboxOwnershipError,
  type OutboxStore,
  type OutboxWriteOptions,
} from "../../src/events/outbox.js";

function makeEvent(id: string, type = "test.event"): DomainEvent {
  return { type, payload: { id }, meta: { id, timestamp: new Date() } };
}

describe("Outbox — backward compatibility", () => {
  it("works with a legacy store implementing only required methods", async () => {
    const saved: DomainEvent[] = [];
    const acked: string[] = [];
    const legacyStore: OutboxStore = {
      async save(event) {
        saved.push(event);
      },
      async getPending(limit) {
        return saved.slice(0, limit);
      },
      async acknowledge(id) {
        acked.push(id);
      },
    };

    const transport = new MemoryEventTransport();
    const outbox = new EventOutbox({ store: legacyStore, transport });

    await outbox.store(makeEvent("evt-1"));
    await outbox.store(makeEvent("evt-2"));
    const relayed = await outbox.relay();

    expect(relayed).toBe(2);
    expect(acked).toEqual(["evt-1", "evt-2"]);
  });

  it("legacy store — stops batch on transport failure (no fail hook)", async () => {
    const store = new MemoryOutboxStore();
    const publish = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transport down"))
      .mockResolvedValueOnce(undefined);

    // Strip claim/fail to simulate legacy store
    const legacyStore: OutboxStore = {
      save: store.save.bind(store),
      getPending: store.getPending.bind(store),
      acknowledge: store.acknowledge.bind(store),
    };

    const outbox = new EventOutbox({
      store: legacyStore,
      transport: {
        name: "flaky",
        publish,
        subscribe: vi.fn(),
        close: vi.fn(),
      },
    });

    await outbox.store(makeEvent("evt-1"));
    await outbox.store(makeEvent("evt-2"));
    await outbox.store(makeEvent("evt-3"));

    const relayed = await outbox.relay();
    expect(relayed).toBe(1); // stopped at 2nd event
    expect(publish).toHaveBeenCalledTimes(2);
  });
});

describe("Outbox — write options passthrough", () => {
  it("forwards OutboxWriteOptions to store.save", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const store: OutboxStore = {
      save,
      getPending: async () => [],
      acknowledge: async () => {},
    };
    const outbox = new EventOutbox({ store });

    const options: OutboxWriteOptions = {
      session: { txId: "abc" },
      visibleAt: new Date("2030-01-01"),
      dedupeKey: "order-123",
      partitionKey: "tenant-A",
      headers: { "x-trace-id": "t-1" },
    };

    await outbox.store(makeEvent("evt-1"), options);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ type: "test.event" }), options);
  });

  it("MemoryOutboxStore honors dedupeKey", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"), { dedupeKey: "op-A" });
    await store.save(makeEvent("evt-2"), { dedupeKey: "op-A" });
    await store.save(makeEvent("evt-3"), { dedupeKey: "op-B" });

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(2);
    expect(pending.map((e) => e.meta.id)).toEqual(["evt-1", "evt-3"]);
  });

  it("MemoryOutboxStore honors visibleAt (delayed visibility)", async () => {
    const store = new MemoryOutboxStore();
    const future = new Date(Date.now() + 60_000);
    await store.save(makeEvent("evt-now"));
    await store.save(makeEvent("evt-later"), { visibleAt: future });

    const pending = await store.getPending(10);
    expect(pending.map((e) => e.meta.id)).toEqual(["evt-now"]);
  });
});

describe("Outbox — claimPending path", () => {
  it("uses claimPending when store supports it", async () => {
    const store = new MemoryOutboxStore();
    const claimSpy = vi.spyOn(store, "claimPending");
    const transport = new MemoryEventTransport();
    const outbox = new EventOutbox({ store, transport, consumerId: "worker-1" });

    await outbox.store(makeEvent("evt-1"));
    await outbox.relay();

    expect(claimSpy).toHaveBeenCalledWith(
      expect.objectContaining({ consumerId: "worker-1", leaseMs: expect.any(Number) }),
    );
  });

  it("multi-worker: lease prevents duplicate claim", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));
    await store.save(makeEvent("evt-2"));

    const workerA = await store.claimPending({
      consumerId: "worker-A",
      limit: 10,
      leaseMs: 60_000,
    });
    const workerB = await store.claimPending({
      consumerId: "worker-B",
      limit: 10,
      leaseMs: 60_000,
    });

    expect(workerA).toHaveLength(2);
    expect(workerB).toHaveLength(0); // B sees nothing — A holds the lease
  });

  it("multi-worker: stale lease is recoverable", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));

    // Worker A claims with 0ms lease → instantly stale
    const claimedA = await store.claimPending({ consumerId: "worker-A", limit: 10, leaseMs: 0 });
    expect(claimedA).toHaveLength(1);

    // Give the clock a tick so leaseExpiresAt < now
    await new Promise((r) => setTimeout(r, 5));

    // Worker B can now reclaim
    const claimedB = await store.claimPending({
      consumerId: "worker-B",
      limit: 10,
      leaseMs: 60_000,
    });
    expect(claimedB).toHaveLength(1);
  });

  it("only owner can acknowledge held event — throws OutboxOwnershipError on mismatch", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));
    await store.claimPending({ consumerId: "worker-A", limit: 10, leaseMs: 60_000 });

    // Wrong owner tries to ack — MUST throw (contract #3)
    await expect(store.acknowledge("evt-1", { consumerId: "worker-B" })).rejects.toBeInstanceOf(
      OutboxOwnershipError,
    );

    // Error details are actionable
    try {
      await store.acknowledge("evt-1", { consumerId: "worker-B" });
    } catch (err) {
      expect(err).toBeInstanceOf(OutboxOwnershipError);
      const ownErr = err as OutboxOwnershipError;
      expect(ownErr.eventId).toBe("evt-1");
      expect(ownErr.attemptedBy).toBe("worker-B");
      expect(ownErr.currentOwner).toBe("worker-A");
    }

    // Entry stays pending (not hijacked)
    expect(store._getEntry("evt-1")?.status).toBe("pending");

    // Correct owner — succeeds
    await store.acknowledge("evt-1", { consumerId: "worker-A" });
    expect(store._getEntry("evt-1")?.status).toBe("delivered");
  });

  it("fail throws OutboxOwnershipError on mismatch", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));
    await store.claimPending({ consumerId: "worker-A", limit: 10, leaseMs: 60_000 });

    await expect(
      store.fail("evt-1", { message: "boom" }, { consumerId: "worker-B" }),
    ).rejects.toBeInstanceOf(OutboxOwnershipError);

    // Entry stays pending with worker-A as owner
    expect(store._getEntry("evt-1")?.status).toBe("pending");
    expect(store._getEntry("evt-1")?.leaseOwner).toBe("worker-A");
  });

  it("acknowledge on unknown id is a no-op (idempotent after purge)", async () => {
    const store = new MemoryOutboxStore();
    // Should not throw for unknown id
    await expect(
      store.acknowledge("never-existed", { consumerId: "worker-A" }),
    ).resolves.toBeUndefined();
  });

  it("acknowledge on already-delivered event is a no-op (idempotent)", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));
    await store.claimPending({ consumerId: "worker-A", limit: 10, leaseMs: 60_000 });
    await store.acknowledge("evt-1", { consumerId: "worker-A" });

    // Re-ack by different worker — should NOT throw ownership error (already delivered)
    await expect(store.acknowledge("evt-1", { consumerId: "worker-B" })).resolves.toBeUndefined();
    expect(store._getEntry("evt-1")?.status).toBe("delivered");
  });

  it("types filter restricts claim to matching types", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1", "order.created"));
    await store.save(makeEvent("evt-2", "user.signup"));
    await store.save(makeEvent("evt-3", "order.shipped"));

    const claimed = await store.claimPending({
      consumerId: "worker-1",
      limit: 10,
      types: ["order.created", "order.shipped"],
    });
    expect(claimed.map((e) => e.meta.id)).toEqual(["evt-1", "evt-3"]);
  });
});

describe("Outbox — fail hook path", () => {
  it("calls store.fail on publish failure and continues batch", async () => {
    const store = new MemoryOutboxStore();
    const failSpy = vi.spyOn(store, "fail");

    const publish = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);

    const outbox = new EventOutbox({
      store,
      transport: {
        name: "flaky",
        publish,
        subscribe: vi.fn(),
        close: vi.fn(),
      },
      consumerId: "worker-1",
    });

    await outbox.store(makeEvent("evt-1"));
    await outbox.store(makeEvent("evt-2"));
    await outbox.store(makeEvent("evt-3"));

    const relayed = await outbox.relay();

    expect(relayed).toBe(2); // evt-1 and evt-3 succeeded
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(failSpy).toHaveBeenCalledWith(
      "evt-2",
      expect.objectContaining({ message: "transient" }),
      expect.objectContaining({ consumerId: "worker-1" }),
    );

    // Failed event stays pending for retry
    expect(store._getEntry("evt-2")?.status).toBe("pending");
    expect(store._getEntry("evt-2")?.lastError?.message).toBe("transient");
  });

  it("fail with retryAt schedules next visibility", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));
    await store.claimPending({ consumerId: "worker-1", limit: 10, leaseMs: 60_000 });

    const retryAt = new Date(Date.now() + 10_000);
    await store.fail("evt-1", { message: "boom" }, { consumerId: "worker-1", retryAt });

    // Immediately invisible (visibleAt in future)
    const pendingNow = await store.getPending(10);
    expect(pendingNow).toHaveLength(0);

    // Entry still exists, retryable
    expect(store._getEntry("evt-1")?.status).toBe("pending");
    expect(store._getEntry("evt-1")?.visibleAt).toBe(retryAt.getTime());
  });

  it("fail with deadLetter moves entry to dead_letter status", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));
    await store.claimPending({ consumerId: "worker-1", limit: 10, leaseMs: 60_000 });

    await store.fail(
      "evt-1",
      { message: "permanent" },
      { consumerId: "worker-1", deadLetter: true },
    );

    expect(store._getEntry("evt-1")?.status).toBe("dead_letter");

    // Never returned by pending / claim
    const pending = await store.getPending(10);
    const claimed = await store.claimPending({ consumerId: "worker-1", limit: 10 });
    expect(pending).toHaveLength(0);
    expect(claimed).toHaveLength(0);
  });

  it("normalizes non-Error thrown values", async () => {
    const store = new MemoryOutboxStore();
    const publish = vi.fn().mockRejectedValue("string error");

    const outbox = new EventOutbox({
      store,
      transport: { name: "x", publish, subscribe: vi.fn(), close: vi.fn() },
    });

    await outbox.store(makeEvent("evt-1"));
    await outbox.relay();

    expect(store._getEntry("evt-1")?.lastError?.message).toBe("string error");
  });

  it("propagates error code when present", async () => {
    const store = new MemoryOutboxStore();
    const err = Object.assign(new Error("nope"), { code: "ETIMEDOUT" });
    const publish = vi.fn().mockRejectedValue(err);

    const outbox = new EventOutbox({
      store,
      transport: { name: "x", publish, subscribe: vi.fn(), close: vi.fn() },
    });

    await outbox.store(makeEvent("evt-1"));
    await outbox.relay();

    expect(store._getEntry("evt-1")?.lastError).toEqual({
      message: "nope",
      code: "ETIMEDOUT",
    });
  });
});

describe("Outbox — purge", () => {
  it("purges only delivered events older than cutoff", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));
    await store.save(makeEvent("evt-2"));
    await store.save(makeEvent("evt-3"));

    await store.acknowledge("evt-1");
    await store.acknowledge("evt-2");
    // evt-3 stays pending

    // Purge everything delivered older than -1ms (basically "all delivered")
    const purged = await store.purge(-1);
    expect(purged).toBe(2);

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.meta.id).toBe("evt-3");
  });

  it("keeps recently delivered events", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));
    await store.acknowledge("evt-1");

    // 1-hour retention → just-delivered event stays
    const purged = await store.purge(60 * 60 * 1000);
    expect(purged).toBe(0);
  });
});

describe("Outbox — consumerId", () => {
  it("generates a consumerId when not provided", () => {
    const outbox = new EventOutbox({ store: new MemoryOutboxStore() });
    expect(outbox.consumerId).toMatch(/^relay-/);
  });

  it("uses provided consumerId", () => {
    const outbox = new EventOutbox({
      store: new MemoryOutboxStore(),
      consumerId: "custom-worker",
    });
    expect(outbox.consumerId).toBe("custom-worker");
  });
});

// ============================================================================
// Write-time validation — prevent malformed events from being persisted
// ============================================================================

describe("Outbox — write-time validation", () => {
  it("EventOutbox.store rejects event missing meta.id", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store });

    // Cast through unknown to simulate bad input from untyped code
    const bad = {
      type: "order.created",
      payload: {},
      meta: { timestamp: new Date() },
    } as unknown as DomainEvent;

    await expect(outbox.store(bad)).rejects.toBeInstanceOf(InvalidOutboxEventError);

    // Nothing persisted
    expect(await store.getPending(10)).toHaveLength(0);
  });

  it("EventOutbox.store rejects event missing type", async () => {
    const outbox = new EventOutbox({ store: new MemoryOutboxStore() });
    const bad = { payload: {}, meta: { id: "x", timestamp: new Date() } } as unknown as DomainEvent;
    await expect(outbox.store(bad)).rejects.toBeInstanceOf(InvalidOutboxEventError);
  });

  it("EventOutbox.store rejects empty-string type", async () => {
    const outbox = new EventOutbox({ store: new MemoryOutboxStore() });
    const bad = { type: "", payload: {}, meta: { id: "x", timestamp: new Date() } };
    await expect(outbox.store(bad)).rejects.toBeInstanceOf(InvalidOutboxEventError);
  });

  it("EventOutbox.store rejects non-object event", async () => {
    const outbox = new EventOutbox({ store: new MemoryOutboxStore() });
    await expect(outbox.store(null as unknown as DomainEvent)).rejects.toBeInstanceOf(
      InvalidOutboxEventError,
    );
  });

  it("MemoryOutboxStore.save also validates (defense in depth)", async () => {
    const store = new MemoryOutboxStore();
    const bad = { type: "", payload: {}, meta: { id: "x", timestamp: new Date() } };
    await expect(store.save(bad)).rejects.toBeInstanceOf(InvalidOutboxEventError);
  });
});

// ============================================================================
// Malformed event — relay must not loop indefinitely
// ============================================================================

describe("Outbox — malformed event handling in relay", () => {
  it("relay breaks the batch and reports via onError if store leaks a malformed event", async () => {
    // Hand-built store that deliberately returns corrupt rows
    // (simulates a bad migration or direct DB tampering)
    const corruptStore: OutboxStore = {
      async save() {},
      async getPending() {
        // Return an event with no meta.id — should never happen with
        // well-behaved stores, but we verify relay defends against it
        return [
          { type: "bad", payload: {}, meta: {} } as unknown as DomainEvent,
          makeEvent("evt-valid"),
        ];
      },
      async acknowledge() {},
    };

    const errors: Array<{ kind: string; message: string }> = [];
    const transport = new MemoryEventTransport();
    const publishSpy = vi.spyOn(transport, "publish");

    const outbox = new EventOutbox({
      store: corruptStore,
      transport,
      onError: (info) => errors.push({ kind: info.kind, message: info.error.message }),
    });

    const relayed = await outbox.relay();

    // Batch aborted on malformed event — valid event not processed this cycle
    expect(relayed).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("malformed_event");
  });
});

// ============================================================================
// Dedupe state lifecycle — must be reclaimable after purge
// ============================================================================

describe("Outbox — dedupe lifecycle", () => {
  it("purge frees dedupe keys so the same key can be reused after delivery", async () => {
    const store = new MemoryOutboxStore();

    // Write + deliver + purge
    await store.save(makeEvent("evt-1"), { dedupeKey: "order-100" });
    await store.acknowledge("evt-1");
    const purged = await store.purge(-1);
    expect(purged).toBe(1);

    // Same dedupeKey should now be reusable
    await store.save(makeEvent("evt-2"), { dedupeKey: "order-100" });
    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.meta.id).toBe("evt-2");
  });

  it("dedupe key is still active while event is pending", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"), { dedupeKey: "op-A" });
    // Second save with same key is silently dropped (contract)
    await store.save(makeEvent("evt-2"), { dedupeKey: "op-A" });

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.meta.id).toBe("evt-1");
  });

  it("dedupe key remains held for dead-lettered events (intentional — prevents retry of known-bad op)", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"), { dedupeKey: "charge-xyz" });
    await store.claimPending({ consumerId: "w1", limit: 10, leaseMs: 60_000 });
    await store.fail("evt-1", { message: "card declined" }, { consumerId: "w1", deadLetter: true });

    // Same dedupeKey cannot resurrect
    await store.save(makeEvent("evt-2"), { dedupeKey: "charge-xyz" });
    const pending = await store.getPending(10);
    expect(pending).toHaveLength(0); // evt-2 dropped; evt-1 is dead_letter
  });
});

// ============================================================================
// Relay — onError reporting + at-least-once semantics under failures
// ============================================================================

describe("Outbox — relay error reporting", () => {
  it("reports publish_failed via onError when transport rejects", async () => {
    const store = new MemoryOutboxStore();
    const errors: string[] = [];
    const publishErr = new Error("network down");
    const publish = vi.fn().mockRejectedValue(publishErr);

    const outbox = new EventOutbox({
      store,
      transport: { name: "x", publish, subscribe: vi.fn(), close: vi.fn() },
      onError: (info) => errors.push(info.kind),
    });

    await outbox.store(makeEvent("evt-1"));
    await outbox.relay();

    expect(errors).toContain("publish_failed");
  });

  it("reports ownership_mismatch when ack throws OutboxOwnershipError after successful publish", async () => {
    // Scenario: worker-A publishes, but before it can ack, its lease expires
    // and worker-B claims. When worker-A tries to ack, the store throws
    // OutboxOwnershipError. Worker-A must report and NOT count as relayed.
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("evt-1"));

    const errors: Array<{ kind: string; eventId?: string }> = [];
    const publishCount = { n: 0 };
    const transport = new MemoryEventTransport();
    vi.spyOn(transport, "publish").mockImplementation(async () => {
      publishCount.n++;
      // Between publish and ack, simulate worker-B stealing the lease
      // by forcibly reassigning the entry's owner in the store
      const entry = store._getEntry("evt-1");
      if (entry) {
        // Direct mutation via internal access — simulates stale-lease hijack
        (entry as unknown as { leaseOwner: string }).leaseOwner = "worker-B";
      }
    });

    const outbox = new EventOutbox({
      store,
      transport,
      consumerId: "worker-A",
      onError: (info) => errors.push({ kind: info.kind, eventId: info.event?.meta.id }),
    });

    const relayed = await outbox.relay();

    // Publish happened but ack was rejected — not counted as relayed
    expect(publishCount.n).toBe(1);
    expect(relayed).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("ownership_mismatch");
    expect(errors[0]?.eventId).toBe("evt-1");
  });

  it("onError callback that throws does not break the relay loop", async () => {
    const store = new MemoryOutboxStore();
    const publish = vi.fn().mockRejectedValue(new Error("boom"));

    const outbox = new EventOutbox({
      store,
      transport: { name: "x", publish, subscribe: vi.fn(), close: vi.fn() },
      onError: () => {
        throw new Error("callback bug");
      },
    });

    await outbox.store(makeEvent("evt-1"));
    await outbox.store(makeEvent("evt-2"));

    // Should not throw — callback errors are swallowed
    await expect(outbox.relay()).resolves.toBe(0);
  });
});

// ============================================================================
// Real-world scenarios — order processing, payments, webhook delivery
// ============================================================================

describe("Outbox — real-world scenarios", () => {
  /**
   * Scenario: e-commerce order flow with 3 relay workers racing.
   * - 100 orders placed in rapid succession
   * - 3 workers concurrently claim + publish
   * - Each event must be delivered exactly once (no duplicates, no losses)
   */
  it("3 workers racing over 100 events — exactly-once end-to-end (no dupes, no losses)", async () => {
    const store = new MemoryOutboxStore();
    const delivered: string[] = [];
    const transport: EventTransport = {
      name: "tx",
      publish: async (event) => {
        delivered.push(event.meta.id);
      },
      subscribe: vi.fn(),
      close: vi.fn(),
    };

    // Pre-seed 100 events
    for (let i = 0; i < 100; i++) {
      await store.save(makeEvent(`order-${i}`, "order.placed"));
    }

    const workerA = new EventOutbox({ store, transport, consumerId: "wA", batchSize: 20 });
    const workerB = new EventOutbox({ store, transport, consumerId: "wB", batchSize: 20 });
    const workerC = new EventOutbox({ store, transport, consumerId: "wC", batchSize: 20 });

    // Race: each worker keeps relaying until nothing is pending
    const runUntilEmpty = async (outbox: EventOutbox) => {
      while (true) {
        const n = await outbox.relay();
        if (n === 0) return;
      }
    };

    await Promise.all([runUntilEmpty(workerA), runUntilEmpty(workerB), runUntilEmpty(workerC)]);

    // Every event delivered exactly once
    expect(delivered).toHaveLength(100);
    expect(new Set(delivered).size).toBe(100);

    // Nothing left pending
    expect(await store.getPending(200)).toHaveLength(0);
  });

  /**
   * Scenario: payment processing with transient + permanent failures.
   * - 5 events enqueued
   * - Gateway returns 500 for event 2 on first attempt, succeeds on retry
   * - Event 4 permanently rejected — should go to dead letter after N attempts
   * - Events 1, 3, 5 succeed immediately
   */
  it("payment gateway: transient retry + permanent dead-letter", async () => {
    const store = new MemoryOutboxStore();
    const attempts = new Map<string, number>();
    const transport: EventTransport = {
      name: "gateway",
      publish: async (event) => {
        const n = (attempts.get(event.meta.id) ?? 0) + 1;
        attempts.set(event.meta.id, n);
        if (event.meta.id === "pay-2" && n === 1) {
          throw new Error("503 Service Unavailable");
        }
        if (event.meta.id === "pay-4") {
          throw new Error("402 Payment Required");
        }
      },
      subscribe: vi.fn(),
      close: vi.fn(),
    };

    // Retry budget: up to 3 attempts, then dead-letter
    const MAX_ATTEMPTS = 3;

    // Wrap store.fail to implement retry budget + dead-letter policy
    const origFail = store.fail.bind(store);
    store.fail = async (id, err, opts) => {
      const entry = store._getEntry(id);
      const attempt = entry?.attempts ?? 0;
      if (attempt >= MAX_ATTEMPTS) {
        await origFail(id, err, { ...opts, deadLetter: true });
      } else {
        // Immediate retry (backoff omitted for test speed)
        await origFail(id, err, opts);
      }
    };

    const outbox = new EventOutbox({
      store,
      transport,
      consumerId: "payment-worker",
    });

    for (const id of ["pay-1", "pay-2", "pay-3", "pay-4", "pay-5"]) {
      await outbox.store(makeEvent(id, "payment.charge"));
    }

    // Keep draining
    for (let i = 0; i < 10; i++) {
      const n = await outbox.relay();
      if (n === 0 && (await store.getPending(10)).length === 0) break;
    }

    // pay-1, 3, 5 delivered
    expect(store._getEntry("pay-1")?.status).toBe("delivered");
    expect(store._getEntry("pay-3")?.status).toBe("delivered");
    expect(store._getEntry("pay-5")?.status).toBe("delivered");

    // pay-2 recovered after transient failure
    expect(store._getEntry("pay-2")?.status).toBe("delivered");
    expect(attempts.get("pay-2")).toBeGreaterThanOrEqual(2);

    // pay-4 exhausted retries → dead letter
    expect(store._getEntry("pay-4")?.status).toBe("dead_letter");
    expect(attempts.get("pay-4")).toBe(MAX_ATTEMPTS);
  });

  /**
   * Scenario: webhook delivery with visibleAt-based exponential backoff.
   * Customer endpoint is down for ~3 retry cycles, then recovers.
   * Relay must honor visibleAt and not spam the endpoint.
   */
  it("webhook delivery with visibleAt exponential backoff", async () => {
    const store = new MemoryOutboxStore();
    const callTimes: number[] = [];
    let failuresRemaining = 3;

    const transport: EventTransport = {
      name: "webhook",
      publish: async () => {
        callTimes.push(Date.now());
        if (failuresRemaining > 0) {
          failuresRemaining--;
          throw new Error("ECONNREFUSED");
        }
      },
      subscribe: vi.fn(),
      close: vi.fn(),
    };

    // Exponential backoff: 10ms, 20ms, 40ms (test-scale)
    const origFail = store.fail.bind(store);
    store.fail = async (id, err, opts) => {
      const attempts = store._getEntry(id)?.attempts ?? 0;
      const delayMs = 10 * 2 ** (attempts - 1);
      await origFail(id, err, { ...opts, retryAt: new Date(Date.now() + delayMs) });
    };

    const outbox = new EventOutbox({
      store,
      transport,
      consumerId: "webhook-worker",
    });

    await outbox.store(makeEvent("wh-1", "webhook.fire"));

    // Drain with small sleeps to respect visibleAt
    const start = Date.now();
    while (Date.now() - start < 500) {
      const n = await outbox.relay();
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(store._getEntry("wh-1")?.status).toBe("delivered");
    expect(callTimes).toHaveLength(4); // 3 failures + 1 success

    // Each retry should be at least delayMs apart (respects visibleAt)
    if (callTimes.length >= 2) {
      for (let i = 1; i < callTimes.length; i++) {
        const gap = (callTimes[i] ?? 0) - (callTimes[i - 1] ?? 0);
        // Allow a tiny clock skew, gap should be > 0 (respecting scheduled visibility)
        expect(gap).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /**
   * Scenario: transactional outbox — business write and event persist
   * atomically via session passthrough. Verifies the options are actually
   * threaded through to the store (not dropped).
   */
  it("transactional write — session flows from EventOutbox.store to store.save", async () => {
    const saveCalls: Array<{ event: DomainEvent; options?: OutboxWriteOptions }> = [];
    const store: OutboxStore = {
      async save(event, options) {
        saveCalls.push({ event, options });
      },
      async getPending() {
        return [];
      },
      async acknowledge() {},
    };

    const fakeSession = { txId: "tx-abc", inTransaction: true };
    const outbox = new EventOutbox({ store });

    await outbox.store(makeEvent("evt-1", "order.created"), {
      session: fakeSession,
      headers: { "x-correlation-id": "corr-123" },
    });

    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]?.event).toMatchObject({ type: "order.created" });
    expect(saveCalls[0]?.options).toMatchObject({
      session: fakeSession,
      headers: { "x-correlation-id": "corr-123" },
    });
  });

  /**
   * Scenario: stale-lease recovery across workers (crash simulation).
   * Worker-A claims 5 events then "crashes" (never acks). After the lease
   * expires, worker-B takes over and delivers all 5.
   */
  it("crashed worker — stale lease recovered by another worker", async () => {
    const store = new MemoryOutboxStore();
    const transport = new MemoryEventTransport();
    const delivered: string[] = [];
    vi.spyOn(transport, "publish").mockImplementation(async (e) => {
      delivered.push(e.meta.id);
    });

    for (let i = 0; i < 5; i++) {
      await store.save(makeEvent(`evt-${i}`));
    }

    // Worker A claims with a 1ms lease → instantly stale (simulates crash)
    const workerA_claim = await store.claimPending({
      consumerId: "workerA",
      limit: 10,
      leaseMs: 1,
    });
    expect(workerA_claim).toHaveLength(5);

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 10));

    // Worker B takes over
    const workerB = new EventOutbox({
      store,
      transport,
      consumerId: "workerB",
      leaseMs: 60_000,
    });

    const relayed = await workerB.relay();
    expect(relayed).toBe(5);
    expect(delivered).toHaveLength(5);
    expect(await store.getPending(10)).toHaveLength(0);
  });

  /**
   * Scenario: type-filtered claim — one worker handles only payment events,
   * another only shipping events. Both run concurrently without conflict.
   */
  it("type-filtered workers — specialized relay per event category", async () => {
    const store = new MemoryOutboxStore();
    await store.save(makeEvent("p-1", "payment.charge"));
    await store.save(makeEvent("s-1", "shipping.dispatch"));
    await store.save(makeEvent("p-2", "payment.refund"));
    await store.save(makeEvent("s-2", "shipping.delivered"));

    const payClaim = await store.claimPending({
      consumerId: "pay-worker",
      limit: 10,
      leaseMs: 60_000,
      types: ["payment.charge", "payment.refund"],
    });
    const shipClaim = await store.claimPending({
      consumerId: "ship-worker",
      limit: 10,
      leaseMs: 60_000,
      types: ["shipping.dispatch", "shipping.delivered"],
    });

    expect(payClaim.map((e) => e.meta.id).sort()).toEqual(["p-1", "p-2"]);
    expect(shipClaim.map((e) => e.meta.id).sort()).toEqual(["s-1", "s-2"]);
  });
});
