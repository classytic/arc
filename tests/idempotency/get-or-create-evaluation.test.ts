/**
 * Regression: lock in the decision NOT to adopt `StandardRepo.getOrCreate()`
 * inside the `repository-idempotency-adapter.ts` `tryLock` path.
 *
 * Context: repo-core 0.3.x corrected `getOrCreate` to return
 *   `Promise<{ doc: TDoc; created: boolean }>`
 * so callers can disambiguate "we just inserted" from "doc already existed".
 * Both mongokit (3.13+) and sqlitekit (0.3+) ship the corrected shape.
 *
 * `tryLock`'s contract is *not* a clean fit. It must atomically:
 *   (a) ACQUIRE the lock when no doc exists for `key` (first-time path), AND
 *   (b) TAKE OVER an expired lease when a doc exists but its
 *       `lock.expiresAt` is in the past (stale-lock recovery).
 *
 * `getOrCreate(filter, data)` is "if filter matches, return existing doc
 * UNCHANGED; else insert `data`". For path (b), the existing stale doc
 * matches `filter` — `getOrCreate` would return `{ created: false }` and
 * never replace the expired lease. Adopting it would silently break the
 * stale-lock takeover invariant the plugin's "crashed handler eventually
 * unblocks" guarantee depends on.
 *
 * This test documents BOTH outcomes against a minimal in-memory repo:
 *   1. The current `findOneAndUpdate`-based `tryLock` correctly takes over
 *      an expired lease (via the `or(exists("lock", false),
 *      lt("lock.expiresAt", now))` filter branch).
 *   2. A simulated `getOrCreate`-based `tryLock` would FAIL to take over
 *      the stale lease — proving the swap is a semantic regression.
 *
 * If a future contributor proposes "let's modernize tryLock onto the new
 * `getOrCreate` primitive", point them at this file. The contract is
 * correct; the use case is wrong.
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { eq as eqFilter } from "@classytic/repo-core/filter";
import { describe, expect, it } from "vitest";
import { repositoryAsIdempotencyStore } from "../../src/idempotency/repository-idempotency-adapter.js";

// ────────────────────────────────────────────────────────────────────────
// Minimal in-memory repository sufficient to back the idempotency adapter.
// Implements `findOneAndUpdate` (the path under audit), `getOne`,
// `deleteMany`, and `idField`. Filters are evaluated by walking the
// `RepoFilter` IR — no Mongo / SQL driver needed.
// ────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown> & { _id: string };

interface RepoFilter {
  op: string;
  field?: string;
  value?: unknown;
  exists?: boolean;
  children?: RepoFilter[];
}

function getPath(doc: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, k) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined,
      doc,
    );
}

function matches(doc: Record<string, unknown> | undefined, filter: unknown): boolean {
  if (!doc) return false;
  const f = filter as RepoFilter;
  switch (f.op) {
    case "true":
      return true;
    case "false":
      return false;
    case "and":
      return (f.children ?? []).every((sub) => matches(doc, sub));
    case "or":
      return (f.children ?? []).some((sub) => matches(doc, sub));
    case "eq":
      return getPath(doc, f.field as string) === f.value;
    case "lt": {
      const v = getPath(doc, f.field as string);
      return v != null && (v as number | Date) < (f.value as number | Date);
    }
    case "exists": {
      const v = getPath(doc, f.field as string);
      const present = v !== undefined;
      return f.exists === false ? !present : present;
    }
    default:
      throw new Error(`Unsupported filter op in test stub: ${f.op}`);
  }
}

function applyUpdate(
  doc: Record<string, unknown>,
  upd: { set?: Record<string, unknown>; unset?: string[]; setOnInsert?: Record<string, unknown> },
  isInsert: boolean,
): Record<string, unknown> {
  const next = { ...doc };
  if (upd.set) for (const [k, v] of Object.entries(upd.set)) next[k] = v;
  if (upd.unset) for (const k of upd.unset) delete next[k];
  if (isInsert && upd.setOnInsert) {
    for (const [k, v] of Object.entries(upd.setOnInsert)) next[k] = v;
  }
  return next;
}

function unwrapUpdate(input: unknown): {
  set?: Record<string, unknown>;
  unset?: string[];
  setOnInsert?: Record<string, unknown>;
} {
  // Adapter passes `update({ set, unset, setOnInsert })` from
  // `@classytic/repo-core/update`. The compiled IR exposes those fields
  // either at the top level or under a wrapper — try both.
  const u = input as Record<string, unknown>;
  if (u.set || u.unset || u.setOnInsert) {
    return u as {
      set?: Record<string, unknown>;
      unset?: string[];
      setOnInsert?: Record<string, unknown>;
    };
  }
  // repo-core's UpdateSpec may wrap the operations under a different key.
  const inner = (u.spec ?? u.update ?? u.ops) as
    | { set?: Record<string, unknown>; unset?: string[]; setOnInsert?: Record<string, unknown> }
    | undefined;
  return inner ?? {};
}

function makeStubRepo(): {
  repo: RepositoryLike;
  store: Map<string, Row>;
} {
  const store = new Map<string, Row>();

  const repo: RepositoryLike = {
    idField: "_id",
    async getOne(filter) {
      for (const doc of store.values()) {
        if (matches(doc, filter)) return doc as never;
      }
      return null;
    },
    async findOneAndUpdate(filter, data, options) {
      const upd = unwrapUpdate(data);
      let target: Row | undefined;
      for (const doc of store.values()) {
        if (matches(doc, filter)) {
          target = doc;
          break;
        }
      }
      if (target) {
        const next = applyUpdate(target, upd, false) as Row;
        store.set(next._id, next);
        return next as never;
      }
      if (!options?.upsert) return null as never;
      // Upsert path: derive _id from the eq(idField, key) leaf in the filter
      const id = extractEqKey(filter, "_id");
      if (id == null) return null as never;
      // Mimic Mongo: filter didn't match → try to insert. If a row with
      // this _id already exists (filter mismatched on a different
      // predicate, e.g. fresh-lease), the unique-_id index throws a
      // duplicate-key error. The adapter catches it via
      // `isDuplicateKeyError` and returns `false`.
      if (store.has(id)) {
        const err = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        throw err;
      }
      const seed: Row = { _id: id } as Row;
      const next = applyUpdate(seed, upd, true) as Row;
      store.set(next._id, next);
      return next as never;
    },
    async deleteMany(filter) {
      let removed = 0;
      for (const [id, doc] of store) {
        if (matches(doc, filter)) {
          store.delete(id);
          removed++;
        }
      }
      return { deletedCount: removed } as never;
    },
    isDuplicateKeyError(err) {
      return (err as { code?: number } | null)?.code === 11000;
    },
  };

  return { repo, store };
}

function extractEqKey(filter: unknown, field: string): string | null {
  const f = filter as RepoFilter;
  if (f.op === "eq" && f.field === field) return f.value as string;
  if (f.op === "and" || f.op === "or") {
    for (const sub of f.children ?? []) {
      const found = extractEqKey(sub, field);
      if (found) return found;
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe("repositoryAsIdempotencyStore — getOrCreate adoption evaluation", () => {
  it("findOneAndUpdate-based tryLock takes over an expired lease (current behavior)", async () => {
    const { repo, store: backing } = makeStubRepo();
    const store = repositoryAsIdempotencyStore(repo, 60_000);

    // First caller acquires the lock
    const acquired = await store.tryLock("key-stale", "req-1", 10_000);
    expect(acquired).toBe(true);

    // Backdate the lease: simulate "first holder crashed, lease expired"
    const row = backing.get("key-stale");
    expect(row).toBeDefined();
    (row as Record<string, unknown>).lock = {
      requestId: "req-1",
      expiresAt: new Date(Date.now() - 1_000),
    };

    // Second caller MUST be able to take over (lease expired)
    const tookOver = await store.tryLock("key-stale", "req-2", 10_000);
    expect(tookOver).toBe(true);

    // The lock is now owned by req-2
    const after = backing.get("key-stale") as Record<string, unknown>;
    expect((after.lock as { requestId: string }).requestId).toBe("req-2");
  });

  it("blocks a fresh-lease lock acquisition (current behavior)", async () => {
    const { repo } = makeStubRepo();
    const store = repositoryAsIdempotencyStore(repo, 60_000);

    expect(await store.tryLock("key-fresh", "req-1", 30_000)).toBe(true);
    // Fresh lease — second caller cannot acquire (filter doesn't match)
    expect(await store.tryLock("key-fresh", "req-2", 30_000)).toBe(false);
  });

  it("simulating getOrCreate-based tryLock would BREAK stale-lease takeover", async () => {
    // This is the design-decision lock-in. We simulate the swap inline
    // and prove it returns `created: false` (i.e. "we did not win the
    // lock") even though the existing lease has expired and the caller
    // SHOULD be able to take over.
    //
    // If a future contributor wants to adopt `getOrCreate` for `tryLock`,
    // this test will continue to fail-by-construction unless they ALSO
    // change the `IdempotencyStore` contract — which is exactly the
    // semantic regression the design note in
    // `repository-idempotency-adapter.ts` warns against.

    const { repo, store: backing } = makeStubRepo();

    // Seed a doc with an expired lease — equivalent to "first holder
    // crashed, lease expired in the past"
    backing.set("key-stale", {
      _id: "key-stale",
      lock: { requestId: "req-1", expiresAt: new Date(Date.now() - 1_000) },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Simulated getOrCreate semantics: "if a doc matches `filter` (here:
    // _id = key), return it unchanged; else insert `data`."
    // We use a filter-by-id only, mirroring the canonical contract use.
    async function simulatedGetOrCreate(
      key: string,
      data: { lock: { requestId: string; expiresAt: Date }; createdAt: Date; expiresAt: Date },
    ): Promise<{ doc: Row; created: boolean }> {
      const existing = (await repo.getOne?.(eqFilter("_id", key))) as Row | null;
      if (existing) return { doc: existing, created: false };
      const inserted = await repo.findOneAndUpdate?.(eqFilter("_id", key), { set: data } as never, {
        upsert: true,
        returnDocument: "after",
      });
      return { doc: inserted as Row, created: true };
    }

    // The "modernized" tryLock would check `created` to decide if it won.
    const result = await simulatedGetOrCreate("key-stale", {
      lock: { requestId: "req-2", expiresAt: new Date(Date.now() + 30_000) },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    // PROOF of the regression: getOrCreate sees the existing stale doc,
    // returns `created: false`, and the lock owner stays as req-1 — req-2
    // is incorrectly told "you didn't win" even though the lease expired.
    expect(result.created).toBe(false);
    expect((result.doc.lock as { requestId: string }).requestId).toBe("req-1");

    // Contrast: the real tryLock (filter-aware) DOES let req-2 win in the
    // same scenario — proven by the first test in this file.
  });
});
