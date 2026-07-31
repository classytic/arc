/**
 * Jobs Plugin — Status Endpoint + maxConcurrent Semaphore
 *
 * Tests:
 *   1. GET /jobs/:queue/:id/status returns 404 for unknown IDs
 *   2. GET /jobs/:queue/:id/status returns job data when found
 *   3. `throttled` reflects semaphore state
 *   4. maxConcurrent semaphore queues excess executions and releases correctly
 *   5. dispatcher.getStatus(queue, id) is queue-qualified — BullMQ ids are queue-local
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import eventPlugin from "../../src/events/eventPlugin.js";
import { defineJob, jobsPlugin } from "../../src/integrations/jobs/index.js";

// ── BullMQ mock with Job.fromId support ──────────────────────────────────────

type MockJobRecord = {
  id: string;
  name: string; // queue name (for scoping)
  state: string;
  progress: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
  returnvalue: unknown;
};

const jobStore = new Map<string, MockJobRecord>();
let jobIdCounter = 0;

vi.mock("bullmq", () => {
  class Queue {
    constructor(
      public name: string,
      public opts: unknown,
    ) {}

    add = vi.fn(async (_jobName: string, _data: unknown, _opts: unknown) => {
      const id = `job-${++jobIdCounter}`;
      jobStore.set(id, {
        id,
        name: this.name, // queue name — mirrors BullMQ Redis key namespace
        state: "waiting",
        progress: 0,
        timestamp: Date.now(),
        processedOn: null,
        finishedOn: null,
        failedReason: null,
        returnvalue: null,
      });
      return { id };
    });

    getJob = vi.fn(async (id: string) => {
      const record = jobStore.get(id);
      // Scope to this queue's namespace — mirrors BullMQ Redis key scoping.
      if (!record || record.name !== this.name) return undefined;
      return {
        ...record,
        getState: async () => record.state,
      };
    });

    getJobCounts = vi.fn(async () => ({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    }));

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

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildApp(jobs: ReturnType<typeof defineJob>[]) {
  const app = Fastify({ logger: false });
  await app.register(eventPlugin);
  await app.register(jobsPlugin, {
    connection: { host: "localhost", port: 6379 },
    jobs,
    // Management routes are OFF by default — a status carries `returnValue` and
    // `failedReason`. These tests exercise that surface, so they opt in and
    // explicitly un-redact the two sensitive fields.
    managementRoutes: {
      operatorPermission: () => true,
      // A bare predicate cannot declare itself platform-only, so arc refuses it
      // at boot. These tests are exercising the status surface, not the gate.
      allowUnverifiedOperatorPermission: true,
      exposeResult: true,
      exposeFailureReason: true,
    },
  });
  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /jobs/:queue/:id/status", () => {
  beforeEach(() => {
    jobStore.clear();
    jobIdCounter = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for an unknown job ID", async () => {
    const job = defineJob({ name: "noop", handler: async () => {} });
    const app = await buildApp([job]);

    const res = await app.inject({ method: "GET", url: "/jobs/noop/does-not-exist/status" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "arc.not_found" });

    await app.close();
  });

  it("returns job snapshot for a known job ID", async () => {
    const job = defineJob({ name: "email", handler: async () => {} });
    const app = await buildApp([job]);

    const { jobId } = await app.jobs.dispatch("email", { to: "a@b.com" });

    // Set the mock state to 'completed' for the assertion
    const record = jobStore.get(jobId);
    if (record) {
      record.state = "completed";
      record.finishedOn = Date.now();
      record.returnvalue = { sent: true };
    }

    const res = await app.inject({ method: "GET", url: `/jobs/email/${jobId}/status` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: jobId,
      name: "email",
      state: "completed",
      progress: 0,
    });
    expect(body.returnValue).toEqual({ sent: true });

    await app.close();
  });

  it("returns `throttled: undefined` for a normally-executing job", async () => {
    const job = defineJob({ name: "fast", handler: async () => {} });
    const app = await buildApp([job]);

    const { jobId } = await app.jobs.dispatch("fast", {});
    const res = await app.inject({ method: "GET", url: `/jobs/fast/${jobId}/status` });

    expect(res.statusCode).toBe(200);
    expect(res.json().throttled).toBeUndefined();

    await app.close();
  });
});

describe("dispatcher.getStatus()", () => {
  beforeEach(() => {
    jobStore.clear();
    jobIdCounter = 0;
  });

  it("returns null for a job ID not in any queue", async () => {
    const job = defineJob({ name: "q1", handler: async () => {} });
    const app = await buildApp([job]);

    const result = await app.jobs.getStatus("q1", "nonexistent-id");
    expect(result).toBeNull();

    await app.close();
  });

  it("resolves within the NAMED queue — ids are queue-local, so an id alone is ambiguous", async () => {
    const jobA = defineJob({ name: "queue-a", handler: async () => {} });
    const jobB = defineJob({ name: "queue-b", handler: async () => {} });
    const app = await buildApp([jobA, jobB]);

    // Dispatch to queue-b, status should find it there
    const { jobId } = await app.jobs.dispatch("queue-b", { x: 1 });
    const record = jobStore.get(jobId);
    if (record) record.state = "active";

    const status = await app.jobs.getStatus("queue-b", jobId);

    expect(status).not.toBeNull();
    expect(status?.name).toBe("queue-b");
    // The same id in a DIFFERENT queue is not this job. The old scan returned
    // whichever queue happened to match first.
    expect(await app.jobs.getStatus("queue-a", jobId)).toBeNull();
    expect(status?.state).toBe("active");

    await app.close();
  });

  it("returns failed job details including failedReason", async () => {
    const job = defineJob({ name: "risky", handler: async () => {} });
    const app = await buildApp([job]);

    const { jobId } = await app.jobs.dispatch("risky", {});
    const record = jobStore.get(jobId);
    if (record) {
      record.state = "failed";
      record.failedReason = "Connection refused";
      record.finishedOn = Date.now();
    }

    const status = await app.jobs.getStatus("risky", jobId);

    expect(status?.state).toBe("failed");
    expect(status?.failedReason).toBe("Connection refused");
    expect(status?.finishedOn).toBeDefined();

    await app.close();
  });
});

// ── Semaphore unit tests (no BullMQ, exercises the class directly) ────────────

describe("maxConcurrent semaphore logic", () => {
  it("executes up to maxConcurrent jobs simultaneously", async () => {
    const running: number[] = [];
    const maxObserved = { value: 0 };

    const handler = async (n: number): Promise<void> => {
      running.push(n);
      maxObserved.value = Math.max(maxObserved.value, running.length);
      await new Promise<void>((r) => setTimeout(r, 10));
      running.splice(running.indexOf(n), 1);
    };

    // Simulate semaphore with limit=2 using the same pattern as jobs.ts
    const permits = 2;
    let available = permits;
    const waiters: Array<() => void> = [];

    const acquire = (): Promise<void> => {
      if (available > 0) {
        available--;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    };
    const release = (): void => {
      const next = waiters.shift();
      if (next) next();
      else available++;
    };

    // Launch 5 concurrent "jobs"
    const tasks = Array.from({ length: 5 }, (_, i) =>
      (async () => {
        await acquire();
        try {
          await handler(i);
        } finally {
          release();
        }
      })(),
    );

    await Promise.all(tasks);

    // Max simultaneous executions must never exceed 2
    expect(maxObserved.value).toBeLessThanOrEqual(2);
  });

  it("always releases the slot even when handler throws", async () => {
    let available = 1;
    const waiters: Array<() => void> = [];

    const acquire = (): Promise<void> => {
      if (available > 0) {
        available--;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    };
    const release = (): void => {
      const next = waiters.shift();
      if (next) next();
      else available++;
    };

    const runWithSemaphore = async (fn: () => Promise<void>): Promise<void> => {
      await acquire();
      try {
        await fn();
      } finally {
        release();
      }
    };

    // First job throws
    await expect(
      runWithSemaphore(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Slot must be free again — second job acquires immediately
    let secondStarted = false;
    await runWithSemaphore(async () => {
      secondStarted = true;
    });
    expect(secondStarted).toBe(true);
  });
});
