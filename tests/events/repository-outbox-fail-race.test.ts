/**
 * Regression: `repositoryAsOutboxStore.fail()` must surface
 * `OutboxOwnershipError` when the lease is stolen between the pre-write
 * `safeGetOne` and the `findOneAndUpdate`. Before this fix, the post-write
 * null was silently ignored and the failed event quietly stayed pending —
 * the operator got no signal that the failure-marking attempt was a no-op.
 *
 * `acknowledge()` already does this re-check (see outbox-capabilities.test.ts
 * "only owner can acknowledge held event"); `fail()` now matches.
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { describe, expect, it } from "vitest";
import { OutboxOwnershipError } from "../../src/events/outbox.js";
import { repositoryAsOutboxStore } from "../../src/events/repository-outbox-adapter.js";

interface OutboxRow extends Record<string, unknown> {
  _id: string;
  status: "pending" | "delivered" | "dead_letter";
  attempts: number;
  visibleAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  deliveredAt: Date | null;
  firstFailedAt: Date | null;
  lastFailedAt: Date | null;
  lastError: { message: string; code?: string } | null;
  dedupeKey: string | null;
  partitionKey: string | null;
  headers: Record<string, string> | null;
  createdAt: Date;
  event: { type: string; payload: unknown; meta: { id: string; timestamp: Date } };
  type: string;
}

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  const now = new Date();
  return {
    _id: "evt-1",
    status: "pending",
    attempts: 1,
    visibleAt: now,
    leaseOwner: "worker-A",
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    deliveredAt: null,
    firstFailedAt: null,
    lastFailedAt: null,
    lastError: null,
    dedupeKey: null,
    partitionKey: null,
    headers: null,
    createdAt: now,
    event: { type: "test.event", payload: {}, meta: { id: "evt-1", timestamp: now } },
    type: "test.event",
    ...overrides,
  };
}

describe("repositoryAsOutboxStore.fail() — post-write lease race", () => {
  it("throws OutboxOwnershipError when findOneAndUpdate returns null and the lease moved", async () => {
    // Sequence of getOne reads:
    //   1. pre-write check  → row owned by worker-A (passes)
    //   2. post-write recheck → row now owned by worker-B (raises)
    const getOneResults: OutboxRow[] = [
      makeRow({ leaseOwner: "worker-A" }),
      makeRow({ leaseOwner: "worker-B" }),
    ];
    const repository: RepositoryLike = {
      create: async () => ({}),
      getOne: async () => getOneResults.shift() ?? null,
      getAll: async () => ({ data: [], total: 0, page: 1, limit: 0, pages: 0 }),
      deleteMany: async () => ({ deletedCount: 0 }),
      // Simulate the lease being stolen mid-write — no row matches
      // `_id=evt-1 AND leaseOwner=worker-A` once worker-B has it.
      findOneAndUpdate: async () => null,
    } as unknown as RepositoryLike;

    const store = repositoryAsOutboxStore(repository);

    await expect(
      store.fail("evt-1", { message: "boom" }, { consumerId: "worker-A" }),
    ).rejects.toBeInstanceOf(OutboxOwnershipError);

    // Error carries the new owner so the operator can correlate logs.
    try {
      // Reset the queue for the second invocation.
      getOneResults.push(makeRow({ leaseOwner: "worker-A" }), makeRow({ leaseOwner: "worker-B" }));
      await store.fail("evt-1", { message: "boom" }, { consumerId: "worker-A" });
    } catch (err) {
      expect(err).toBeInstanceOf(OutboxOwnershipError);
      const own = err as OutboxOwnershipError;
      expect(own.eventId).toBe("evt-1");
      expect(own.attemptedBy).toBe("worker-A");
      expect(own.currentOwner).toBe("worker-B");
    }
  });

  it("does NOT throw when no consumerId is supplied (id-only filter; null = row purged)", async () => {
    // Without consumerId the fail() filter is id-only, so a null
    // findOneAndUpdate result means the row was purged mid-flight, not a
    // lease race. Contract: silent no-op, matching acknowledge()'s
    // unknown-id branch.
    const repository: RepositoryLike = {
      create: async () => ({}),
      getOne: async () => makeRow({ leaseOwner: null }),
      getAll: async () => ({ data: [], total: 0, page: 1, limit: 0, pages: 0 }),
      deleteMany: async () => ({ deletedCount: 0 }),
      findOneAndUpdate: async () => null,
    } as unknown as RepositoryLike;

    const store = repositoryAsOutboxStore(repository);
    await expect(store.fail("evt-1", { message: "boom" })).resolves.toBeUndefined();
  });
});
