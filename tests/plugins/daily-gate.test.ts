/**
 * Daily gate: once per LOCAL civil day at/after hh:mm in an IANA zone, claimed in a host ledger.
 * Pure gate first (zones, DST, restart, double-run, window, stale claims), then the
 * `ScheduleDefinition.daily` wiring through schedulesPlugin.
 */

import { createMemoryLockAdapter } from "@classytic/repo-core/lock";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  createDailyGate,
  createMemoryDailyLedger,
  type DailyGateOptions,
} from "../../src/plugins/dailyGate.js";
import schedulesPlugin from "../../src/plugins/schedules.js";
import { waitFor } from "../../src/testing/mocks.js";

function gateAt(
  iso: string,
  opts: Partial<DailyGateOptions> & { ledger?: DailyGateOptions["ledger"] },
) {
  const ledger = opts.ledger ?? createMemoryDailyLedger();
  const clock = { at: new Date(iso) };
  const gate = createDailyGate({
    key: "sweep",
    zone: "UTC",
    hour: 2,
    ...opts,
    ledger,
    clock: () => clock.at,
  });
  return {
    gate,
    ledger,
    clock,
    set: (next: string) => {
      clock.at = new Date(next);
    },
  };
}

const run = (g: ReturnType<typeof gateAt>["gate"]) => g.run(async (day) => ({ day }));

describe("daily gate: zones", () => {
  it("fires at hh:mm LOCAL time, and names the LOCAL civil date", async () => {
    // Asia/Dhaka is UTC+6, no DST: 02:00 local == 20:00Z the previous UTC day.
    const t = gateAt("2026-10-22T19:59:00Z", { zone: "Asia/Dhaka" });
    expect(await run(t.gate)).toEqual({ ran: false, reason: "too-early" });
    t.set("2026-10-22T20:00:00Z");
    expect(await run(t.gate)).toMatchObject({ ran: true, day: "2026-10-23" });
  });

  it("the same instant is a different day in a different zone", async () => {
    const instant = "2026-10-23T20:30:00Z"; // Dhaka 2026-10-24 02:30, New York 2026-10-23 16:30
    const dhaka = gateAt(instant, { zone: "Asia/Dhaka" });
    const ny = gateAt(instant, { zone: "America/New_York" });
    expect(await run(dhaka.gate)).toMatchObject({ ran: true, day: "2026-10-24" });
    expect(await run(ny.gate)).toMatchObject({ ran: true, day: "2026-10-23" });
  });

  it("honours minute, including a half-hour zone (Asia/Kolkata, UTC+5:30)", async () => {
    const t = gateAt("2026-10-22T21:29:00Z", { zone: "Asia/Kolkata", hour: 3, minute: 0 });
    expect(await run(t.gate)).toMatchObject({ reason: "too-early" }); // 02:59 local
    t.set("2026-10-22T21:30:00Z");
    expect(await run(t.gate)).toMatchObject({ ran: true, day: "2026-10-23" });
  });

  it("runs again the next local day, not before", async () => {
    const t = gateAt("2026-10-23T02:00:00Z", {});
    expect(await run(t.gate)).toMatchObject({ ran: true, day: "2026-10-23" });
    t.set("2026-10-23T23:59:00Z");
    expect(await run(t.gate)).toEqual({ ran: false, reason: "already-claimed" });
    t.set("2026-10-24T02:00:00Z");
    expect(await run(t.gate)).toMatchObject({ ran: true, day: "2026-10-24" });
  });
});

describe("daily gate: DST", () => {
  it("spring forward: a wall time that does not exist (02:30) fires once, when the clock reaches it", async () => {
    // America/New_York 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00Z).
    const t = gateAt("2026-03-08T06:59:00Z", { zone: "America/New_York", hour: 2, minute: 30 });
    expect(await run(t.gate)).toMatchObject({ reason: "too-early" }); // 01:59 EST
    t.set("2026-03-08T07:00:00Z"); // 03:00 EDT
    expect(await run(t.gate)).toMatchObject({ ran: true, day: "2026-03-08" });
    t.set("2026-03-08T09:00:00Z");
    expect(await run(t.gate)).toMatchObject({ reason: "already-claimed" });
  });

  it("fall back: a repeated wall time (01:30 twice) fires once, on the first occurrence", async () => {
    // America/New_York 2026-11-01: 01:30 EDT (05:30Z) then 01:30 EST (06:30Z).
    const t = gateAt("2026-11-01T05:29:00Z", { zone: "America/New_York", hour: 1, minute: 30 });
    expect(await run(t.gate)).toMatchObject({ reason: "too-early" });
    t.set("2026-11-01T05:30:00Z");
    expect(await run(t.gate)).toMatchObject({ ran: true, day: "2026-11-01" });
    t.set("2026-11-01T06:30:00Z");
    expect(await run(t.gate)).toMatchObject({ reason: "already-claimed" });
  });

  it("a 02:00 job is on time (not an hour off) the day after the transition", async () => {
    const t = gateAt("2026-03-09T05:59:00Z", { zone: "America/New_York" }); // 01:59 EDT
    expect(await run(t.gate)).toMatchObject({ reason: "too-early" });
    t.set("2026-03-09T06:00:00Z"); // 02:00 EDT
    expect(await run(t.gate)).toMatchObject({ ran: true, day: "2026-03-09" });
  });

  it("the day length does not matter: 25h and 23h days each run once", async () => {
    const ledger = createMemoryDailyLedger();
    const t = gateAt("2026-11-01T06:00:00Z", { zone: "America/New_York", ledger, hour: 0 });
    expect(await run(t.gate)).toMatchObject({ ran: true, day: "2026-11-01" });
    t.set("2026-11-02T05:00:00Z"); // 00:00 EST Nov 2
    expect(await run(t.gate)).toMatchObject({ ran: true, day: "2026-11-02" });
    expect(ledger.claims().map((c) => c.civilDate)).toEqual(["2026-11-01", "2026-11-02"]);
  });
});

describe("daily gate: idempotency", () => {
  it("restart: a NEW gate over the same ledger does not rerun the day", async () => {
    const ledger = createMemoryDailyLedger();
    let runs = 0;
    const task = async () => void runs++;
    const first = gateAt("2026-10-23T03:00:00Z", { ledger });
    await first.gate.run(task);
    const afterRestart = gateAt("2026-10-23T03:05:00Z", { ledger });
    expect(await afterRestart.gate.run(task)).toEqual({ ran: false, reason: "already-claimed" });
    expect(runs).toBe(1);
  });

  it("double-run: concurrent callers (two replicas) execute the task once", async () => {
    const ledger = createMemoryDailyLedger();
    let runs = 0;
    const task = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 5));
    };
    const a = gateAt("2026-10-23T03:00:00Z", { ledger });
    const b = gateAt("2026-10-23T03:00:00Z", { ledger });
    const outcomes = await Promise.all([a.gate.run(task), b.gate.run(task), a.gate.run(task)]);
    expect(runs).toBe(1);
    expect(outcomes.filter((o) => o.ran)).toHaveLength(1);
  });

  it("a failing task releases the claim, rethrows, and the next poll retries", async () => {
    const ledger = createMemoryDailyLedger();
    const t = gateAt("2026-10-23T03:00:00Z", { ledger });
    await expect(
      t.gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(ledger.claims()).toEqual([]);
    expect(await t.gate.run(async () => "ok")).toMatchObject({ ran: true, result: "ok" });
  });

  it("completeDay stores an object result on the ledger row", async () => {
    const ledger = createMemoryDailyLedger();
    const t = gateAt("2026-10-23T03:00:00Z", { ledger });
    await t.gate.run(async () => ({ sent: 4 }));
    expect(ledger.claims()[0]).toMatchObject({ completed: true, result: { sent: 4 } });
  });

  it("a crash mid-run leaves the claim; staleAfterMs lets a later poll take it over", async () => {
    const ledger = createMemoryDailyLedger();
    // "Crash": claim without complete or release.
    await ledger.claimDay("sweep", "2026-10-23", { now: new Date("2026-10-23T03:00:00Z") });

    const never = gateAt("2026-10-23T09:00:00Z", { ledger });
    expect(await run(never.gate)).toMatchObject({ reason: "already-claimed" });

    const recovering = gateAt("2026-10-23T09:00:00Z", { ledger, staleAfterMs: 60 * 60_000 });
    expect(await run(recovering.gate)).toMatchObject({ ran: true, day: "2026-10-23" });
    // A completed claim is never stale.
    recovering.set("2026-10-23T23:00:00Z");
    expect(await run(recovering.gate)).toMatchObject({ reason: "already-claimed" });
  });
});

describe("daily gate: catch-up window", () => {
  it("default: a late process still runs the day's job until the local day ends", async () => {
    const t = gateAt("2026-10-23T23:30:00Z", {});
    expect(await run(t.gate)).toMatchObject({ ran: true, day: "2026-10-23" });
  });

  it("catchUpWindowMs skips a run that is too late, and still runs inside the window", async () => {
    const late = gateAt("2026-10-23T03:00:01Z", { catchUpWindowMs: 60 * 60_000 });
    expect(await run(late.gate)).toEqual({ ran: false, reason: "outside-window" });
    const ok = gateAt("2026-10-23T03:00:00Z", { catchUpWindowMs: 60 * 60_000 });
    expect(await run(ok.gate)).toMatchObject({ ran: true });
    // A skipped day is not claimed, so it cannot block anything.
    expect(late.ledger.claims()).toEqual([]);
  });
});

describe("daily gate: config", () => {
  it("rejects a bad hour, minute or zone at construction", () => {
    const base = { key: "k", ledger: createMemoryDailyLedger(), zone: "UTC", hour: 2 };
    expect(() => createDailyGate({ ...base, hour: 24 })).toThrow(/hour/);
    expect(() => createDailyGate({ ...base, minute: 60 })).toThrow(/minute/);
    expect(() => createDailyGate({ ...base, zone: "Mars/Olympus" })).toThrow(/IANA/);
  });

  it("accepts a { now() } clock object", async () => {
    const gate = createDailyGate({
      key: "k",
      ledger: createMemoryDailyLedger(),
      zone: "UTC",
      hour: 0,
      clock: { now: () => new Date("2026-10-23T00:00:00Z") },
    });
    expect(await gate.run(async () => 1)).toMatchObject({ ran: true });
  });
});

describe("schedulesPlugin: ScheduleDefinition.daily", () => {
  const clock = () => new Date("2026-10-23T03:00:00Z");

  async function replica(
    ledger: ReturnType<typeof createMemoryDailyLedger>,
    lock: ReturnType<typeof createMemoryLockAdapter>,
    calls: Array<string | undefined>,
    holderId: string,
    extra: Record<string, unknown> = {},
  ) {
    const app = Fastify({ logger: false });
    await app.register(schedulesPlugin, {
      lock,
      holderId,
      schedules: [
        {
          name: "nightly",
          every: 20,
          runOnStart: true,
          daily: { hour: 2, zone: "UTC", ledger, clock, ...extra },
          handler: (_f, ctx) => void calls.push(ctx?.day),
        },
      ],
    });
    await app.ready();
    return app;
  }

  it("runs once for the day across two replicas and many polls; stats tell the story", async () => {
    const ledger = createMemoryDailyLedger();
    const lock = createMemoryLockAdapter();
    const calls: Array<string | undefined> = [];
    const a = await replica(ledger, lock, calls, "a");
    const b = await replica(ledger, lock, calls, "b");
    await waitFor(
      () =>
        (a.getScheduleStats?.()[0]?.skippedByGate ?? 0) +
          (b.getScheduleStats?.()[0]?.skippedByGate ?? 0) >=
        2,
      { label: "polls declined by the gate" },
    );
    expect(calls).toEqual(["2026-10-23"]);
    const stats = [a, b].flatMap((app) => app.getScheduleStats?.() ?? []);
    expect(stats.reduce((n, s) => n + s.runs, 0)).toBe(1);
    expect(stats.find((s) => s.lastDay)?.lastDay).toBe("2026-10-23");
    await Promise.all([a.close(), b.close()]);
  });

  it("a restart (new app, same ledger) does not rerun the day", async () => {
    const ledger = createMemoryDailyLedger();
    const lock = createMemoryLockAdapter();
    const calls: Array<string | undefined> = [];
    const first = await replica(ledger, lock, calls, "a");
    await waitFor(() => calls.length === 1, { label: "first run" });
    await first.close();
    const second = await replica(ledger, lock, calls, "a");
    await waitFor(() => (second.getScheduleStats?.()[0]?.skippedByGate ?? 0) >= 1, {
      label: "second boot declined",
    });
    expect(calls).toHaveLength(1);
    await second.close();
  });

  it("a failing handler is counted as a failure and retried on the next poll", async () => {
    const ledger = createMemoryDailyLedger();
    let attempts = 0;
    const app = Fastify({ logger: false });
    await app.register(schedulesPlugin, {
      singleReplica: true,
      schedules: [
        {
          name: "flaky",
          every: 20,
          runOnStart: true,
          daily: { hour: 2, zone: "UTC", ledger, clock },
          handler: () => {
            if (++attempts === 1) throw new Error("first run fails");
          },
        },
      ],
    });
    await app.ready();
    await waitFor(() => ledger.claims().some((c) => c.completed), { label: "retry succeeded" });
    const stat = app.getScheduleStats?.()[0];
    expect(stat?.failures).toBe(1);
    expect(stat?.runs).toBe(2); // the failed run and the retry
    await app.close();
  });

  it("boot validation names the schedule", async () => {
    const app = Fastify({ logger: false });
    await expect(
      app.register(schedulesPlugin, {
        schedules: [
          {
            name: "bad",
            every: 1000,
            handler: () => {},
            daily: { hour: 99, zone: "UTC", ledger: createMemoryDailyLedger() },
          },
        ],
      }),
    ).rejects.toThrow(/"bad" daily.*hour/);
  });
});
