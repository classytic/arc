/**
 * Jobs Plugin — Timeout and Dead Letter Queue Tests
 *
 * Verifies that the BullMQ integration properly applies:
 * - Job-level timeout (Promise.race with timeout)
 * - Dead letter queue routing on exhausted retries
 *
 * These are unit tests for the job definition wiring, not BullMQ integration tests.
 * BullMQ requires Redis, so we test the configuration/type contracts.
 */

import { describe, expect, it } from "vitest";
import type { JobDefinition } from "../../src/integrations/jobs.js";
import { defineJob } from "../../src/integrations/jobs.js";

describe("defineJob configuration", () => {
  it("should accept timeout in job definition", () => {
    const job = defineJob({
      name: "process-image",
      handler: async (_data: { url: string }) => ({ processed: true }),
      timeout: 60000,
      retries: 3,
    });

    expect(job.timeout).toBe(60000);
    expect(job.retries).toBe(3);
    expect(job.name).toBe("process-image");
  });

  it("should accept deadLetterQueue in job definition", () => {
    const job = defineJob({
      name: "send-email",
      handler: async (_data: { to: string }) => ({ sent: true }),
      deadLetterQueue: "email:dead",
      retries: 5,
    });

    expect(job.deadLetterQueue).toBe("email:dead");
    expect(job.retries).toBe(5);
  });

  it("should accept all job configuration fields", () => {
    const job = defineJob({
      name: "complex-job",
      handler: async () => ({}),
      retries: 3,
      backoff: { type: "exponential", delay: 2000 },
      timeout: 30000,
      concurrency: 5,
      rateLimit: { max: 10, duration: 60000 },
      deadLetterQueue: "complex:failed",
    });

    expect(job).toMatchObject({
      name: "complex-job",
      retries: 3,
      backoff: { type: "exponential", delay: 2000 },
      timeout: 30000,
      concurrency: 5,
      rateLimit: { max: 10, duration: 60000 },
      deadLetterQueue: "complex:failed",
    });
  });

  it("should work with minimal job definition (only name + handler)", () => {
    const job = defineJob({
      name: "simple",
      handler: async () => "done",
    });

    expect(job.name).toBe("simple");
    expect(job.timeout).toBeUndefined();
    expect(job.deadLetterQueue).toBeUndefined();
    expect(job.retries).toBeUndefined();
  });
});

describe("JobDefinition type safety", () => {
  it("should type-check handler input and output", () => {
    const job: JobDefinition<{ orderId: string }, { shipped: boolean }> = {
      name: "ship-order",
      handler: async (data) => {
        // data is typed as { orderId: string }
        expect(typeof data.orderId).toBe("string");
        return { shipped: true };
      },
      timeout: 10000,
    };

    expect(job.name).toBe("ship-order");
  });
});
