/**
 * `down()` refuses to roll back on stale lock ownership.
 *
 * `up()` and `downTo()` have always probed `leaseLost()` inside their loops.
 * `down()` never did — it runs a single step, so it looked like it had no
 * window. It has one: `getApplied()` is a round trip, and the lease can lapse
 * (or, since fencing, change epoch) across it. The `applied` list it just read
 * may already belong to another runner by the time the rollback starts.
 *
 * Of the three paths this is the one that DESTROYS data, which makes it the
 * last that should proceed on stale ownership — the inconsistency ran the
 * wrong way round.
 *
 * The lease is driven directly here rather than through a real clock: the
 * subject is "what does the runner do when ownership is lost", not how long a
 * lock backend takes to notice.
 */

import { describe, expect, it, vi } from "vitest";
import type { Migration, MigrationRecord, MigrationStore } from "../../src/migrations/index.js";
import { MigrationRunner } from "../../src/migrations/index.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** One applied migration, ready to roll back. */
function storeWith(records: MigrationRecord[], gate?: Promise<void>): MigrationStore {
  return {
    // Awaiting the gate here models the real round trip `getApplied()` is —
    // the window in which a lease can lapse before the rollback starts.
    getApplied: vi.fn(async () => {
      if (gate) await gate;
      return records;
    }),
    record: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  } as unknown as MigrationStore;
}

/**
 * A lock that grants the lease, then reports it LOST on the first renewal —
 * the shape of a lease that lapsed while the runner was reading state.
 *
 * `lost` resolves when that renewal actually lands, so the test can open a
 * REAL window instead of sleeping and hoping the timer fired. Waiting on the
 * event rather than on a duration is the difference between a deterministic
 * test and one that fails on a loaded pool.
 */
function lockThatLosesTheLease() {
  let acquired = false;
  let signal!: () => void;
  const lost = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return {
    lost,
    lock: {
      tryAcquire: vi.fn(async () => {
        if (!acquired) {
          acquired = true;
          return true; // initial acquire wins
        }
        signal(); // a renewal happened, and it fails
        return false;
      }),
      release: vi.fn(async () => true),
    } as never,
  };
}

/** Grants and keeps the lease — the control. */
function healthyLock() {
  return {
    tryAcquire: vi.fn(async () => true),
    release: vi.fn(async () => true),
  } as never;
}

function aMigration(down: () => Promise<void>): Migration {
  return {
    version: 1,
    resource: "users",
    up: async () => {},
    down,
  } as Migration;
}

const APPLIED: MigrationRecord[] = [
  { version: 1, resource: "users", appliedAt: new Date(), executionTime: 0 },
];

describe("down() under lease loss", () => {
  it("refuses to roll back once ownership is lost", async () => {
    const rolledBack = vi.fn(async () => {});
    const { lock, lost } = lockThatLosesTheLease();
    const runner = new MigrationRunner({}, {
      // getApplied() does not return until the lease has actually been lost,
      // so the guard is reached in a state that genuinely occurred.
      store: storeWith(APPLIED, lost),
      logger: silentLogger,
      lock,
      lockLeaseMs: 40,
    } as never);

    await expect(runner.down([aMigration(rolledBack)])).rejects.toThrow(/ownership lost/i);

    // The assertion that matters: the destructive step never ran.
    expect(rolledBack).not.toHaveBeenCalled();
  });

  it("rolls back normally while ownership holds", async () => {
    // The inverse control — a guard that refused unconditionally would satisfy
    // the test above while breaking every rollback.
    const rolledBack = vi.fn(async () => {});
    const runner = new MigrationRunner({}, {
      store: storeWith(APPLIED),
      logger: silentLogger,
      lock: healthyLock(),
    } as never);

    await runner.down([aMigration(rolledBack)]);

    expect(rolledBack).toHaveBeenCalledTimes(1);
  });

  it("without a lock at all, down() is unaffected", async () => {
    // No lock configured means single-runner deployment; `leaseLost` is
    // constant false and the guard must be invisible.
    const rolledBack = vi.fn(async () => {});
    const runner = new MigrationRunner({}, {
      store: storeWith(APPLIED),
      logger: silentLogger,
    } as never);

    await runner.down([aMigration(rolledBack)]);

    expect(rolledBack).toHaveBeenCalledTimes(1);
  });
});
