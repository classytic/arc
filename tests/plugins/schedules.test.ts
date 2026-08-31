/**
 * schedulesPlugin — recurring in-process jobs (2.21).
 *
 * Pins: tick loop fires + stops on close; errors are fail-open per tick;
 * lock-based leader safety (two "replicas" sharing one LockAdapter → one
 * winner per tick window); no-op mode; fail-fast validation.
 */

import { createMemoryLockAdapter } from "@classytic/repo-core/lock";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import schedulesPlugin from "../../src/plugins/schedules.js";
import { waitFor } from "../../src/testing/mocks.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeApp(opts: Parameters<typeof schedulesPlugin>[1]) {
  const app = Fastify({ logger: false });
  await app.register(schedulesPlugin, opts);
  await app.ready();
  return app;
}

describe("schedulesPlugin", () => {
  it("fires the handler repeatedly and stops after close", async () => {
    let runs = 0;
    const app = await makeApp({
      schedules: [{ name: "tick", every: 25, runOnStart: true, handler: () => void runs++ }],
    });

    // Waits for the CLAIM ("fires repeatedly"), not for a duration — returns as
    // soon as the third tick lands and tolerates a stalled loop instead of
    // encoding a guess about how fast the pool is.
    await waitFor(() => runs >= 3, { label: "3 scheduler ticks" });
    const observed = runs;

    await app.close();
    const atClose = runs;
    await sleep(80);
    expect(runs).toBe(atClose); // timers cleared — no post-close ticks
  });

  it("a throwing handler is fail-open: loop continues, stats record the failure", async () => {
    let calls = 0;
    const app = await makeApp({
      schedules: [
        {
          name: "flaky",
          every: 20,
          runOnStart: true,
          handler: () => {
            calls++;
            if (calls === 1) throw new Error("first tick exploded");
          },
        },
      ],
    });

    await sleep(100);
    await app.close();

    expect(calls).toBeGreaterThanOrEqual(2); // survived the throw
    const stats = app.getScheduleStats?.() ?? [];
    const flaky = stats.find((s) => s.name === "flaky");
    expect(flaky?.failures).toBe(1);
    expect(flaky?.runs).toBeGreaterThanOrEqual(2);
  });

  it("two replicas sharing a lock: exactly one wins each tick window", async () => {
    const lock = createMemoryLockAdapter();
    const runsBy = { a: 0, b: 0 };
    const def = (id: "a" | "b") => ({
      schedules: [
        {
          name: "sweep",
          every: 30,
          runOnStart: true,
          // Lease outlives the test window — the loser must keep losing.
          leaseMs: 10_000,
          handler: () => void runsBy[id]++,
        },
      ],
      lock,
      holderId: `replica-${id}`,
    });

    const [a, b] = await Promise.all([makeApp(def("a")), makeApp(def("b"))]);
    await sleep(150);
    await Promise.all([a.close(), b.close()]);

    const total = runsBy.a + runsBy.b;
    expect(total).toBeGreaterThanOrEqual(1);
    // Exactly one replica held the lease for the whole window.
    expect(Math.min(runsBy.a, runsBy.b)).toBe(0);
    const loser = runsBy.a === 0 ? a : b;
    const loserStats = loser.getScheduleStats?.()?.[0];
    expect(loserStats?.skippedByLock).toBeGreaterThanOrEqual(1);
  });

  it("enabled: false registers a typed no-op", async () => {
    let runs = 0;
    const app = await makeApp({
      enabled: false,
      schedules: [{ name: "never", every: 10, runOnStart: true, handler: () => void runs++ }],
    });
    await sleep(60);
    await app.close();
    expect(runs).toBe(0);
    expect(app.getScheduleStats?.()).toEqual([]);
  });

  it("per-schedule enabled: false skips just that schedule", async () => {
    const runs = { on: 0, off: 0 };
    const app = await makeApp({
      schedules: [
        { name: "on", every: 20, runOnStart: true, handler: () => void runs.on++ },
        {
          name: "off",
          every: 20,
          runOnStart: true,
          enabled: false,
          handler: () => void runs.off++,
        },
      ],
    });
    await sleep(80);
    await app.close();
    expect(runs.on).toBeGreaterThanOrEqual(1);
    expect(runs.off).toBe(0);
  });

  it("jitterMs delays only the first tick (bounded)", async () => {
    let firstRunAt = 0;
    const started = Date.now();
    const app = await makeApp({
      schedules: [
        {
          name: "jittered",
          every: 20,
          jitterMs: 60,
          handler: () => {
            if (!firstRunAt) firstRunAt = Date.now();
          },
        },
      ],
    });
    await sleep(150);
    await app.close();
    expect(firstRunAt).toBeGreaterThan(0);
    // First tick lands in [every, every + jitterMs) + scheduling slop.
    expect(firstRunAt - started).toBeGreaterThanOrEqual(20);
    expect(firstRunAt - started).toBeLessThan(140);
  });

  it("fail-fast: duplicate names and non-positive intervals throw at registration", async () => {
    const app = Fastify({ logger: false });
    await expect(
      app.register(schedulesPlugin, {
        schedules: [
          { name: "dup", every: 1000, handler: () => {} },
          { name: "dup", every: 1000, handler: () => {} },
        ],
      }),
    ).rejects.toThrow(/duplicate schedule name/);

    const app2 = Fastify({ logger: false });
    await expect(
      app2.register(schedulesPlugin, {
        schedules: [{ name: "bad", every: 0, handler: () => {} }],
      }),
    ).rejects.toThrow(/positive number/);
  });
});

// ============================================================================
// Lease renewal — long handlers keep exclusive ownership
// ============================================================================

describe("schedules — lease renewal", () => {
  // A tick acquires its lease once; without renewal a handler outrunning
  // the lease lets another replica overlap it. The renewal loop (shared
  // `startRenewingLease` primitive) is serialized and torn down awaited.
  it("renews the lease while a handler outruns leaseMs/2", async () => {
    const acquires: Array<{ name: string; holderId: string; leaseMs: number }> = [];
    const lock = {
      tryAcquire: (name: string, holderId: string, leaseMs: number) => {
        acquires.push({ name, holderId, leaseMs });
        return true;
      },
      release: () => true,
    };

    const app = Fastify({ logger: false });
    await app.register(schedulesPlugin, {
      lock,
      holderId: "replica-1",
      schedules: [
        {
          name: "long-sweep",
          every: 5000,
          leaseMs: 60, // renew interval = 30ms
          runOnStart: true,
          handler: async () => {
            // Long enough to span several renew intervals; the assertion below
            // waits for the renewals rather than for this duration.
            await sleep(240);
          },
        },
      ],
    });
    await app.ready();
    await waitFor(() => acquires.filter((a) => a.name === "arc:schedule:long-sweep").length >= 3, {
      label: "initial acquire + 2 lease renewals",
    });

    const forSchedule = acquires.filter((a) => a.name === "arc:schedule:long-sweep");
    // 1 initial acquire + at least 2 renewals, all same holder + lease.
    expect(forSchedule.length).toBeGreaterThanOrEqual(3);
    for (const a of forSchedule) {
      expect(a.holderId).toBe("replica-1");
      expect(a.leaseMs).toBe(60);
    }
    await app.close();
  });

  it("stops renewing once the handler settles", async () => {
    const acquires: string[] = [];
    const lock = {
      tryAcquire: (name: string) => {
        acquires.push(name);
        return true;
      },
      release: () => true,
    };

    const app = Fastify({ logger: false });
    await app.register(schedulesPlugin, {
      lock,
      schedules: [
        {
          name: "quick",
          every: 5000,
          leaseMs: 40,
          runOnStart: true,
          handler: async () => {
            /* returns immediately — renewal loop must be cleared */
          },
        },
      ],
    });
    await app.ready();
    await sleep(30);
    const afterRun = acquires.length;
    await sleep(100); // several renewal intervals worth of time
    expect(acquires.length).toBe(afterRun); // no renewals after settle
    await app.close();
  });

  it("renewals are SERIALIZED — a slow lock backend never sees overlapping tryAcquire calls", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const lock = {
      tryAcquire: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(40); // slower than the renewal cadence (leaseMs/2 = 15ms)
        inFlight--;
        return true;
      },
      release: () => true,
    };

    const app = Fastify({ logger: false });
    await app.register(schedulesPlugin, {
      lock,
      schedules: [
        {
          name: "slow-lock",
          every: 5000,
          leaseMs: 30,
          runOnStart: true,
          handler: async () => {
            await sleep(150);
          },
        },
      ],
    });
    await app.ready();
    // Wait for the renewal loop to have actually run, not for a duration.
    await waitFor(() => maxInFlight >= 1, { label: "at least one lock acquire" });

    // setInterval would stack calls every 15ms against a 40ms backend; the
    // serialized loop keeps at most one in flight.
    expect(maxInFlight).toBe(1);

    // Assert the drain AFTER close. Checking `inFlight` before it only asked
    // whether the trailing renewal happened to finish inside the sleep window —
    // a race that fails under load. Closing first tests the actual guarantee:
    // teardown awaits the renewal that is in flight.
    await app.close();
    expect(inFlight).toBe(0);
  });

  it("fast handlers under lock behave as before (single acquire per tick)", async () => {
    let count = 0;
    const lock = {
      tryAcquire: () => {
        count++;
        return true;
      },
      release: () => true,
    };

    const app = Fastify({ logger: false });
    await app.register(schedulesPlugin, {
      lock,
      schedules: [{ name: "fast", every: 5000, runOnStart: true, handler: async () => {} }],
    });
    await app.ready();
    await sleep(30);
    expect(count).toBe(1);
    await app.close();
  });
});

/**
 * A tick has no cancellation contract, so `onClose` can only BOUND its wait.
 *
 * The unbounded form held shutdown for as long as the slowest in-flight run —
 * measured at 133s in a host whose outbox relay was publishing to a subscriber
 * on a retry ladder. Past the orchestrator's grace period the wait buys nothing:
 * SIGKILL truncates the same write, minus the log line naming the job.
 */
describe("schedulesPlugin — shutdown drain budget", () => {
  it("abandons an in-flight run once the budget expires instead of waiting it out", async () => {
    let released = false;
    const app = await makeApp({
      drainTimeoutMs: 100,
      schedules: [
        {
          name: "slow-sweep",
          every: 10_000,
          runOnStart: true,
          handler: async () => {
            await sleep(3000);
            released = true;
          },
        },
      ],
    });

    // The run must actually be in flight, or this asserts nothing.
    await waitFor(() => (app.getScheduleStats?.() ?? [])[0]?.runs === 1, { label: "tick started" });

    await app.close();

    // `released` is the whole claim and needs no clock: had close awaited the
    // 3s handler, this would be true by the time it returned. An elapsed-time
    // assertion would add no proof and measure the runner instead — the flake
    // shape that put this file in TIMING_SENSITIVE.
    expect(released).toBe(false);
  });

  it("still waits for a run that finishes INSIDE the budget", async () => {
    let finished = false;
    const app = await makeApp({
      drainTimeoutMs: 3000,
      schedules: [
        {
          name: "quick-sweep",
          every: 10_000,
          runOnStart: true,
          handler: async () => {
            await sleep(150);
            finished = true;
          },
        },
      ],
    });

    await waitFor(() => (app.getScheduleStats?.() ?? [])[0]?.runs === 1, { label: "tick started" });
    await app.close();

    // The whole point of the await: a sweep that CAN settle is not truncated.
    expect(finished).toBe(true);
  });

  it("NAMES the abandoned schedules in the warning", async () => {
    // Abandoning quietly would be the bug. This log line is the operator's only
    // signal that work was dropped, so it must fire AND identify which jobs —
    // "drain exceeded" with no names sends them reading every handler.
    const warnings: Array<{ meta: unknown; msg: string }> = [];
    const app = Fastify({ logger: false });
    app.log.warn = ((meta: unknown, msg?: string) => {
      warnings.push({ meta, msg: String(msg ?? meta) });
    }) as never;

    await app.register(schedulesPlugin, {
      drainTimeoutMs: 100,
      schedules: [
        {
          name: "slow-sweep",
          every: 10_000,
          runOnStart: true,
          handler: async () => sleep(3000),
        },
      ],
    });
    await app.ready();
    await waitFor(() => (app.getScheduleStats?.() ?? [])[0]?.runs === 1, { label: "tick started" });
    await app.close();

    const drain = warnings.find((w) => w.msg.includes("drain budget exceeded"));
    expect(drain).toBeDefined();
    expect(drain?.meta).toMatchObject({ schedules: ["slow-sweep"], drainTimeoutMs: 100 });
  });

  it("does NOT warn when every run settles in time", async () => {
    // The inverse control — a warn that always fired would satisfy the test
    // above while crying wolf on every clean shutdown.
    const warnings: string[] = [];
    const app = Fastify({ logger: false });
    app.log.warn = ((meta: unknown, msg?: string) => {
      warnings.push(String(msg ?? meta));
    }) as never;

    await app.register(schedulesPlugin, {
      drainTimeoutMs: 3000,
      schedules: [
        { name: "quick-sweep", every: 10_000, runOnStart: true, handler: async () => sleep(50) },
      ],
    });
    await app.ready();
    await waitFor(() => (app.getScheduleStats?.() ?? [])[0]?.runs === 1, { label: "tick started" });
    await app.close();

    expect(warnings.some((w) => w.includes("drain budget exceeded"))).toBe(false);
  });
});
