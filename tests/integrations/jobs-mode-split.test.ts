/**
 * `jobsPlugin({ mode })` — producer/worker split (topology plan, Phase 2).
 *
 * An API replica that merely registered the plugin must not CONSUME jobs:
 * every replica competing on every queue means handler concurrency scales
 * with HTTP fleet size, which is exactly backwards. Pinned:
 *
 *   producer → queues only (dispatch works, NO Worker constructed,
 *              no repeat-schedule ownership)
 *   worker   → queues + workers (a worker needs its queue for DLQ/dispatch)
 *   both     → the default; single-process behaviour unchanged
 */

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineJob, jobsPlugin } from "../../src/integrations/jobs/index.js";

const constructed = { queues: [] as string[], workers: [] as string[] };

vi.mock("bullmq", () => {
  class Queue {
    constructor(public name: string) {
      constructed.queues.push(name);
    }
    add = vi.fn(async () => ({ id: "job-1" }));
    getJobCounts = vi.fn(async () => ({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    }));
    getJob = vi.fn(async () => undefined);
    upsertJobScheduler = vi.fn(async () => {});
    getJobSchedulers = vi.fn(async () => []);
    close = vi.fn(async () => {});
  }
  class Worker {
    constructor(public name: string) {
      constructed.workers.push(name);
    }
    on = vi.fn();
    pause = vi.fn(async () => {});
    close = vi.fn(async () => {});
  }
  return { Queue, Worker };
});

async function boot(mode?: "both" | "producer" | "worker") {
  const app = Fastify({ logger: false });
  await app.register(jobsPlugin, {
    connection: { host: "localhost", port: 6379 },
    jobs: [defineJob({ name: "send-email", handler: async () => {} })],
    ...(mode ? { mode } : {}),
  });
  await app.ready();
  return app;
}

describe("jobsPlugin mode split", () => {
  afterEach(() => {
    constructed.queues.length = 0;
    constructed.workers.length = 0;
  });

  it("producer: queue only — dispatch works, no Worker exists to consume", async () => {
    const app = await boot("producer");
    expect(constructed.queues).toContain("send-email");
    expect(constructed.workers).toHaveLength(0);
    // dispatch still functions through the queue
    const handle = await app.jobs.dispatch("send-email", { to: "x@y.z" });
    expect(handle).toBeTruthy();
    await app.close();
  });

  it("worker: queues AND workers", async () => {
    const app = await boot("worker");
    expect(constructed.queues).toContain("send-email");
    expect(constructed.workers).toContain("send-email");
    await app.close();
  });

  it("default is both — single-process behaviour unchanged", async () => {
    const app = await boot();
    expect(constructed.queues).toContain("send-email");
    expect(constructed.workers).toContain("send-email");
    await app.close();
  });
});
