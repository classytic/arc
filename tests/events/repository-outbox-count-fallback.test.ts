/**
 * `countByStatus` on a repository WITHOUT `count` — the fallback path.
 *
 * WHY this file exists: the adapter's contract run
 * (`repository-outbox-visible-field.test.ts`) is backed by mongokit's `Repository`,
 * which HAS `count`, so it takes the fast path and the fallback never executes.
 * That left the branch shipped-but-unexecuted, and it was wrong: it asked with
 * `limit: 1` and returned `.length`, capping every answer at 1.
 *
 * The cost of getting this wrong is asymmetric. `countByStatus` is what an operator
 * dashboard and a dead-letter alert read; a number that is too LOW reads exactly like a
 * healthy queue, so the failure is silent and self-concealing — the operator stops
 * looking. That is why the unreadable-envelope case throws instead of returning 0.
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { describe, expect, it } from "vitest";
import { repositoryAsOutboxStore } from "../../src/events/repository-outbox-adapter.js";

type Row = { _id: string; status: string; createdAt: Date };

function rows(n: number, status = "pending"): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    _id: `evt-${i}`,
    status,
    createdAt: new Date(),
  }));
}

/** Minimal repo satisfying the adapter's constructor checks; `getAll` is overridden per case. */
function makeRepo(getAll: (opts: { limit?: number }) => Promise<unknown>): RepositoryLike {
  return {
    create: async (d: unknown) => d,
    getAll,
    getOne: async () => null,
    update: async () => null,
    delete: async () => null,
    findOneAndUpdate: async () => null,
    updateMany: async () => ({ modifiedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
  } as unknown as RepositoryLike;
}

describe("countByStatus — repository without `count`", () => {
  it("returns the TRUE row count for a bare-array kit, not the probe page size", async () => {
    // `unwrapDocs`'s own docblock names this shape as real ("some kits may return a
    // bare array when pagination is disabled"), so it is not hypothetical.
    const all = rows(400);
    const store = repositoryAsOutboxStore(
      makeRepo(async (opts) => (opts?.limit ? all.slice(0, opts.limit) : all)),
    );

    expect(await store.countByStatus("pending")).toBe(400);
  });

  it("reads `total` off a paginated envelope without hydrating the rows", async () => {
    let maxLimitAsked = Number.POSITIVE_INFINITY;
    const store = repositoryAsOutboxStore(
      makeRepo(async (opts) => {
        maxLimitAsked = Math.min(maxLimitAsked, opts?.limit ?? Number.POSITIVE_INFINITY);
        return { data: rows(1), total: 400 };
      }),
    );

    expect(await store.countByStatus("delivered")).toBe(400);
    // A `delivered` count spans the whole retention window; pulling it into memory to
    // produce one integer is the thing the envelope path exists to avoid.
    expect(maxLimitAsked).toBe(1);
  });

  it("reads a nested `meta.total` envelope", async () => {
    const store = repositoryAsOutboxStore(
      makeRepo(async () => ({ data: rows(1), meta: { total: 7 } })),
    );

    expect(await store.countByStatus("dead_letter")).toBe(7);
  });

  it("THROWS on an unreadable envelope rather than reporting a healthy zero", async () => {
    // 0 is indistinguishable from an empty queue, so returning it would silence the
    // exact alert this method exists to raise.
    const store = repositoryAsOutboxStore(makeRepo(async () => ({ rows: rows(1) })));

    await expect(store.countByStatus("dead_letter")).rejects.toThrow(/cannot be read/);
  });
});
