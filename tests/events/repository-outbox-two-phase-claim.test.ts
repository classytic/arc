/**
 * Wave-12 performance: `repositoryAsOutboxStore.claimPending()` two-phase
 * batch claim.
 *
 * The pre-2.24 implementation claimed one row per `findOneAndUpdate` in a
 * SEQUENTIAL loop — batch size 50 = 50 serial DB round-trips per relay
 * tick. The two-phase rewrite does:
 *
 *   Phase 1 — ONE `getAll` (claimable filter, `createdAt` ASC, `limit`)
 *             to fetch candidate rows.
 *   Phase 2 — CONCURRENT per-id `findOneAndUpdate` CAS calls that
 *             RE-CHECK the claimable filter, so a candidate stolen
 *             between the phases simply drops out (race loser → null).
 *
 * Wall-clock ≈ 2 round-trips regardless of batch size. This file locks in:
 *   - exactly one candidate fetch per claim call
 *   - phase-2 CAS calls run concurrently, not sequentially
 *   - race losers (null CAS result) are skipped without error
 *   - FIFO candidate order is preserved in the returned events
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { describe, expect, it, vi } from "vitest";
import { repositoryAsOutboxStore } from "../../src/events/repository-outbox-adapter.js";

interface OutboxRow extends Record<string, unknown> {
  _id: string;
  status: "pending" | "delivered" | "dead_letter";
  attempts: number;
  visibleAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  event: { type: string; payload: unknown; meta: { id: string; timestamp: Date } };
  type: string;
}

function makeRow(id: string, createdAt: Date): OutboxRow {
  return {
    _id: id,
    status: "pending",
    attempts: 0,
    visibleAt: createdAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt,
    event: { type: "test.event", payload: {}, meta: { id, timestamp: createdAt } },
    type: "test.event",
  };
}

function rows(n: number): OutboxRow[] {
  const base = Date.now();
  return Array.from({ length: n }, (_, i) => makeRow(`evt-${i + 1}`, new Date(base + i)));
}

describe("repositoryAsOutboxStore.claimPending — two-phase batch claim", () => {
  it("issues ONE candidate fetch + one CAS per candidate, preserving FIFO order", async () => {
    const candidates = rows(5);
    const getAll = vi.fn(async () => ({
      data: candidates,
      total: 5,
      page: 1,
      limit: 5,
      pages: 1,
    }));
    const findOneAndUpdate = vi.fn(async (filter: unknown) => {
      const id = /evt-\d+/.exec(JSON.stringify(filter))?.[0];
      const row = candidates.find((c) => c._id === id);
      if (!row) return null;
      return { ...row, leaseOwner: "worker-A", attempts: 1 };
    });
    const repo = {
      create: async () => ({}),
      getOne: async () => null,
      getAll,
      deleteMany: async () => ({ deletedCount: 0 }),
      findOneAndUpdate,
    } as unknown as RepositoryLike;

    const store = repositoryAsOutboxStore(repo);
    const events = await store.claimPending({ consumerId: "worker-A", limit: 5 });

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(5);
    // FIFO — returned events follow phase-1 candidate (createdAt ASC) order.
    expect(events.map((e) => e.meta.id)).toEqual(["evt-1", "evt-2", "evt-3", "evt-4", "evt-5"]);
  });

  it("runs phase-2 CAS calls CONCURRENTLY (a sequential loop would deadlock this barrier)", async () => {
    const candidates = rows(3);
    let started = 0;
    let releaseAll: () => void = () => {};
    const allStarted = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const repo = {
      create: async () => ({}),
      getOne: async () => null,
      getAll: async () => ({ data: candidates, total: 3, page: 1, limit: 3, pages: 1 }),
      deleteMany: async () => ({ deletedCount: 0 }),
      // Barrier: each CAS blocks until ALL of them have started. A serial
      // implementation would await the first call forever → test timeout.
      findOneAndUpdate: async (filter: unknown) => {
        started += 1;
        if (started === candidates.length) releaseAll();
        await allStarted;
        const id = /evt-\d+/.exec(JSON.stringify(filter))?.[0];
        const row = candidates.find((c) => c._id === id);
        return row ? { ...row, leaseOwner: "worker-A", attempts: 1 } : null;
      },
    } as unknown as RepositoryLike;

    const store = repositoryAsOutboxStore(repo);
    const events = await store.claimPending({ consumerId: "worker-A", limit: 3 });
    expect(events).toHaveLength(3);
  });

  it("skips race losers — a null CAS result drops the candidate without failing the batch", async () => {
    const candidates = rows(3);
    const repo = {
      create: async () => ({}),
      getOne: async () => null,
      getAll: async () => ({ data: candidates, total: 3, page: 1, limit: 3, pages: 1 }),
      deleteMany: async () => ({ deletedCount: 0 }),
      // evt-2 is "stolen" by another worker between phase 1 and phase 2 —
      // its re-checked claimable filter matches nothing.
      findOneAndUpdate: async (filter: unknown) => {
        const str = JSON.stringify(filter);
        if (str.includes("evt-2")) return null;
        const id = /evt-\d+/.exec(str)?.[0];
        const row = candidates.find((c) => c._id === id);
        return row ? { ...row, leaseOwner: "worker-A", attempts: 1 } : null;
      },
    } as unknown as RepositoryLike;

    const store = repositoryAsOutboxStore(repo);
    const events = await store.claimPending({ consumerId: "worker-A", limit: 3 });

    expect(events.map((e) => e.meta.id)).toEqual(["evt-1", "evt-3"]);
  });

  it("returns [] without any CAS when phase 1 finds no candidates", async () => {
    const findOneAndUpdate = vi.fn();
    const repo = {
      create: async () => ({}),
      getOne: async () => null,
      getAll: async () => ({ data: [], total: 0, page: 1, limit: 0, pages: 0 }),
      deleteMany: async () => ({ deletedCount: 0 }),
      findOneAndUpdate,
    } as unknown as RepositoryLike;

    const store = repositoryAsOutboxStore(repo);
    const events = await store.claimPending({ consumerId: "worker-A", limit: 10 });

    expect(events).toEqual([]);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
