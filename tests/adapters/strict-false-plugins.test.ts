/**
 * Integration — audit / outbox / idempotency plugins backed by a
 * `strict: false` passthrough Mongoose model wrapped in mongokit's Repository.
 *
 * Proves the documented setup pattern actually round-trips the full doc
 * shapes (nested events, Dates, $set / $inc / $unset / $setOnInsert /
 * aggregation pipelines, dup-key handling, range queries, projections).
 *
 * Why this test exists: arc doesn't ship Mongoose schemas for these three
 * stores. The contract is "define a strict:false model, wrap it in your
 * kit's Repository, pass it in". If mongokit's Repository — or Mongoose's
 * strict:false path — mishandles any of the operators the repository
 * adapters use (especially `findOneAndUpdate` with aggregation pipelines
 * and `$setOnInsert`), the plugins break silently. This test catches that.
 */

import { batchOperationsPlugin, methodRegistryPlugin, Repository } from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repositoryAsAuditStore } from "../../src/audit/repository-audit-adapter.js";
import type { AuditEntry } from "../../src/audit/stores/interface.js";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import { EventOutbox } from "../../src/events/outbox.js";
import { repositoryAsOutboxStore } from "../../src/events/repository-outbox-adapter.js";
import { repositoryAsIdempotencyStore } from "../../src/idempotency/repository-idempotency-adapter.js";

/**
 * Arc's repository adapters for outbox / idempotency need `deleteMany`
 * (audit needs it too, optionally, for purge). mongokit exposes that only
 * when `batchOperationsPlugin` (+ its `methodRegistryPlugin` dependency)
 * is registered. This helper is the canonical setup for arc-backing
 * collections — documented in `docs/production-ops/*.mdx`.
 */
const makeArcBackingRepo = <T extends Record<string, unknown>>(model: mongoose.Model<T>) =>
  new Repository(model, [methodRegistryPlugin(), batchOperationsPlugin()]);

// ============================================================================
// Setup
// ============================================================================

const passthroughSchema = () => new Schema({}, { strict: false, timestamps: false, _id: false });

let mongoServer: MongoMemoryServer;
let AuditModel: mongoose.Model<Record<string, unknown>>;
let OutboxModel: mongoose.Model<Record<string, unknown>>;
let IdemModel: mongoose.Model<Record<string, unknown>>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  AuditModel = mongoose.model("StrictFalseAuditEntry", passthroughSchema(), "sf_audit_logs");
  OutboxModel = mongoose.model("StrictFalseOutbox", passthroughSchema(), "sf_event_outbox");
  IdemModel = mongoose.model("StrictFalseIdempotency", passthroughSchema(), "sf_idempotency");
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 30_000);

beforeEach(async () => {
  await AuditModel.collection.deleteMany({});
  await OutboxModel.collection.deleteMany({});
  await IdemModel.collection.deleteMany({});
});

// ============================================================================
// Audit — the simplest shape: flat doc + deleteMany by range
// ============================================================================

describe("Audit plugin + mongokit Repository + strict:false", () => {
  it("persists full AuditEntry, queries by filter, purges by range", async () => {
    const repo = makeArcBackingRepo(AuditModel);
    const store = repositoryAsAuditStore(repo);

    const baseEntry: Omit<AuditEntry, "id" | "timestamp"> = {
      resource: "product",
      documentId: "prod-1",
      action: "update",
      userId: "u-1",
      organizationId: "org-1",
      before: { name: "Old", price: 10 },
      after: { name: "New", price: 20 },
      changes: ["name", "price"],
      requestId: "req-1",
      ipAddress: "1.2.3.4",
      userAgent: "curl/8",
      metadata: { source: "api" },
    };

    await store.log({ ...baseEntry, id: "aud_1", timestamp: new Date("2026-04-10T00:00:00Z") });
    await store.log({ ...baseEntry, id: "aud_2", timestamp: new Date("2026-04-18T00:00:00Z") });
    await store.log({
      ...baseEntry,
      resource: "order",
      id: "aud_3",
      timestamp: new Date("2026-04-19T00:00:00Z"),
    });

    // query: resource filter round-trips nested before/after
    const productEntries = await store.query?.({ resource: "product" });
    expect(productEntries).toHaveLength(2);
    const first = productEntries.find((e) => e.id === "aud_1")!;
    expect(first.before).toEqual({ name: "Old", price: 10 });
    expect(first.after).toEqual({ name: "New", price: 20 });
    expect(first.changes).toEqual(["name", "price"]);
    expect(first.timestamp).toBeInstanceOf(Date);
    expect(first.metadata).toEqual({ source: "api" });

    // sort: -1 on timestamp
    const sorted = await store.query?.({});
    expect(sorted[0]?.id).toBe("aud_3");

    // purge: deleteMany with { timestamp: { $lt } }
    const purged = await store.purgeOlderThan?.(new Date("2026-04-15T00:00:00Z"));
    expect(purged).toBe(1);
    const remaining = await store.query?.({});
    expect(remaining).toHaveLength(2);
    expect(remaining.map((e) => e.id).sort()).toEqual(["aud_2", "aud_3"]);
  });

  // Regression: `query({ limit })` was silently dropping limit in 2.10.0/2.10.1
  // because the adapter called `repository.findAll(filter, { skip, limit })` —
  // mongokit's findAll doesn't accept those options. Switched to getAll's
  // offset-paginated envelope; this test locks the correct pagination shape.
  it("query() respects limit and offset (regression: 2.10.0/2.10.1)", async () => {
    const repo = makeArcBackingRepo(AuditModel);
    const store = repositoryAsAuditStore(repo);

    // Seed 25 rows so pagination can bite
    for (let i = 0; i < 25; i++) {
      await store.log({
        id: `aud_${String(i).padStart(2, "0")}`,
        resource: "product",
        documentId: `prod-${i}`,
        action: "update",
        timestamp: new Date(`2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
      });
    }

    const firstPage = await store.query?.({ limit: 10 });
    expect(firstPage).toHaveLength(10); // must NOT return all 25

    const secondPage = await store.query?.({ limit: 10, offset: 10 });
    expect(secondPage).toHaveLength(10);

    // Pages must not overlap
    const firstIds = new Set(firstPage.map((e) => e.id));
    const secondIds = new Set(secondPage.map((e) => e.id));
    for (const id of secondIds) expect(firstIds.has(id)).toBe(false);

    const tail = await store.query?.({ limit: 10, offset: 20 });
    expect(tail).toHaveLength(5); // 25 total, 20 already consumed
  });
});

// ============================================================================
// Outbox — the hardest shape: nested event, aggregation pipelines, FIFO claim
// ============================================================================

describe("EventOutbox + mongokit Repository + strict:false", () => {
  // Low-level store tests exercise the repository adapter directly
  // (claimPending / acknowledge / fail / getDeadLettered live on OutboxStore,
  // not on the public EventOutbox surface).

  it("low-level store: claim → ack round-trips nested DomainEvent", async () => {
    const store = repositoryAsOutboxStore(makeArcBackingRepo(OutboxModel));

    await store.save({
      type: "order.created",
      payload: { item: "widget", qty: 3, nested: { flag: true } },
      meta: {
        id: "evt-1",
        timestamp: new Date("2026-04-19T10:00:00Z"),
        correlationId: "cor-1",
      },
    });

    const claimed = await store.claimPending?.({ consumerId: "w1", limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.type).toBe("order.created");
    expect(claimed[0]?.payload).toEqual({ item: "widget", qty: 3, nested: { flag: true } });
    expect(claimed[0]?.meta.id).toBe("evt-1");
    expect(claimed[0]?.meta.timestamp).toBeInstanceOf(Date);

    await store.acknowledge("evt-1", { consumerId: "w1" });

    // second claim returns nothing (already delivered)
    const second = await store.claimPending?.({ consumerId: "w1" });
    expect(second).toHaveLength(0);
  });

  it("low-level store: fail() with aggregation pipeline preserves firstFailedAt across retries", async () => {
    const store = repositoryAsOutboxStore(makeArcBackingRepo(OutboxModel));

    await store.save({
      type: "x",
      payload: {},
      meta: { id: "evt-fail", timestamp: new Date() },
    });

    await store.claimPending?.({ consumerId: "w1" });
    await store.fail?.("evt-fail", { message: "first error" }, { consumerId: "w1" });

    const reclaimed = await store.claimPending?.({ consumerId: "w1" });
    expect(reclaimed).toHaveLength(1);

    await store.fail?.("evt-fail", { message: "second error" }, { consumerId: "w1" });

    // Inspect raw doc — firstFailedAt should be from first failure
    const raw = await OutboxModel.collection.findOne({ _id: "evt-fail" });
    expect(raw).toBeTruthy();
    expect(raw?.firstFailedAt).toBeInstanceOf(Date);
    expect(raw?.lastFailedAt).toBeInstanceOf(Date);
    expect((raw?.lastFailedAt as Date).getTime()).toBeGreaterThanOrEqual(
      (raw?.firstFailedAt as Date).getTime(),
    );
    expect((raw?.lastError as { message: string }).message).toBe("second error");
    expect(raw?.attempts).toBe(2);
  });

  it("low-level store: dead-letter transition + getDeadLettered() query", async () => {
    const store = repositoryAsOutboxStore(makeArcBackingRepo(OutboxModel));

    await store.save({
      type: "t",
      payload: {},
      meta: { id: "evt-dlq", timestamp: new Date() },
    });
    await store.claimPending?.({ consumerId: "w1" });
    await store.fail?.(
      "evt-dlq",
      { message: "terminal", code: "E_FATAL" },
      { consumerId: "w1", deadLetter: true },
    );

    const dlq = await store.getDeadLettered?.(10);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.event.meta.id).toBe("evt-dlq");
    expect(dlq[0]?.error.message).toBe("terminal");
    expect(dlq[0]?.error.code).toBe("E_FATAL");
  });

  // Regression: getPending + getDeadLettered were calling findAll with
  // `{ limit }` which mongokit silently dropped — every call returned every
  // doc. Switched to getAll's offset-paginated envelope; these two tests
  // lock the bounded-read behaviour.
  it("getPending(limit) actually bounds the result (regression: 2.10.0/2.10.1)", async () => {
    const store = repositoryAsOutboxStore(makeArcBackingRepo(OutboxModel));

    for (let i = 0; i < 15; i++) {
      await store.save({
        type: "evt",
        payload: { i },
        meta: { id: `evt-${i}`, timestamp: new Date() },
      });
    }

    const bounded = await store.getPending(5);
    expect(bounded).toHaveLength(5); // must NOT return all 15

    const all = await store.getPending(100);
    expect(all).toHaveLength(15);
  });

  it("getDeadLettered(limit) actually bounds the result (regression: 2.10.0/2.10.1)", async () => {
    const store = repositoryAsOutboxStore(makeArcBackingRepo(OutboxModel));

    // Push 8 events into the DLQ
    for (let i = 0; i < 8; i++) {
      await store.save({
        type: "evt",
        payload: {},
        meta: { id: `dlq-${i}`, timestamp: new Date() },
      });
      await store.claimPending?.({ consumerId: "w", limit: 1 });
      await store.fail?.(`dlq-${i}`, { message: "boom" }, { consumerId: "w", deadLetter: true });
    }

    const bounded = await store.getDeadLettered?.(3);
    expect(bounded).toHaveLength(3); // must NOT return all 8

    const all = await store.getDeadLettered?.(50);
    expect(all).toHaveLength(8);
  });

  it("dup _id on save is swallowed (idempotent save)", async () => {
    const store = repositoryAsOutboxStore(makeArcBackingRepo(OutboxModel));

    const ev = {
      type: "dup",
      payload: { k: 1 },
      meta: { id: "evt-same", timestamp: new Date() },
    };
    await store.save(ev);
    await expect(store.save(ev)).resolves.toBeUndefined(); // dup _id → swallowed

    const pending = await store.getPending(10);
    expect(pending).toHaveLength(1);
  });

  it("EventOutbox public API: store → relay → transport receives event", async () => {
    const transport = new MemoryEventTransport();
    const received: string[] = [];
    await transport.subscribe("*", async (ev) => {
      received.push(ev.meta.id);
    });

    const outbox = new EventOutbox({
      repository: makeArcBackingRepo(OutboxModel),
      transport,
      consumerId: "w-public",
    });

    await outbox.store({
      type: "order.created",
      payload: { item: "widget" },
      meta: { id: "evt-public", timestamp: new Date() },
    });

    expect(received).toHaveLength(0); // not yet relayed
    const relayed = await outbox.relay();
    expect(relayed).toBe(1);
    expect(received).toEqual(["evt-public"]);
  });

  it("EventOutbox.purge() deletes delivered docs older than cutoff", async () => {
    const transport = new MemoryEventTransport();
    await transport.subscribe("*", async () => {}); // absorb publishes
    const outbox = new EventOutbox({
      repository: makeArcBackingRepo(OutboxModel),
      transport,
      consumerId: "w-purge",
    });

    await outbox.store({
      type: "t",
      payload: {},
      meta: { id: "evt-old", timestamp: new Date() },
    });
    await outbox.relay(); // publishes + acks

    // Backdate deliveredAt so purge() finds it
    await OutboxModel.collection.updateOne(
      { _id: "evt-old" },
      { $set: { deliveredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } },
    );

    const purged = await outbox.purge(7 * 24 * 60 * 60 * 1000);
    expect(purged).toBe(1);
    const remaining = await OutboxModel.collection.countDocuments({});
    expect(remaining).toBe(0);
  });
});

// ============================================================================
// Idempotency — $set + $setOnInsert + $unset + upsert + regex
// ============================================================================

describe("Idempotency plugin + mongokit Repository + strict:false", () => {
  it("tryLock / set / get / unlock round-trip with upsert + $setOnInsert", async () => {
    const repo = makeArcBackingRepo(IdemModel);
    const store = repositoryAsIdempotencyStore(repo, 86_400_000);

    // acquire lock via findOneAndUpdate + upsert + $setOnInsert
    const acquired = await store.tryLock("key-1", "req-1", 30_000);
    expect(acquired).toBe(true);

    // second caller cannot acquire
    const contended = await store.tryLock("key-1", "req-2", 30_000);
    expect(contended).toBe(false);

    // locked check reflects live state
    expect(await store.isLocked("key-1")).toBe(true);

    // set() writes result + $unset lock
    await store.set("key-1", {
      statusCode: 201,
      headers: { "x-request-id": "req-1" },
      body: { id: "o-1", ok: true },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    expect(await store.isLocked("key-1")).toBe(false);

    // get() returns full result, parses Dates
    const result = await store.get("key-1");
    expect(result).toBeDefined();
    expect(result?.statusCode).toBe(201);
    expect(result?.headers).toEqual({ "x-request-id": "req-1" });
    expect(result?.body).toEqual({ id: "o-1", ok: true });
    expect(result?.createdAt).toBeInstanceOf(Date);
    expect(result?.expiresAt).toBeInstanceOf(Date);
  });

  it("expired lock is preemptable (compound filter works on nested field)", async () => {
    const repo = makeArcBackingRepo(IdemModel);
    const store = repositoryAsIdempotencyStore(repo, 86_400_000);

    await store.tryLock("key-exp", "req-1", 30_000);
    // Backdate lock.expiresAt so filter `{ 'lock.expiresAt': { $lt: now } }` matches
    await IdemModel.collection.updateOne(
      { _id: "key-exp" },
      { $set: { "lock.expiresAt": new Date(Date.now() - 1000) } },
    );

    const preempted = await store.tryLock("key-exp", "req-2", 30_000);
    expect(preempted).toBe(true);
  });

  it("deleteByPrefix via $regex deletes matching keys only", async () => {
    const repo = makeArcBackingRepo(IdemModel);
    const store = repositoryAsIdempotencyStore(repo, 86_400_000);

    const baseResult = {
      statusCode: 200,
      headers: {},
      body: {},
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await store.set("user:1:order:a", baseResult);
    await store.set("user:1:order:b", baseResult);
    await store.set("user:2:order:c", baseResult);

    const deleted = await store.deleteByPrefix("user:1:");
    expect(deleted).toBe(2);

    expect(await store.get("user:1:order:a")).toBeUndefined();
    expect(await store.get("user:2:order:c")).toBeDefined();
  });
});
