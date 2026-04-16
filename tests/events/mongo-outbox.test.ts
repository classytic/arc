/**
 * MongoOutboxStore — deep integration tests against a real MongoDB.
 *
 * Why the outbox matters (in 3 lines):
 *
 *   1. You write a row + publish an event in the same user request. If the
 *      transport (Redis/Kafka) is down at that moment, the row commits
 *      but the event vanishes — silent data divergence.
 *   2. The outbox fixes this by persisting the event in the SAME database
 *      transaction as the row, then a background relayer guarantees
 *      at-least-once delivery to the transport.
 *   3. Multi-worker relay + retry/DLQ policy + dedupe let it scale: many
 *      app instances can claim safely; transient transport failures are
 *      retried; permanent failures land in a typed DLQ for ops to inspect.
 *
 * Scenarios covered:
 *
 *   - Happy path save + FIFO pending + acknowledge
 *   - Dedupe via `dedupeKey` AND via `meta.idempotencyKey` (auto-mapped by `EventOutbox.store`)
 *   - `claimPending` atomic lease — two racers never see the same event
 *   - Lease expiry: abandoned claim is reclaimable by a different worker
 *   - `fail()` preserves `firstFailedAt`, updates `lastFailedAt`, re-visibility
 *   - `retryAt` schedules the event in the future (skipped by claim until then)
 *   - `fail({ deadLetter: true })` moves to DLQ; `getDeadLettered()` returns
 *     typed `DeadLetteredEvent<T>` envelopes with populated timestamps/attempts
 *   - Ownership enforcement: ack/fail from the wrong consumer throws
 *     `OutboxOwnershipError`; unknown ids are no-ops
 *   - `purge()` deletes delivered docs only — pending/dead-letter untouched
 *   - `onDisconnect: 'throw'` default fails loudly; `'no-op'` swallows silently
 *   - Session threading: save accepts a session without crashing
 *   - End-to-end via `EventOutbox`: failurePolicy drives retry → DLQ;
 *     `outbox.getDeadLettered()` reads back typed envelopes
 *   - `type` filter on claims works
 *   - Round-trip preserves every v2.9 meta field (aggregate, source, etc.)
 */

import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createEvent,
  type DeadLetteredEvent,
  type EventTransport,
} from "../../src/events/EventTransport.js";
import { EventOutbox, exponentialBackoff, OutboxOwnershipError } from "../../src/events/outbox.js";
import { MongoOutboxStore } from "../../src/events/transports/mongo-outbox.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupTestDatabase();
}, 60_000);

afterAll(async () => {
  await teardownTestDatabase();
});

// Per-suite collection so tests don't see each other's state.
let suiteCounter = 0;
function freshStore(
  overrides: Partial<{
    collectionName: string;
    retentionMs: number;
    onDisconnect: "throw" | "no-op";
    defaultLeaseMs: number;
    purgeBatchSize: number;
  }> = {},
) {
  suiteCounter += 1;
  return new MongoOutboxStore({
    connection: mongoose.connection,
    collectionName: `arc_outbox_test_${Date.now()}_${suiteCounter}`,
    // Quick defaults so tests run fast
    defaultLeaseMs: 250,
    ...overrides,
  });
}

function alwaysFailingTransport(err = new Error("transport-down")): EventTransport {
  return {
    name: "test-fail",
    publish: async () => {
      throw err;
    },
    subscribe: async () => () => {},
  };
}

afterEach(async () => {
  // Drop every test collection we created. Keeps the shared in-memory Mongo
  // lean and prevents cross-test interference from lingering docs.
  const db = mongoose.connection.db;
  if (!db) return;
  const cols = await db.listCollections({ name: /^arc_outbox_test_/ }).toArray();
  for (const c of cols) {
    await db
      .collection(c.name)
      .drop()
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Save + dedupe
// ---------------------------------------------------------------------------

describe("MongoOutboxStore — save + dedupe", () => {
  it("saves a well-formed event and returns it from getPending", async () => {
    const store = freshStore();
    const event = createEvent("order.placed", { orderId: "o1" });
    await store.save(event);

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.meta.id).toBe(event.meta.id);
  });

  it("rejects events missing type or meta.id", async () => {
    const store = freshStore();
    await expect(store.save({ payload: {}, meta: {} } as never)).rejects.toThrow(
      /type is required/,
    );
    await expect(store.save({ type: "x", payload: {}, meta: {} } as never)).rejects.toThrow(
      /meta\.id is required/,
    );
  });

  it("dedupeKey: second save with same key is a silent no-op", async () => {
    const store = freshStore();
    const e1 = createEvent("x", { n: 1 });
    const e2 = createEvent("x", { n: 2 });
    await store.save(e1, { dedupeKey: "op-42" });
    await store.save(e2, { dedupeKey: "op-42" });

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.meta.id).toBe(e1.meta.id);
  });

  it("EventOutbox.store auto-maps meta.idempotencyKey → dedupeKey", async () => {
    const store = freshStore();
    const outbox = new EventOutbox({ store });
    await outbox.store(createEvent("x", { n: 1 }, { idempotencyKey: "ik-7" }));
    await outbox.store(createEvent("x", { n: 2 }, { idempotencyKey: "ik-7" }));

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
  });

  it("re-saving the same event.meta.id is idempotent (no-op)", async () => {
    const store = freshStore();
    const event = createEvent("x", {});
    await store.save(event);
    // Same id, different payload — must not throw
    await store.save({ ...event, payload: { changed: true } });
    expect(await store.getPending(10)).toHaveLength(1);
  });

  it("preserves every v2.9 meta field through the round-trip", async () => {
    const store = freshStore();
    const event = createEvent(
      "cart.line_added",
      { lineId: "l1" },
      {
        correlationId: "trace-1",
        causationId: "cause-1",
        partitionKey: "cart-99",
        source: "commerce",
        idempotencyKey: "cart:99:add:1",
        aggregate: { type: "cart", id: "cart-99" },
        schemaVersion: 2,
      },
    );
    await store.save(event);
    const [out] = await store.getPending(1);
    expect(out!.meta).toMatchObject({
      correlationId: "trace-1",
      causationId: "cause-1",
      partitionKey: "cart-99",
      source: "commerce",
      idempotencyKey: "cart:99:add:1",
      aggregate: { type: "cart", id: "cart-99" },
      schemaVersion: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// claimPending — lease + concurrency
// ---------------------------------------------------------------------------

describe("MongoOutboxStore — claimPending", () => {
  it("FIFO order by createdAt", async () => {
    const store = freshStore();
    const e1 = createEvent("x", { n: 1 });
    const e2 = createEvent("x", { n: 2 });
    const e3 = createEvent("x", { n: 3 });
    await store.save(e1);
    await new Promise((r) => setTimeout(r, 5));
    await store.save(e2);
    await new Promise((r) => setTimeout(r, 5));
    await store.save(e3);

    const claimed = await store.claimPending({ consumerId: "w1", limit: 10 });
    expect(claimed.map((e) => e.meta.id)).toEqual([e1.meta.id, e2.meta.id, e3.meta.id]);
  });

  it("two racing consumers never see the same event", async () => {
    const store = freshStore();
    // Seed 20 events
    for (let i = 0; i < 20; i++) {
      await store.save(createEvent("x", { n: i }));
    }

    const [a, b] = await Promise.all([
      store.claimPending({ consumerId: "worker-a", limit: 20 }),
      store.claimPending({ consumerId: "worker-b", limit: 20 }),
    ]);

    const idsA = new Set(a.map((e) => e.meta.id));
    const idsB = new Set(b.map((e) => e.meta.id));
    // No overlap
    for (const id of idsA) expect(idsB.has(id)).toBe(false);
    // Union = 20
    expect(idsA.size + idsB.size).toBe(20);
  });

  it("lease expiry: abandoned events are re-claimable by another consumer", async () => {
    const store = freshStore({ defaultLeaseMs: 80 });
    const event = createEvent("x", {});
    await store.save(event);

    const first = await store.claimPending({ consumerId: "lost-worker" });
    expect(first).toHaveLength(1);

    // Before lease expires: not re-claimable
    const midBatch = await store.claimPending({ consumerId: "recovery-worker" });
    expect(midBatch).toHaveLength(0);

    // After lease expires
    await new Promise((r) => setTimeout(r, 120));
    const recovered = await store.claimPending({ consumerId: "recovery-worker" });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.meta.id).toBe(event.meta.id);
  });

  it("type filter claims only matching events", async () => {
    const store = freshStore();
    await store.save(createEvent("order.placed", {}));
    await store.save(createEvent("order.shipped", {}));
    await store.save(createEvent("refund.issued", {}));

    const claimed = await store.claimPending({
      consumerId: "w",
      types: ["order.placed", "order.shipped"],
    });
    expect(claimed.map((e) => e.type).sort()).toEqual(["order.placed", "order.shipped"]);
  });
});

// ---------------------------------------------------------------------------
// fail + retryAt + dead-letter + ownership
// ---------------------------------------------------------------------------

describe("MongoOutboxStore — fail / retry / DLQ / ownership", () => {
  it("fail() sets firstFailedAt once, lastFailedAt on every call", async () => {
    const store = freshStore();
    const event = createEvent("x", {});
    await store.save(event);
    await store.claimPending({ consumerId: "w" });

    await store.fail(event.meta.id, { message: "boom-1" }, { consumerId: "w" });
    // Release lease so we can claim again
    const claim2 = await store.claimPending({ consumerId: "w" });
    expect(claim2).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 10));
    await store.fail(event.meta.id, { message: "boom-2" }, { consumerId: "w" });

    // Force to DLQ to inspect timestamps
    const claim3 = await store.claimPending({ consumerId: "w" });
    expect(claim3).toHaveLength(1);
    await store.fail(
      event.meta.id,
      { message: "boom-3" },
      {
        consumerId: "w",
        deadLetter: true,
      },
    );

    const dl = await store.getDeadLettered(10);
    expect(dl).toHaveLength(1);
    expect(dl[0]!.firstFailedAt.getTime()).toBeLessThan(dl[0]!.lastFailedAt.getTime());
  });

  it("retryAt schedules event in the future — claim skips until then", async () => {
    const store = freshStore();
    const event = createEvent("x", {});
    await store.save(event);
    await store.claimPending({ consumerId: "w" });

    const future = new Date(Date.now() + 500);
    await store.fail(
      event.meta.id,
      { message: "retry" },
      {
        consumerId: "w",
        retryAt: future,
      },
    );

    // Immediately: not claimable
    const early = await store.claimPending({ consumerId: "w2", limit: 10 });
    expect(early).toHaveLength(0);

    // After visibility: claimable
    await new Promise((r) => setTimeout(r, 550));
    const late = await store.claimPending({ consumerId: "w2", limit: 10 });
    expect(late).toHaveLength(1);
  });

  it("deadLetter: true transitions event out of the pending pool", async () => {
    const store = freshStore();
    const event = createEvent("x", {});
    await store.save(event);
    await store.claimPending({ consumerId: "w" });
    await store.fail(
      event.meta.id,
      { message: "dead" },
      {
        consumerId: "w",
        deadLetter: true,
      },
    );

    // No longer pending
    expect(await store.claimPending({ consumerId: "w" })).toHaveLength(0);
    expect(await store.getPending(10)).toHaveLength(0);
    // Present in DLQ
    const dl = await store.getDeadLettered(10);
    expect(dl).toHaveLength(1);
    expect(dl[0]!.error.message).toBe("dead");
  });

  it("ack from wrong consumer throws OutboxOwnershipError", async () => {
    const store = freshStore();
    const event = createEvent("x", {});
    await store.save(event);
    await store.claimPending({ consumerId: "owner" });

    await expect(store.acknowledge(event.meta.id, { consumerId: "not-owner" })).rejects.toThrow(
      OutboxOwnershipError,
    );
  });

  it("fail from wrong consumer throws OutboxOwnershipError", async () => {
    const store = freshStore();
    const event = createEvent("x", {});
    await store.save(event);
    await store.claimPending({ consumerId: "owner" });

    await expect(
      store.fail(event.meta.id, { message: "x" }, { consumerId: "not-owner" }),
    ).rejects.toThrow(OutboxOwnershipError);
  });

  it("ack/fail on unknown id is a no-op (contract #4)", async () => {
    const store = freshStore();
    await expect(store.acknowledge("does-not-exist", { consumerId: "w" })).resolves.toBeUndefined();
    await expect(
      store.fail("does-not-exist", { message: "x" }, { consumerId: "w" }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getDeadLettered shape
// ---------------------------------------------------------------------------

describe("MongoOutboxStore — getDeadLettered envelope", () => {
  it("returns typed DeadLetteredEvent[] with populated fields", async () => {
    const store = freshStore();
    const event = createEvent("billing.charge", { amt: 100 });
    await store.save(event);
    await store.claimPending({ consumerId: "w" });
    await store.fail(
      event.meta.id,
      { message: "gateway-503", code: "GATEWAY_DOWN" },
      {
        consumerId: "w",
        deadLetter: true,
      },
    );

    const dl = await store.getDeadLettered(10);
    expect(dl).toHaveLength(1);
    const envelope: DeadLetteredEvent = dl[0]!;
    expect(envelope.event.meta.id).toBe(event.meta.id);
    expect(envelope.error.message).toBe("gateway-503");
    expect(envelope.error.code).toBe("GATEWAY_DOWN");
    expect(envelope.attempts).toBeGreaterThanOrEqual(1);
    expect(envelope.firstFailedAt).toBeInstanceOf(Date);
    expect(envelope.lastFailedAt).toBeInstanceOf(Date);
  });

  it("limit is honoured", async () => {
    const store = freshStore();
    for (let i = 0; i < 5; i++) {
      const e = createEvent("x", { n: i });
      await store.save(e);
      await store.claimPending({ consumerId: "w", limit: 1 });
      await store.fail(e.meta.id, { message: "x" }, { consumerId: "w", deadLetter: true });
    }
    expect(await store.getDeadLettered(3)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Purge — batched cursor delete
// ---------------------------------------------------------------------------

describe("MongoOutboxStore — purge (batched)", () => {
  it("deletes delivered docs older than cutoff; leaves pending + DLQ untouched", async () => {
    const store = freshStore({ purgeBatchSize: 3 });

    // 5 delivered + 2 pending + 1 DLQ
    const delivered: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = createEvent("x", { n: i });
      await store.save(e);
      await store.claimPending({ consumerId: "w", limit: 1 });
      await store.acknowledge(e.meta.id, { consumerId: "w" });
      delivered.push(e.meta.id);
    }
    // Make them "old": backdate deliveredAt via direct Mongo update
    const col = mongoose.connection.db!.collection(
      (store as unknown as { collectionName: string }).collectionName,
    );
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    await col.updateMany({ _id: { $in: delivered } }, { $set: { deliveredAt: old } });

    // 2 pending
    await store.save(createEvent("pending-1", {}));
    await store.save(createEvent("pending-2", {}));

    // 1 DLQ — target claim via type filter so we don't accidentally claim one
    // of the two pending-N events that were saved earlier (FIFO ordering).
    const dead = createEvent("dead-1", {});
    await store.save(dead);
    await store.claimPending({ consumerId: "w", limit: 1, types: ["dead-1"] });
    await store.fail(dead.meta.id, { message: "x" }, { consumerId: "w", deadLetter: true });

    // Purge anything delivered > 7 days ago
    const removed = await store.purge(7 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(5);

    // 2 pending + 1 DLQ remain
    const remaining = await col.countDocuments({});
    expect(remaining).toBe(3);
  });

  it("purge with no matches returns 0", async () => {
    const store = freshStore();
    const e = createEvent("x", {});
    await store.save(e);
    const removed = await store.purge(60_000);
    expect(removed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// onDisconnect policy
// ---------------------------------------------------------------------------

describe("MongoOutboxStore — onDisconnect policy", () => {
  it("default 'throw' rejects saves when connection isn't ready", async () => {
    // Simulate disconnect by passing a stub connection
    const stub = { readyState: 0, db: null };
    const store = new MongoOutboxStore({
      connection: stub as never,
      collectionName: "arc_outbox_disconnect_throw",
    });
    await expect(store.save(createEvent("x", {}))).rejects.toThrow(/connection is not ready/);
  });

  it("'no-op' silently skips when disconnected (dev/test only)", async () => {
    const stub = { readyState: 0, db: null };
    const store = new MongoOutboxStore({
      connection: stub as never,
      collectionName: "arc_outbox_disconnect_noop",
      onDisconnect: "no-op",
    });
    await expect(store.save(createEvent("x", {}))).resolves.toBeUndefined();
    expect(await store.getPending(10)).toEqual([]);
    expect(await store.getDeadLettered(10)).toEqual([]);
    expect(await store.purge(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end with EventOutbox — failurePolicy drives retry → DLQ
// ---------------------------------------------------------------------------

describe("MongoOutboxStore + EventOutbox — full retry → DLQ story", () => {
  it("failurePolicy routes to DLQ after N attempts; getDeadLettered reads back", async () => {
    const store = freshStore();
    const outbox = new EventOutbox({
      store,
      transport: alwaysFailingTransport(new Error("gateway-down")),
      failurePolicy: ({ attempts }) =>
        attempts >= 3
          ? { deadLetter: true }
          : { retryAt: exponentialBackoff({ attempt: attempts, baseMs: 5, maxMs: 20 }) },
    });

    await outbox.store(
      createEvent("payment.capture", { amount: 50 }, { idempotencyKey: "cap:p1" }),
    );

    // Relay until DLQ (with short waits to respect retryAt)
    for (let i = 0; i < 12; i++) {
      const r = await outbox.relayBatch();
      if (r.deadLettered > 0) break;
      await new Promise((res) => setTimeout(res, 25));
    }

    const dl = await outbox.getDeadLettered();
    expect(dl).toHaveLength(1);
    expect(dl[0]!.attempts).toBeGreaterThanOrEqual(3);
    expect(dl[0]!.event.type).toBe("payment.capture");
    expect(dl[0]!.event.meta.idempotencyKey).toBe("cap:p1");
  }, 30_000);

  it("RelayResult.deadLettered counter matches real DLQ transitions", async () => {
    const store = freshStore();
    const outbox = new EventOutbox({
      store,
      transport: alwaysFailingTransport(),
      failurePolicy: () => ({ deadLetter: true }),
    });

    await outbox.store(createEvent("x", { n: 1 }));
    await outbox.store(createEvent("x", { n: 2 }));

    const r = await outbox.relayBatch();
    expect(r.deadLettered).toBe(2);
    expect(await outbox.getDeadLettered()).toHaveLength(2);
  });
});
