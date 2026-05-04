/**
 * Outbox v2.9 — four additions covered end-to-end:
 *
 *   1. Auto-map `meta.idempotencyKey` → `OutboxWriteOptions.dedupeKey`
 *   2. `OutboxFailurePolicy` drives retry/DLQ decisions centrally
 *   3. `RelayResult.deadLettered` counts DLQ transitions per batch
 *   4. `store.getDeadLettered()` returns typed `DeadLetteredEvent` envelopes
 *
 * Uses `MemoryOutboxStore` + a controllable in-memory transport so each
 * scenario is deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createEvent,
  type DeadLetteredEvent,
  type DomainEvent,
  type EventTransport,
  type PublishManyResult,
} from "../../src/events/EventTransport.js";
import {
  EventOutbox,
  exponentialBackoff,
  MemoryOutboxStore,
  type OutboxFailurePolicy,
} from "../../src/events/outbox.js";

function alwaysFailingTransport(): EventTransport {
  return {
    name: "test-always-fail",
    publish: async () => {
      throw new Error("downstream-503");
    },
    subscribe: async () => () => {},
  };
}

function countingTransport(): EventTransport & { publishes: DomainEvent[] } {
  const publishes: DomainEvent[] = [];
  return {
    name: "test-count",
    publishes,
    publish: async (e) => {
      publishes.push(e);
    },
    subscribe: async () => () => {},
  };
}

describe("outbox v2.9 — auto-map idempotencyKey → dedupeKey", () => {
  it("dedupes subsequent saves when event.meta.idempotencyKey matches", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store });

    const e1 = createEvent("order.placed", { orderId: "o1" }, { idempotencyKey: "ik-1" });
    const e2 = createEvent("order.placed", { orderId: "o1" }, { idempotencyKey: "ik-1" });

    await outbox.store(e1);
    await outbox.store(e2);

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.meta.id).toBe(e1.meta.id);
  });

  it("caller-supplied dedupeKey wins over meta.idempotencyKey", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store });

    const e1 = createEvent("x", {}, { idempotencyKey: "from-meta" });
    const e2 = createEvent("x", {}, { idempotencyKey: "from-meta" });

    await outbox.store(e1, { dedupeKey: "explicit-a" });
    await outbox.store(e2, { dedupeKey: "explicit-b" });

    // Different explicit keys → no dedupe despite shared idempotencyKey
    expect(await store.getPending(10)).toHaveLength(2);
  });

  it("no idempotencyKey + no dedupeKey → no dedupe (back-compat)", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({ store });

    await outbox.store(createEvent("x", { n: 1 }));
    await outbox.store(createEvent("x", { n: 2 }));
    expect(await store.getPending(10)).toHaveLength(2);
  });
});

describe("outbox v2.9 — failurePolicy drives retry + DLQ", () => {
  it("routes to dead-letter once the policy returns { deadLetter: true }", async () => {
    const store = new MemoryOutboxStore();
    const policy = vi.fn<OutboxFailurePolicy>(({ attempts }) => ({
      deadLetter: attempts >= 2,
    }));
    const outbox = new EventOutbox({
      store,
      transport: alwaysFailingTransport(),
      failurePolicy: policy,
    });

    const event = createEvent("refund.requested", { orderId: "o1" });
    await outbox.store(event);

    // Attempt 1 → policy returns {} (no deadLetter), re-visible immediately
    const r1 = await outbox.relayBatch();
    expect(r1.publishFailed).toBe(1);
    expect(r1.deadLettered).toBe(0);

    // Attempt 2 → policy returns { deadLetter: true }
    const r2 = await outbox.relayBatch();
    expect(r2.publishFailed).toBe(1);
    expect(r2.deadLettered).toBe(1);

    // Attempt 3 → event is in DLQ, nothing to claim
    const r3 = await outbox.relayBatch();
    expect(r3.attempted).toBe(0);

    // Policy called twice with matching attempt counts
    expect(policy).toHaveBeenCalledTimes(2);
    expect(policy.mock.calls[0]?.[0].attempts).toBe(1);
    expect(policy.mock.calls[1]?.[0].attempts).toBe(2);
  });

  it("retryAt schedules the event for later (not immediately re-claimable)", async () => {
    const store = new MemoryOutboxStore();
    const future = new Date(Date.now() + 60_000);
    const outbox = new EventOutbox({
      store,
      transport: alwaysFailingTransport(),
      failurePolicy: () => ({ retryAt: future }),
    });

    await outbox.store(createEvent("x", {}));
    const r1 = await outbox.relayBatch();
    expect(r1.publishFailed).toBe(1);

    // Second claim: nothing becomes visible until `future`
    const r2 = await outbox.relayBatch();
    expect(r2.attempted).toBe(0);
  });

  it("composes cleanly with exponentialBackoff helper", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({
      store,
      transport: alwaysFailingTransport(),
      failurePolicy: ({ attempts }) =>
        attempts >= 3
          ? { deadLetter: true }
          : { retryAt: exponentialBackoff({ attempt: attempts, baseMs: 1, maxMs: 10 }) },
    });

    await outbox.store(createEvent("x", {}));
    // Loop until the event lands in DLQ or we've tried a safe max.
    for (let i = 0; i < 10; i++) {
      await outbox.relayBatch();
      await new Promise((r) => setTimeout(r, 12));
    }
    const dl = await outbox.getDeadLettered();
    expect(dl).toHaveLength(1);
    expect(dl[0]?.attempts).toBeGreaterThanOrEqual(3);
  });

  it("policy throwing does NOT break the relay — falls back to default fail()", async () => {
    const store = new MemoryOutboxStore();
    const policy = vi.fn<OutboxFailurePolicy>(() => {
      throw new Error("policy bug");
    });
    const onError = vi.fn();
    const outbox = new EventOutbox({
      store,
      transport: alwaysFailingTransport(),
      failurePolicy: policy,
      onError,
    });

    await outbox.store(createEvent("x", {}));
    const r = await outbox.relayBatch();

    expect(r.publishFailed).toBe(1);
    expect(r.deadLettered).toBe(0); // default fail path, no DLQ
    // onError reports the policy exception under fail_failed
    expect(onError).toHaveBeenCalled();
  });

  it("attempts counter clears on successful ack", async () => {
    const store = new MemoryOutboxStore();
    let shouldFail = true;
    const transport: EventTransport = {
      name: "flaky",
      publish: async () => {
        if (shouldFail) throw new Error("flaky");
      },
      subscribe: async () => () => {},
    };
    const attemptsSeen: number[] = [];
    const outbox = new EventOutbox({
      store,
      transport,
      failurePolicy: ({ attempts }) => {
        attemptsSeen.push(attempts);
        return {};
      },
    });

    const eventA = createEvent("x", { tag: "A" });
    await outbox.store(eventA);
    await outbox.relayBatch(); // fail #1 for A
    await outbox.relayBatch(); // fail #2 for A
    shouldFail = false;
    await outbox.relayBatch(); // succeeds, attempts cleared

    // Now store a NEW event. First failure on B should read attempts=1, NOT 3.
    shouldFail = true;
    const eventB = createEvent("x", { tag: "B" });
    await outbox.store(eventB);
    await outbox.relayBatch(); // fail #1 for B

    expect(attemptsSeen).toEqual([1, 2, 1]);
  });
});

describe("outbox v2.9 — getDeadLettered returns DeadLetteredEvent[]", () => {
  it("returns typed envelope with populated attempts + timestamps + error", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({
      store,
      transport: alwaysFailingTransport(),
      failurePolicy: () => ({ deadLetter: true }),
    });

    const event = createEvent("billing.charge", { amount: 100 });
    await outbox.store(event);
    await outbox.relayBatch();

    const dl = await outbox.getDeadLettered();
    expect(dl).toHaveLength(1);
    const envelope: DeadLetteredEvent = dl[0]!;

    expect(envelope.event.meta.id).toBe(event.meta.id);
    expect(envelope.attempts).toBe(1);
    expect(envelope.error.message).toBe("downstream-503");
    expect(envelope.firstFailedAt).toBeInstanceOf(Date);
    expect(envelope.lastFailedAt).toBeInstanceOf(Date);
    expect(envelope.lastFailedAt.getTime()).toBeGreaterThanOrEqual(
      envelope.firstFailedAt.getTime(),
    );
  });

  it("limit honoured", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({
      store,
      transport: alwaysFailingTransport(),
      failurePolicy: () => ({ deadLetter: true }),
    });

    for (let i = 0; i < 5; i++) {
      await outbox.store(createEvent("x", { n: i }));
    }
    // Relay 5 times so each gets one failure → DLQ
    for (let i = 0; i < 5; i++) await outbox.relayBatch();

    const two = await outbox.getDeadLettered(2);
    expect(two).toHaveLength(2);
  });

  it("returns [] for stores without getDeadLettered (graceful degradation)", async () => {
    const barebonesStore = {
      save: async () => {},
      getPending: async () => [],
      acknowledge: async () => {},
    };
    const outbox = new EventOutbox({ store: barebonesStore });
    expect(await outbox.getDeadLettered()).toEqual([]);
  });
});

describe("outbox v2.9 — RelayResult.deadLettered counter", () => {
  it("counts DLQ transitions in the same batch", async () => {
    const store = new MemoryOutboxStore();
    const outbox = new EventOutbox({
      store,
      transport: alwaysFailingTransport(),
      failurePolicy: () => ({ deadLetter: true }),
    });

    await outbox.store(createEvent("x", { n: 1 }));
    await outbox.store(createEvent("x", { n: 2 }));
    await outbox.store(createEvent("x", { n: 3 }));

    const r = await outbox.relayBatch();
    expect(r.attempted).toBe(3);
    expect(r.publishFailed).toBe(3);
    expect(r.deadLettered).toBe(3);
  });

  it("is zero for successful batches (back-compat sanity)", async () => {
    const store = new MemoryOutboxStore();
    const transport = countingTransport();
    const outbox = new EventOutbox({ store, transport });

    await outbox.store(createEvent("x", {}));
    const r = await outbox.relayBatch();
    expect(r.relayed).toBe(1);
    expect(r.deadLettered).toBe(0);
  });

  it("publishMany batch failure: deadLettered counts events pushed to DLQ", async () => {
    // Exercise the publishMany path with per-event outcomes.
    const store = new MemoryOutboxStore();
    const transport: EventTransport = {
      name: "test-batch",
      publish: async () => {},
      publishMany: async (events): Promise<PublishManyResult> => {
        const m = new Map<string, Error | null>();
        for (const e of events) m.set(e.meta.id, new Error("partial outage"));
        return m;
      },
      subscribe: async () => () => {},
    };
    const outbox = new EventOutbox({
      store,
      transport,
      failurePolicy: () => ({ deadLetter: true }),
    });

    await outbox.store(createEvent("x", { n: 1 }));
    await outbox.store(createEvent("x", { n: 2 }));

    const r = await outbox.relayBatch();
    expect(r.usedPublishMany).toBe(true);
    expect(r.deadLettered).toBe(2);
  });
});
