/**
 * Reusable BullMQ mock for jobsPlugin wiring tests.
 *
 * Usage (vi.mock factories are hoisted, so the shared state must be too):
 *
 *   const { processors } = vi.hoisted(() => ({
 *     processors: new Map<string, (job: unknown) => Promise<unknown>>(),
 *   }));
 *   vi.mock("bullmq", async () =>
 *     (await import("../_support/bullmq.js")).createBullmqMock(processors),
 *   );
 *
 * `processors` captures each worker's processor by queue name so tests can
 * invoke it directly — no Redis, no timers.
 */

import { vi } from "vitest";

export function createBullmqMock(processors: Map<string, (job: unknown) => Promise<unknown>>) {
  class Queue {
    constructor(public name: string) {}
    add = vi.fn(async () => ({ id: "job-1" }));
    getJobCounts = vi.fn(async () => ({}));
    close = vi.fn(async () => {});
  }
  class Worker {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      processors.set(name, processor);
    }
    on() {
      return this;
    }
    pause = vi.fn(async () => {});
    close = vi.fn(async () => {});
  }
  return { Queue, Worker };
}
