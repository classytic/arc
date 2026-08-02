/**
 * Outbox Store Contract Suite
 *
 * `OutboxStore` is the delivery guarantee for every domain event arc publishes.
 * Its contract (`@classytic/primitives/outbox`) states six MUST invariants, and
 * each one is a silent-data-loss bug when an implementation gets it wrong:
 * a non-atomic `claimPending` double-delivers, a lenient `acknowledge` lets a
 * hijacked event count as relayed, a `fail` that forgets to clear the lease
 * strands the row until its lease expires.
 *
 * None of that shows up in ordinary tests — the store looks fine until two
 * relayers run at once, or a worker dies mid-batch. This suite exercises those
 * paths directly, so any implementation can prove it honours the contract.
 * Passing it IS the contract.
 *
 * @example
 * ```typescript
 * import { runOutboxStoreContract } from '@classytic/arc/testing/outbox';
 * import { MongoOutboxStore } from '../src/shared/outbox/mongo-outbox-store.js';
 *
 * runOutboxStoreContract('MongoOutboxStore', async () => {
 *   const store = new MongoOutboxStore(model);
 *   return {
 *     store,
 *     // REQUIRED — run before every test; the suite's absolute assertions
 *     // ("exactly zero pending") are meaningless without it.
 *     reset: async () => { await model.deleteMany({}); },
 *     teardown: async () => { await model.deleteMany({}); },
 *   };
 * });
 * ```
 *
 * Optional members (`claimPending`, `fail`, `getDeadLettered`, `purge`) are
 * feature-detected: a store that does not implement one has those tests
 * skipped rather than failed, matching how arc's relay feature-detects them.
 *
 * This module statically imports `vitest`, which arc declares as an OPTIONAL peer —
 * install it to use this subpath. Only load it from test code: arc's production bundle
 * never references this subpath, so the import tree stays clean under tree-shaking.
 *
 * That import is a deliberate coupling, shared with arc's other conformance suites
 * (`testing/cleanup`, `testing/storage`). A framework-independent case specification
 * plus a thin Vitest adapter would free Jest / `node:test` consumers, but it is worth
 * doing across all three at once or not at all — one suite diverging is worse than the
 * coupling.
 */

import type { DomainEvent } from "@classytic/primitives/events";
import { OutboxOwnershipError, type OutboxStore } from "@classytic/primitives/outbox";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// ============================================================================
// Types
// ============================================================================

export interface OutboxStoreContractSetupResult {
  store: OutboxStore;
  /** Called once after the suite. */
  teardown?: () => Promise<void>;
  /**
   * Empty the store. REQUIRED, and run before every test.
   *
   * Not a recommendation: several assertions are absolute rather than relative —
   * "exactly zero pending", "exactly two", "`oldestPendingAgeMs()` is null on an
   * empty queue". Without a reset those read whatever the previous test left, so the
   * suite passes on ORDER rather than on behaviour, and inserting one unrelated case
   * turns a conforming store red. A store that cannot empty itself cannot be
   * conformance-tested.
   */
  reset: () => Promise<void>;
}

export type OutboxStoreContractSetup = () => Promise<OutboxStoreContractSetupResult>;

// ============================================================================
// Fixtures
// ============================================================================

let seq = 0;
/** A minimal well-formed event. Ids are unique per call. */
function event(type = "test.event"): DomainEvent {
  seq += 1;
  return {
    type,
    payload: { n: seq },
    meta: { id: `evt-${Date.now()}-${seq}`, occurredAt: new Date().toISOString() },
  } as unknown as DomainEvent;
}

const idOf = (e: DomainEvent): string => (e as unknown as { meta: { id: string } }).meta.id;

// ============================================================================
// Suite
// ============================================================================

export function runOutboxStoreContract(name: string, setup: OutboxStoreContractSetup): void {
  describe(`OutboxStore contract: ${name}`, () => {
    let store: OutboxStore;
    let teardown: (() => Promise<void>) | undefined;
    let reset: () => Promise<void>;

    beforeAll(async () => {
      const result = await setup();
      store = result.store;
      teardown = result.teardown;
      reset = result.reset;
    });

    afterAll(async () => {
      if (teardown) await teardown();
    });

    /**
     * Isolation for EVERY test, not just the ones that call `seed()`. Resetting inside
     * `seed()` left any test that asserts on an empty store — or that only reads —
     * running against its predecessor's rows.
     */
    beforeEach(async () => {
      await reset();
    });

    /** Save n events, oldest first. */
    async function seed(n: number, type?: string): Promise<DomainEvent[]> {
      const events: DomainEvent[] = [];
      for (let i = 0; i < n; i++) {
        const e = event(type);
        await store.save(e);
        events.push(e);
      }
      return events;
    }

    // ── Invariant 1: save must reject invalid events ────────────────────────
    describe("save — rejects malformed events (invariant 1)", () => {
      it("persists a well-formed event", async () => {
        const [e] = await seed(1);
        const pending = await store.getPending(10);
        expect(pending.map(idOf)).toContain(idOf(e as DomainEvent));
      });

      it("THROWS rather than persisting an event with no `type`", async () => {
        const bad = { payload: {}, meta: { id: "no-type" } } as unknown as DomainEvent;
        await expect(store.save(bad)).rejects.toThrow();
        // And it must not have landed — a persisted malformed row would be
        // returned by a later getPending and break the relay (invariant 6).
        expect((await store.getPending(10)).length).toBe(0);
      });

      it("THROWS rather than persisting an event with no `meta.id`", async () => {
        const bad = { type: "x", payload: {}, meta: {} } as unknown as DomainEvent;
        await expect(store.save(bad)).rejects.toThrow();
        expect((await store.getPending(10)).length).toBe(0);
      });
    });

    // ── FIFO + well-formedness ──────────────────────────────────────────────
    describe("getPending", () => {
      it("returns events FIFO (oldest first)", async () => {
        const saved = await seed(3);
        const pending = await store.getPending(10);
        expect(pending.slice(0, 3).map(idOf)).toEqual(saved.map(idOf));
      });

      it("honours the limit", async () => {
        await seed(3);
        expect((await store.getPending(2)).length).toBeLessThanOrEqual(2);
      });

      it("returns only well-formed events (invariant 6)", async () => {
        await seed(2);
        for (const e of await store.getPending(10)) {
          expect(typeof e.type).toBe("string");
          expect(e.type.length).toBeGreaterThan(0);
          expect(idOf(e)).toBeTruthy();
        }
      });
    });

    // ── Invariant 2: claimPending must be atomic ────────────────────────────
    describe("claimPending — exclusive lease (invariant 2)", () => {
      it("claims pending events", async ({ skip }) => {
        if (!store.claimPending) return skip();
        await seed(2);
        const claimed = await store.claimPending({ consumerId: "c1", limit: 10 });
        expect(claimed.length).toBe(2);
      });

      it("two concurrent claimers NEVER receive the same event", async ({ skip }) => {
        if (!store.claimPending) return skip();
        await seed(6);

        // Run both claims concurrently — this is the race the invariant exists
        // for, and a non-atomic implementation double-delivers here.
        const [a, b] = await Promise.all([
          store.claimPending({ consumerId: "c1", limit: 6 }),
          store.claimPending({ consumerId: "c2", limit: 6 }),
        ]);

        const idsA = a.map(idOf);
        const idsB = b.map(idOf);
        const overlap = idsA.filter((id) => idsB.includes(id));
        expect(overlap).toEqual([]);
        // Between them they must not exceed what exists (no duplication).
        expect(idsA.length + idsB.length).toBeLessThanOrEqual(6);
      });

      it("does not re-claim an event whose lease is still live", async ({ skip }) => {
        if (!store.claimPending) return skip();
        await seed(2);
        await store.claimPending({ consumerId: "c1", limit: 10, leaseMs: 60_000 });

        const second = await store.claimPending({ consumerId: "c2", limit: 10 });
        expect(second).toEqual([]);
      });

      it("RECLAIMS an event whose lease expired (crashed worker)", async ({ skip }) => {
        if (!store.claimPending) return skip();
        await seed(1);
        // Zero-length lease: already expired by the time we claim again.
        await store.claimPending({ consumerId: "dead", limit: 10, leaseMs: 0 });

        const reclaimed = await store.claimPending({ consumerId: "c2", limit: 10 });
        expect(reclaimed.length).toBe(1);
      });

      it("claims FIFO", async ({ skip }) => {
        if (!store.claimPending) return skip();
        const saved = await seed(3);
        const claimed = await store.claimPending({ consumerId: "c1", limit: 2 });
        expect(claimed.map(idOf)).toEqual(saved.slice(0, 2).map(idOf));
      });
    });

    // ── Invariants 3 + 4: acknowledge ownership + unknown-id no-op ──────────
    describe("acknowledge", () => {
      it("removes the event from pending", async () => {
        const [e] = await seed(1);
        await store.acknowledge(idOf(e as DomainEvent));
        expect((await store.getPending(10)).map(idOf)).not.toContain(idOf(e as DomainEvent));
      });

      it("is a NO-OP for an unknown id — never an ownership error (invariant 4)", async () => {
        await expect(store.acknowledge("does-not-exist")).resolves.not.toThrow();
      });

      it("THROWS OutboxOwnershipError when consumerId is not the lease owner (invariant 3)", async ({
        skip,
      }) => {
        if (!store.claimPending) return skip();
        await seed(1);
        const [claimed] = await store.claimPending({
          consumerId: "owner",
          limit: 1,
          leaseMs: 60_000,
        });
        if (!claimed) return skip();

        // A hijacker must NOT be able to mark the event relayed — the relay
        // relies on this signal to avoid counting hijacked events as delivered.
        await expect(
          store.acknowledge(idOf(claimed), { consumerId: "impostor" }),
        ).rejects.toBeInstanceOf(OutboxOwnershipError);
      });

      it("succeeds for the rightful lease owner", async ({ skip }) => {
        if (!store.claimPending) return skip();
        await seed(1);
        const [claimed] = await store.claimPending({
          consumerId: "owner",
          limit: 1,
          leaseMs: 60_000,
        });
        if (!claimed) return skip();

        await expect(
          store.acknowledge(idOf(claimed), { consumerId: "owner" }),
        ).resolves.not.toThrow();
      });
    });

    // ── Invariant 5: fail clears the lease / reschedules deterministically ──
    describe("fail — deterministic lease + visibility (invariant 5)", () => {
      it("makes the event re-claimable again (lease cleared)", async ({ skip }) => {
        if (!store.fail || !store.claimPending) return skip();
        await seed(1);
        const [claimed] = await store.claimPending({ consumerId: "c1", limit: 1, leaseMs: 60_000 });
        if (!claimed) return skip();

        await store.fail(idOf(claimed), { message: "boom" });

        // Without a retryAt the event must be immediately re-claimable — a
        // store that forgets to clear the lease strands it until expiry.
        const again = await store.claimPending({ consumerId: "c2", limit: 10 });
        expect(again.map(idOf)).toContain(idOf(claimed));
      });

      it("THROWS OutboxOwnershipError on a consumerId mismatch (invariant 3)", async ({ skip }) => {
        if (!store.fail || !store.claimPending) return skip();
        await seed(1);
        const [claimed] = await store.claimPending({
          consumerId: "owner",
          limit: 1,
          leaseMs: 60_000,
        });
        if (!claimed) return skip();

        await expect(
          store.fail(idOf(claimed), { message: "boom" }, { consumerId: "impostor" }),
        ).rejects.toBeInstanceOf(OutboxOwnershipError);
      });

      it("honours `retryAt` — the event is NOT immediately re-claimable", async ({ skip }) => {
        if (!store.fail || !store.claimPending) return skip();
        await seed(1);
        const [claimed] = await store.claimPending({ consumerId: "c1", limit: 1, leaseMs: 60_000 });
        if (!claimed) return skip();

        await store.fail(
          idOf(claimed),
          { message: "boom" },
          {
            retryAt: new Date(Date.now() + 60_000),
          },
        );

        const again = await store.claimPending({ consumerId: "c2", limit: 10 });
        expect(again.map(idOf)).not.toContain(idOf(claimed));
      });

      it("`deadLetter: true` removes it from the pending stream", async ({ skip }) => {
        if (!store.fail) return skip();
        const [e] = await seed(1);
        await store.fail(idOf(e as DomainEvent), { message: "fatal" }, { deadLetter: true });

        expect((await store.getPending(10)).map(idOf)).not.toContain(idOf(e as DomainEvent));
      });
    });

    // ── Dead-letter surface ─────────────────────────────────────────────────
    describe("getDeadLettered", () => {
      it("returns dead-lettered events with their failure metadata", async ({ skip }) => {
        if (!store.fail || !store.getDeadLettered) return skip();
        const [e] = await seed(1);
        await store.fail(idOf(e as DomainEvent), { message: "fatal" }, { deadLetter: true });

        const dead = await store.getDeadLettered(10);
        const row = dead.find((d) => idOf(d.event as DomainEvent) === idOf(e as DomainEvent));
        expect(row).toBeDefined();
        // The contract requires these be populated from the fail() calls.
        expect(row?.error).toBeDefined();
        expect(typeof row?.attempts).toBe("number");
      });
    });

    // ── purge is delivered-only ─────────────────────────────────────────────
    describe("purge", () => {
      it("NEVER removes pending events — delivered-only scope", async ({ skip }) => {
        if (!store.purge) return skip();
        await seed(2);

        await store.purge(0); // even with a zero cutoff, pending is off-limits

        expect((await store.getPending(10)).length).toBe(2);
      });
    });

    // ── Operator surface ────────────────────────────────────────────────────
    /**
     * `requeue`, `countByStatus` and `oldestPendingAgeMs` were a HOST's three extra
     * methods before they were contract members — which is why they are pinned here.
     * A dead-letter row an operator cannot re-drive, or a health number that lies, fails
     * silently: the operator concludes the queue is fine, and the whole point of the
     * table is that somebody eventually looks.
     */
    describe("requeue", () => {
      it("returns a dead-lettered event to pending and clears the attempt count", async ({
        skip,
      }) => {
        if (!store.fail || !store.requeue) return skip();
        const [e] = await seed(1);
        const id = idOf(e as DomainEvent);
        await store.fail(id, { message: "fatal" }, { deadLetter: true });
        expect((await store.getPending(10)).length).toBe(0);

        expect(await store.requeue(id)).toBe(true);

        const pending = await store.getPending(10);
        expect(pending.length).toBe(1);
        // Re-driving with the old count would dead-letter again on the next blip, which
        // reads as "the operator's fix did not work" when in fact it was never retried.
        if (store.countByStatus) expect(await store.countByStatus("dead_letter")).toBe(0);
      });

      it("REFUSES a pending event — requeue is dead-letter-scoped", async ({ skip }) => {
        if (!store.requeue) return skip();
        const [e] = await seed(1);

        // A row that is merely backing off must not have its attempts zeroed; the id
        // alone cannot tell the two states apart, so the store must check status.
        expect(await store.requeue(idOf(e as DomainEvent))).toBe(false);
      });

      it("is FALSE, not an error, for an unknown id", async ({ skip }) => {
        if (!store.requeue) return skip();
        // An operator working a worklist races the relay; an id already dealt with is an
        // ordinary outcome, not an exception to handle.
        expect(await store.requeue("no-such-event")).toBe(false);
      });
    });

    describe("countByStatus", () => {
      it("counts pending, and moves the count as events are delivered", async ({ skip }) => {
        if (!store.countByStatus) return skip();
        await seed(3);
        expect(await store.countByStatus("pending")).toBe(3);

        if (!store.claimPending) return skip();
        const [claimed] = await store.claimPending({ consumerId: "c", limit: 1, leaseMs: 60_000 });
        if (!claimed) return skip();
        await store.acknowledge(idOf(claimed as DomainEvent), { consumerId: "c" });

        expect(await store.countByStatus("pending")).toBe(2);
        expect(await store.countByStatus("delivered")).toBe(1);
      });

      it("counts dead-lettered rows — the number an alert fires on", async ({ skip }) => {
        if (!store.countByStatus || !store.fail) return skip();
        expect(await store.countByStatus("dead_letter")).toBe(0);
        const [e] = await seed(1);
        await store.fail(idOf(e as DomainEvent), { message: "fatal" }, { deadLetter: true });

        expect(await store.countByStatus("dead_letter")).toBe(1);
      });
    });

    describe("oldestPendingAgeMs", () => {
      it("is null on an empty queue, and a non-negative age once something pends", async ({
        skip,
      }) => {
        if (!store.oldestPendingAgeMs) return skip();
        expect(await store.oldestPendingAgeMs()).toBeNull();

        await seed(1);
        const age = await store.oldestPendingAgeMs();
        expect(age).not.toBeNull();
        expect(age ?? -1).toBeGreaterThanOrEqual(0);
      });

      it("ignores DELIVERED rows — it answers 'how long undelivered', not 'how old'", async ({
        skip,
      }) => {
        if (!store.oldestPendingAgeMs) return skip();
        if (!store.claimPending) return skip();
        await seed(1);
        const [claimed] = await store.claimPending({ consumerId: "c", limit: 1, leaseMs: 60_000 });
        if (!claimed) return skip();
        await store.acknowledge(idOf(claimed as DomainEvent), { consumerId: "c" });

        // A delivered row still in the retention window must not keep the alert lit.
        expect(await store.oldestPendingAgeMs()).toBeNull();
      });
    });
  });
}
