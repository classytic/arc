/**
 * Lock-in test for the v2.11.x evaluation of `StandardRepo.claim()`
 * (repo-core 0.4+) inside `repositoryAsOutboxStore`.
 *
 * Decision: `claim` is intentionally NOT adopted in any of the adapter's
 * three CAS sites (`claimPending`, `acknowledge`, `fail`). See the module
 * docblock in `repository-outbox-adapter.ts` for the per-site reasoning.
 *
 * This test proves that decision is wired correctly:
 *   1. `claimPending` does NOT call `repository.claim` even when the
 *      kit ships it — it stays on the find+sort+CAS `findOneAndUpdate`
 *      path, which is the single-round-trip primitive the FIFO loop
 *      needs.
 *   2. `acknowledge` does NOT call `repository.claim` — it stays on
 *      `findOneAndUpdate` so the `ne('status', 'delivered')` source-state
 *      predicate (broader than `claim`'s exact-`from` requirement)
 *      remains intact.
 *   3. `fail` does NOT call `repository.claim` — it stays on
 *      `findOneAndUpdate` so the id-only filter (no source-state
 *      predicate) remains intact and `firstFailedAt` is preserved by the
 *      read-then-write pair.
 *
 * If a future change tries to "modernize" by routing through `claim`,
 * these assertions fire and force the change through review with the
 * docblock rationale on screen.
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
    attempts: 0,
    visibleAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
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

/**
 * Build a `RepositoryLike` whose `claim` is a spy that throws if invoked.
 * The adapter must NOT route through `claim` for any of its CAS sites.
 */
function makeRepoWithClaimTrap(
  fou: (filter: unknown, update: unknown, opts?: unknown) => Promise<OutboxRow | null>,
  getOne: () => Promise<OutboxRow | null> = async () => null,
) {
  const claim = vi.fn(async () => {
    throw new Error("repositoryAsOutboxStore must NOT call repository.claim");
  });
  const repo = {
    create: async () => ({}),
    getOne,
    getAll: async () => ({ data: [], total: 0, page: 1, limit: 0, pages: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    findOneAndUpdate: vi.fn(fou),
    claim,
  } as unknown as RepositoryLike & {
    claim: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
  };
  return repo;
}

describe("repositoryAsOutboxStore — does not adopt StandardRepo.claim", () => {
  it("claimPending uses findOneAndUpdate, never claim, even when claim is available", async () => {
    let claimedOnce = false;
    const repo = makeRepoWithClaimTrap(async () => {
      // Return one claimed row, then null to terminate the loop.
      if (claimedOnce) return null;
      claimedOnce = true;
      return makeRow({
        status: "pending",
        leaseOwner: "worker-A",
        leaseExpiresAt: new Date(Date.now() + 30_000),
        attempts: 1,
      });
    });

    const store = repositoryAsOutboxStore(repo);
    const events = await store.claimPending({ consumerId: "worker-A", limit: 5 });

    expect(events).toHaveLength(1);
    expect(events[0]?.meta.id).toBe("evt-1");
    expect(repo.claim).not.toHaveBeenCalled();
    expect(repo.findOneAndUpdate).toHaveBeenCalled();
  });

  it("acknowledge uses findOneAndUpdate, never claim", async () => {
    const repo = makeRepoWithClaimTrap(async () =>
      makeRow({ status: "delivered", deliveredAt: new Date() }),
    );

    const store = repositoryAsOutboxStore(repo);
    await store.acknowledge("evt-1", { consumerId: "worker-A" });

    expect(repo.claim).not.toHaveBeenCalled();
    expect(repo.findOneAndUpdate).toHaveBeenCalledTimes(1);
    // Verify the `ne('status', 'delivered')` predicate remains in the
    // filter — that's the broader-than-claim semantics we're locking in.
    const [filterArg] = repo.findOneAndUpdate.mock.calls[0] as [unknown];
    expect(JSON.stringify(filterArg)).toContain("delivered");
  });

  it("fail uses findOneAndUpdate, never claim, with id-only filter (no source-state predicate)", async () => {
    const repo = makeRepoWithClaimTrap(
      async () =>
        makeRow({
          status: "pending",
          leaseOwner: "worker-A",
          leaseExpiresAt: new Date(Date.now() + 30_000),
          firstFailedAt: new Date(),
          lastFailedAt: new Date(),
          lastError: { message: "boom" },
        }),
      async () =>
        makeRow({
          status: "pending",
          leaseOwner: "worker-A",
          leaseExpiresAt: new Date(Date.now() + 30_000),
        }),
    );

    const store = repositoryAsOutboxStore(repo);
    await store.fail("evt-1", { message: "boom" }, { consumerId: "worker-A" });

    expect(repo.claim).not.toHaveBeenCalled();
    expect(repo.findOneAndUpdate).toHaveBeenCalledTimes(1);
    // Lock in the "no source-state predicate" invariant — the filter
    // intentionally omits `from: 'pending'` so a host calling fail()
    // from any state (even an unusual one) still gets the row written.
    const [filterArg] = repo.findOneAndUpdate.mock.calls[0] as [unknown];
    const filterStr = JSON.stringify(filterArg);
    // The filter should reference the id (evt-1) and the leaseOwner
    // (worker-A), but NOT a `pending` source-state literal.
    expect(filterStr).toContain("evt-1");
    expect(filterStr).toContain("worker-A");
    // The `from: pending` source-state predicate that `claim` would
    // have introduced must NOT be present.
    // Note: the legitimate `targetStatus = 'pending'` value DOES appear
    // in the update spec (set: { status: 'pending', ... }) — but only
    // in the update, not in the filter. We're checking the filter only.
    expect(filterStr).not.toContain('"value":"pending"');
  });
});

describe("repositoryAsOutboxStore — works against repos without claim", () => {
  // Counterpart to the test above: the contract floor is unchanged.
  // Repos that don't ship `claim` (e.g. arc 2.10.x kits, custom HTTP
  // proxies, Map-backed mocks) must continue to work.
  it("constructor accepts a repo without claim", () => {
    const repo = {
      create: async () => ({}),
      getOne: async () => null,
      getAll: async () => ({ data: [], total: 0, page: 1, limit: 0, pages: 0 }),
      deleteMany: async () => ({ deletedCount: 0 }),
      findOneAndUpdate: async () => null,
      // intentionally no `claim`
    } as unknown as RepositoryLike;

    expect(() => repositoryAsOutboxStore(repo)).not.toThrow();
  });

  it("claimPending / acknowledge / fail all work on a repo without claim", async () => {
    const baseEvent = { type: "x", payload: {}, meta: { id: "evt-A", timestamp: new Date() } };
    const ownedRow = makeRow({ _id: "evt-A", leaseOwner: "worker-A", event: baseEvent });
    let fouCalls = 0;

    const repo = {
      create: async () => ({}),
      // `getOne` is used by `fail()`'s pre-write `safeGetOne` to read the
      // current row + by acknowledge's null-fallback recheck. Always return
      // the worker-A-owned row.
      getOne: async () => ownedRow,
      getAll: async () => ({ data: [], total: 0, page: 1, limit: 0, pages: 0 }),
      deleteMany: async () => ({ deletedCount: 0 }),
      // Returning a non-null OutboxRow shape from every `findOneAndUpdate`
      // satisfies acknowledge/fail's success path (no post-write recheck).
      findOneAndUpdate: async () => {
        fouCalls += 1;
        return ownedRow;
      },
      // intentionally no `claim`
    } as unknown as RepositoryLike;

    const store = repositoryAsOutboxStore(repo);

    const claimed = await store.claimPending({ consumerId: "worker-A", limit: 1 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.meta.id).toBe("evt-A");

    await expect(store.acknowledge("evt-A", { consumerId: "worker-A" })).resolves.toBeUndefined();

    await expect(
      store.fail("evt-A", { message: "transient" }, { consumerId: "worker-A" }),
    ).resolves.toBeUndefined();

    // claimPending loops until findOneAndUpdate returns null — but our
    // stub always returns ownedRow, so the loop hits the limit (1) and
    // breaks. Then acknowledge=1, fail=1 → 3 total findOneAndUpdate calls.
    expect(fouCalls).toBe(3);
  });
});
