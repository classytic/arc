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

    await sleep(120);
    const observed = runs;
    expect(observed).toBeGreaterThanOrEqual(3);

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
            await sleep(110); // outruns leaseMs — needs ≥2 renewals
          },
        },
      ],
    });
    await app.ready();
    await sleep(160);

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
    await sleep(260); // handler + trailing renewal settle

    // setInterval would stack calls every 15ms against a 40ms backend; the
    // serialized loop keeps at most one in flight.
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0); // teardown awaited the in-flight renewal
    await app.close();
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
