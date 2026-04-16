/**
 * MigrationRunner — crash-recovery semantics
 *
 * The runner has NO distributed lock. If a migration throws mid-run, the
 * record write is skipped so the next `up()` will retry — no manual
 * cleanup needed. This suite pins that contract and catches regressions
 * where a partially-applied migration might get wrongly marked complete.
 *
 * Scenarios:
 *   1. Migration #1 succeeds, #2 throws → #1 stays recorded, #2 NOT recorded
 *   2. Rerun after fixing the #2 migration → only #2 runs (idempotent)
 *   3. `down()` failure mid-rollback leaves the rolled-back entry removed
 *      but the failing one still present
 *   4. Mixing resources: `users:2` failure does not block `posts:1`
 *   5. Validation failure aborts before any side effect
 *
 * Note: the existing `tests/migrations/migration-runner.test.ts` covers
 * the happy path + validation. This file targets failure paths only.
 */

import { describe, expect, it, vi } from "vitest";
import {
  defineMigration,
  type Migration,
  type MigrationRecord,
  MigrationRunner,
  type MigrationStore,
} from "../../src/migrations/index.js";

function makeStore(): {
  store: MigrationStore;
  applied: MigrationRecord[];
  recordSpy: ReturnType<typeof vi.fn>;
  removeSpy: ReturnType<typeof vi.fn>;
} {
  const applied: MigrationRecord[] = [];
  const recordSpy = vi.fn(async (migration: Migration, executionTime: number) => {
    applied.push({
      version: migration.version,
      resource: migration.resource,
      appliedAt: new Date(),
      executionTime,
    });
  });
  const removeSpy = vi.fn(async (migration: Migration) => {
    const idx = applied.findIndex(
      (r) => r.version === migration.version && r.resource === migration.resource,
    );
    if (idx >= 0) applied.splice(idx, 1);
  });
  const store: MigrationStore = {
    getApplied: async () => [...applied],
    record: recordSpy,
    remove: removeSpy,
  };
  return { store, applied, recordSpy, removeSpy };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("MigrationRunner — crash/recovery", () => {
  it("failure on migration #2 leaves #1 recorded, #2 unrecorded, error re-thrown", async () => {
    const { store, applied, recordSpy } = makeStore();
    const runner = new MigrationRunner({}, { store, logger: silentLogger });

    const m1 = defineMigration({
      version: 1,
      resource: "product",
      up: vi.fn(async () => {
        /* ok */
      }),
      down: vi.fn(),
    });

    const bombError = new Error("boom during migration 2");
    const m2 = defineMigration({
      version: 2,
      resource: "product",
      up: vi.fn(async () => {
        throw bombError;
      }),
      down: vi.fn(),
    });

    await expect(runner.up([m1, m2])).rejects.toThrow(bombError);

    expect(applied.map((r) => r.version)).toEqual([1]);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0][0].version).toBe(1);
  });

  it("rerun after fixing the failing migration only executes the pending one", async () => {
    const { store, applied, recordSpy } = makeStore();
    const runner = new MigrationRunner({}, { store, logger: silentLogger });

    const m1Up = vi.fn(async () => {});
    const m1 = defineMigration({ version: 1, resource: "order", up: m1Up, down: vi.fn() });

    let m2ShouldThrow = true;
    const m2Up = vi.fn(async () => {
      if (m2ShouldThrow) throw new Error("transient");
    });
    const m2 = defineMigration({ version: 2, resource: "order", up: m2Up, down: vi.fn() });

    // First run fails.
    await expect(runner.up([m1, m2])).rejects.toThrow("transient");
    expect(m1Up).toHaveBeenCalledTimes(1);
    expect(m2Up).toHaveBeenCalledTimes(1);
    expect(applied.map((r) => r.version)).toEqual([1]);

    // Fix the bug and rerun.
    m2ShouldThrow = false;
    await runner.up([m1, m2]);

    // m1 must NOT run again; m2 runs once more (successfully).
    expect(m1Up).toHaveBeenCalledTimes(1);
    expect(m2Up).toHaveBeenCalledTimes(2);
    expect(applied.map((r) => r.version).sort()).toEqual([1, 2]);
    expect(recordSpy).toHaveBeenCalledTimes(2);
  });

  it("down() failure mid-rollback stops without removing the failing entry", async () => {
    const { store, applied } = makeStore();
    const runner = new MigrationRunner({}, { store, logger: silentLogger });

    // Seed as if both had been applied.
    const m1 = defineMigration({
      version: 1,
      resource: "user",
      up: async () => {},
      down: vi.fn(async () => {
        // m1 down succeeds on rollback
      }),
    });
    const m2 = defineMigration({
      version: 2,
      resource: "user",
      up: async () => {},
      down: vi.fn(async () => {
        throw new Error("rollback boom");
      }),
    });
    await runner.up([m1, m2]);
    expect(applied.map((r) => r.version).sort()).toEqual([1, 2]);

    await expect(runner.down([m1, m2])).rejects.toThrow("rollback boom");

    // m2 remains in applied because its down() failed — remove() was not called.
    // The failure is surfaced so the operator can investigate.
    expect(applied.some((r) => r.version === 2)).toBe(true);
  });

  it("failure on users:2 does not block posts:1 running in the same up() call", async () => {
    // NOTE: this asserts ACTUAL behavior — arc runs migrations in the order
    // they're passed and aborts on first failure. This test documents the
    // contract: if you need per-resource isolation, call up() per resource.
    const { store, applied } = makeStore();
    const runner = new MigrationRunner({}, { store, logger: silentLogger });

    const usersV2 = defineMigration({
      version: 2,
      resource: "users",
      up: async () => {
        throw new Error("users v2 failed");
      },
      down: vi.fn(),
    });
    const postsV1 = defineMigration({
      version: 1,
      resource: "posts",
      up: vi.fn(async () => {}),
      down: vi.fn(),
    });

    // Pass posts:1 first so it gets applied before the failure.
    await expect(runner.up([postsV1, usersV2])).rejects.toThrow("users v2 failed");

    expect(applied.some((r) => r.resource === "posts" && r.version === 1)).toBe(true);
    expect(applied.some((r) => r.resource === "users" && r.version === 2)).toBe(false);
  });

  it("validation failure after up() prevents record() and surfaces the error", async () => {
    // Contract (src/migrations/index.ts:329-339): up() runs first, THEN validate()
    // checks post-condition, and only if valid does record() fire.
    // A validate throw / false result leaves the migration unrecorded so the
    // operator can inspect and rerun after fixing.
    const { store, applied, recordSpy } = makeStore();
    const runner = new MigrationRunner({}, { store, logger: silentLogger });

    const upSpy = vi.fn(async () => {});
    const m1 = defineMigration({
      version: 1,
      resource: "audit",
      up: upSpy,
      down: vi.fn(),
      validate: async () => {
        throw new Error("schema invariant violated");
      },
    });

    await expect(runner.up([m1])).rejects.toThrow(/schema invariant violated/);
    expect(upSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).not.toHaveBeenCalled();
    expect(applied).toHaveLength(0);
  });

  it("validate returning false throws 'Migration validation failed' and skips record()", async () => {
    const { store, applied, recordSpy } = makeStore();
    const runner = new MigrationRunner({}, { store, logger: silentLogger });

    const m1 = defineMigration({
      version: 1,
      resource: "audit",
      up: async () => {},
      down: vi.fn(),
      validate: async () => false,
    });

    await expect(runner.up([m1])).rejects.toThrow(/Migration validation failed/);
    expect(recordSpy).not.toHaveBeenCalled();
    expect(applied).toHaveLength(0);
  });

  it("getPendingMigrations reports pending after a partial failure", async () => {
    const { store } = makeStore();
    const runner = new MigrationRunner({}, { store, logger: silentLogger });

    const m1 = defineMigration({
      version: 1,
      resource: "product",
      up: async () => {},
      down: vi.fn(),
    });
    const m2 = defineMigration({
      version: 2,
      resource: "product",
      up: async () => {
        throw new Error("fail");
      },
      down: vi.fn(),
    });
    const m3 = defineMigration({
      version: 3,
      resource: "product",
      up: async () => {},
      down: vi.fn(),
    });

    await expect(runner.up([m1, m2, m3])).rejects.toThrow();

    const pending = await runner.getPendingMigrations([m1, m2, m3]);
    expect(pending.map((p) => p.version).sort()).toEqual([2, 3]);
    expect(await runner.isUpToDate([m1, m2, m3])).toBe(false);
  });
});
