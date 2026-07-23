/**
 * Jobs Plugin — Stale Repeatable-Schedule Reconciliation
 *
 * BullMQ keys repeatable schedules by a hash of their repeat options. A
 * deploy that changes a job's cron pattern / every interval therefore
 * creates a NEW schedule while the OLD one keeps firing — double-firing
 * until someone manually cleans Redis. At plugin registration arc now
 * enumerates existing schedulers per queue and removes the ones that match
 * a registered job's NAME but no longer match its repeat SPEC.
 *
 * Contracts pinned here:
 *   - stale schedule (changed pattern / every) is removed before re-add
 *   - matching schedule is kept (upsert-in-place, timing state preserved)
 *   - foreign schedulers (names arc didn't register) are NEVER removed
 *   - legacy getRepeatableJobs()/removeRepeatableByKey() fallback works,
 *     including the string-typed `every` it reports
 *   - enumeration failure is fail-open: warn + boot continues
 *   - queues lacking both APIs (older BullMQ / bare mocks) skip silently
 *
 * Uses vi.mock('bullmq') following the jobs-production-hardening pattern.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import eventPlugin from "../../src/events/eventPlugin.js";
import { defineJob, type JobDefinition, jobsPlugin } from "../../src/integrations/jobs/index.js";

// ── BullMQ mock state ──

interface FakeSchedulerRecord {
  key: string;
  name: string;
  pattern?: string | null;
  every?: number | string | null;
  tz?: string | null;
  endDate?: number | null;
}

const state = {
  /** Pre-existing schedules returned by the listing API. */
  schedulers: [] as FakeSchedulerRecord[],
  /** Keys removed via the modern removeJobScheduler API. */
  removedSchedulerKeys: [] as string[],
  /** Keys removed via the legacy removeRepeatableByKey API. */
  removedRepeatableKeys: [] as string[],
  /** Every queue.add() call (the repeat upsert lands here). */
  addCalls: [] as Array<{ queue: string; name: string; opts: Record<string, unknown> }>,
  /** When set, the listing API throws this. */
  listError: null as Error | null,
  /** Which scheduler API surface the fake Queue exposes. */
  apiMode: "modern" as "modern" | "legacy" | "none",
  /** Listing-API invocation count (proves non-repeat jobs skip reconcile). */
  listCalls: 0,
};

vi.mock("bullmq", () => {
  class Queue {
    getJobSchedulers?: () => Promise<FakeSchedulerRecord[]>;
    removeJobScheduler?: (id: string) => Promise<boolean>;
    getRepeatableJobs?: () => Promise<FakeSchedulerRecord[]>;
    removeRepeatableByKey?: (key: string) => Promise<boolean>;

    constructor(
      public name: string,
      public opts: unknown,
    ) {
      const list = async () => {
        state.listCalls++;
        if (state.listError) throw state.listError;
        return state.schedulers;
      };
      if (state.apiMode === "modern") {
        this.getJobSchedulers = list;
        this.removeJobScheduler = async (id: string) => {
          state.removedSchedulerKeys.push(id);
          return true;
        };
      } else if (state.apiMode === "legacy") {
        this.getRepeatableJobs = list;
        this.removeRepeatableByKey = async (key: string) => {
          state.removedRepeatableKeys.push(key);
          return true;
        };
      }
    }

    add = vi.fn(async (name: string, _data: unknown, opts: Record<string, unknown>) => {
      state.addCalls.push({ queue: this.name, name, opts });
      return { id: `job-${state.addCalls.length}` };
    });
    getJobCounts = vi.fn(async () => ({}));
    close = vi.fn(async () => {});
  }

  class Worker {
    constructor(
      public name: string,
      _processor: unknown,
      _opts: unknown,
    ) {}
    on = vi.fn();
    pause = vi.fn(async () => {});
    close = vi.fn(async () => {});
  }

  return { Queue, Worker };
});

// ── Helpers ──

function makeFastifyWithSpyLogger(): {
  app: FastifyInstance;
  warnSpy: ReturnType<typeof vi.fn>;
} {
  const warnSpy = vi.fn();
  const app = Fastify({ logger: false });
  Object.defineProperty(app, "log", {
    value: {
      warn: warnSpy,
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: () => app.log,
    },
    writable: false,
    configurable: true,
  });
  return { app, warnSpy };
}

async function registerApp(jobs: JobDefinition[]) {
  const { app, warnSpy } = makeFastifyWithSpyLogger();
  await app.register(eventPlugin);
  await app.register(jobsPlugin, {
    connection: { host: "localhost", port: 6379 },
    jobs,
  });
  await app.ready();
  return { app, warnSpy };
}

describe("jobsPlugin — stale repeatable-schedule reconciliation", () => {
  beforeEach(() => {
    state.schedulers = [];
    state.removedSchedulerKeys = [];
    state.removedRepeatableKeys = [];
    state.addCalls = [];
    state.listError = null;
    state.apiMode = "modern";
    state.listCalls = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("removes a stale scheduler whose cron pattern changed, then re-adds the current spec", async () => {
    state.schedulers = [
      { key: "stale-key", name: "digest", pattern: "0 8 * * *", tz: "UTC", every: null },
    ];

    const job = defineJob({
      name: "digest",
      handler: async () => ({ ok: true }),
      repeat: { pattern: "0 9 * * *", tz: "UTC" },
    });

    const { app, warnSpy } = await registerApp([job]);

    expect(state.removedSchedulerKeys).toEqual(["stale-key"]);
    // The new schedule is still upserted AFTER cleanup.
    const upsert = state.addCalls.find((c) => c.opts?.repeat);
    expect(upsert?.opts.repeat).toMatchObject({ pattern: "0 9 * * *", tz: "UTC" });
    // Operators get a breadcrumb.
    const warns = warnSpy.mock.calls.map((c) => JSON.stringify(c));
    expect(warns.some((c) => /stale repeatable schedule/i.test(c))).toBe(true);

    await app.close();
  });

  it("keeps a scheduler whose spec (pattern + tz + endDate) is unchanged", async () => {
    const endDate = Date.UTC(2030, 0, 1);
    state.schedulers = [
      { key: "current-key", name: "digest", pattern: "0 9 * * *", tz: "UTC", endDate },
    ];

    const job = defineJob({
      name: "digest",
      handler: async () => ({ ok: true }),
      repeat: { pattern: "0 9 * * *", tz: "UTC", endDate: new Date(endDate) },
    });

    const { app } = await registerApp([job]);

    expect(state.removedSchedulerKeys).toEqual([]);

    await app.close();
  });

  it("never removes foreign schedulers (names arc did not register)", async () => {
    state.schedulers = [
      // Host-managed scheduler living on the same queue — must be untouched
      // even though its spec matches nothing arc knows about.
      { key: "foreign-key", name: "host-custom-task", pattern: "*/5 * * * *", tz: "UTC" },
      { key: "stale-key", name: "digest", pattern: "0 8 * * *", tz: "UTC" },
    ];

    const job = defineJob({
      name: "digest",
      handler: async () => ({ ok: true }),
      repeat: { pattern: "0 9 * * *", tz: "UTC" },
    });

    const { app } = await registerApp([job]);

    expect(state.removedSchedulerKeys).toEqual(["stale-key"]);
    expect(state.removedSchedulerKeys).not.toContain("foreign-key");

    await app.close();
  });

  it("detects changed `every` intervals via the legacy API (string-typed every)", async () => {
    state.apiMode = "legacy";
    state.schedulers = [
      // Legacy getRepeatableJobs() reports `every` as a string.
      { key: "stale-every", name: "heartbeat", every: "60000", pattern: null, tz: null },
      { key: "current-every", name: "heartbeat", every: "30000", pattern: null, tz: null },
    ];

    const job = defineJob({
      name: "heartbeat",
      handler: async () => ({ ok: true }),
      repeat: { every: 30_000 },
    });

    const { app } = await registerApp([job]);

    // Only the mismatching interval is dropped; "30000" == 30_000 after
    // normalisation, so the current schedule survives the boot untouched.
    expect(state.removedRepeatableKeys).toEqual(["stale-every"]);

    await app.close();
  });

  it("is fail-open: enumeration errors warn and never block boot", async () => {
    state.listError = new Error("READONLY You can't write against a read only replica");

    const job = defineJob({
      name: "digest",
      handler: async () => ({ ok: true }),
      repeat: { pattern: "0 9 * * *", tz: "UTC" },
    });

    // Registration must succeed despite the reconcile failure...
    const { app, warnSpy } = await registerApp([job]);

    // ...the schedule upsert still happens...
    expect(state.addCalls.some((c) => c.opts?.repeat)).toBe(true);
    // ...and the failure is surfaced as a warning, not a crash.
    const warns = warnSpy.mock.calls.map((c) => JSON.stringify(c));
    expect(warns.some((c) => /Failed to reconcile repeatable schedules/i.test(c))).toBe(true);

    await app.close();
  });

  it("skips silently when the queue exposes neither scheduler API (older BullMQ)", async () => {
    state.apiMode = "none";
    state.schedulers = [{ key: "stale-key", name: "digest", pattern: "0 8 * * *", tz: "UTC" }];

    const job = defineJob({
      name: "digest",
      handler: async () => ({ ok: true }),
      repeat: { pattern: "0 9 * * *", tz: "UTC" },
    });

    const { app } = await registerApp([job]);

    expect(state.removedSchedulerKeys).toEqual([]);
    expect(state.removedRepeatableKeys).toEqual([]);
    expect(state.addCalls.some((c) => c.opts?.repeat)).toBe(true);

    await app.close();
  });

  it("does not enumerate schedulers for jobs without a repeat config", async () => {
    const job = defineJob({
      name: "one-shot",
      handler: async () => ({ ok: true }),
    });

    const { app } = await registerApp([job]);

    expect(state.listCalls).toBe(0);

    await app.close();
  });
});
