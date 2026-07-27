/**
 * Job timeout, cancellation, and bulkhead semantics.
 *
 * The algorithm lives in `executeTimedHandler` (jobs-execution.ts) and is
 * tested directly — no BullMQ mocks. One wiring section at the end proves
 * jobsPlugin threads it correctly (signal in JobMeta, semaphore as the
 * releaseSlot, per-job cancelGraceMs).
 *
 * Contract under test:
 *  - handler gets an AbortSignal, aborted at timeout (cooperative cancel);
 *  - the bulkhead slot releases when the handler SETTLES, not when the
 *    timeout race rejects;
 *  - `cancelGraceMs` bounds the post-timeout hold (force-release, logged);
 *  - a timed-out handler's late settle is logged, result discarded;
 *  - release fires exactly once on every path, including sync throws.
 */

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import eventPlugin from "../../src/events/eventPlugin.js";
import { executeTimedHandler } from "../../src/integrations/jobs/execution.js";
import { defineJob, type JobMeta, jobsPlugin } from "../../src/integrations/jobs/index.js";
import { deferred, flushPromises, wait } from "../_support/deferred.js";
import { recordingLogger } from "../_support/logger.js";

// ============================================================================
// executeTimedHandler — the primitive
// ============================================================================

describe("executeTimedHandler", () => {
  it("resolves with the handler result and releases the slot once", async () => {
    const releases: number[] = [];
    const result = await executeTimedHandler({
      label: "t",
      releaseSlot: () => releases.push(1),
      run: async () => "ok",
    });
    await flushPromises();
    expect(result).toBe("ok");
    expect(releases).toHaveLength(1);
  });

  it("rejections release the slot exactly once and propagate", async () => {
    const releases: number[] = [];
    await expect(
      executeTimedHandler({
        label: "t",
        releaseSlot: () => releases.push(1),
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    await flushPromises();
    expect(releases).toHaveLength(1);
  });

  it("a SYNCHRONOUS throw still releases the slot", async () => {
    const releases: number[] = [];
    await expect(
      executeTimedHandler({
        label: "t",
        releaseSlot: () => releases.push(1),
        run: () => {
          throw new Error("sync-boom");
        },
      }),
    ).rejects.toThrow("sync-boom");
    await flushPromises();
    expect(releases).toHaveLength(1);
  });

  it("aborts the signal on timeout; the caller gets the timeout error", async () => {
    let seen: AbortSignal | undefined;
    await expect(
      executeTimedHandler({
        label: "slow",
        timeoutMs: 20,
        run: async (signal) => {
          seen = signal;
          await wait(200);
          return "late";
        },
      }),
    ).rejects.toThrow(/timed out after 20ms/);
    expect(seen?.aborted).toBe(true);
  });

  it("signal stays quiet when the handler beats the timeout", async () => {
    let seen: AbortSignal | undefined;
    await executeTimedHandler({
      label: "fast",
      timeoutMs: 5000,
      run: async (signal) => {
        seen = signal;
        return "ok";
      },
    });
    expect(seen?.aborted).toBe(false);
  });

  it("holds the slot until a timed-out handler SETTLES (grace not reached)", async () => {
    const gate = deferred();
    let releasedAt = 0;
    const t0 = Date.now();

    const call = executeTimedHandler({
      label: "held",
      timeoutMs: 20,
      cancelGraceMs: 5000,
      releaseSlot: () => {
        releasedAt = Date.now() - t0;
      },
      run: async () => {
        await gate.promise; // ignores the signal
        return "late";
      },
    }).catch(() => "timed-out");

    await call; // caller got the timeout at ~20ms
    expect(releasedAt).toBe(0); // slot still held — handler live

    await wait(60);
    gate.resolve();
    await flushPromises();
    expect(releasedAt).toBeGreaterThanOrEqual(60); // released at settle, not timeout
  });

  it("cancelGraceMs force-releases a handler that never yields, with a loud log", async () => {
    const { logger, messages } = recordingLogger();
    const gate = deferred();
    let released = false;

    await executeTimedHandler({
      label: "stuck",
      timeoutMs: 20,
      cancelGraceMs: 40,
      logger,
      releaseSlot: () => {
        released = true;
      },
      run: async () => {
        await gate.promise;
        return "never";
      },
    }).catch(() => "timed-out");

    expect(released).toBe(false);
    await wait(70); // past timeout + grace
    expect(released).toBe(true);
    expect(messages("warn").join("\n")).toContain("force-releasing");

    gate.resolve(); // cleanup — late settle must not double-release
    await flushPromises();
  });

  it("logs the eventual settle of a timed-out handler (completed and failed)", async () => {
    const completed = recordingLogger();
    await executeTimedHandler({
      label: "late-ok",
      timeoutMs: 10,
      logger: completed.logger,
      run: async () => {
        await wait(50);
        return "done";
      },
    }).catch(() => {});
    await wait(60);
    expect(completed.messages("warn").join("\n")).toContain("eventually completed");

    const failed = recordingLogger();
    await executeTimedHandler({
      label: "late-fail",
      timeoutMs: 10,
      logger: failed.logger,
      run: async () => {
        await wait(50);
        throw new Error("late-boom");
      },
    }).catch(() => {});
    await wait(60);
    expect(failed.messages("warn").join("\n")).toContain("eventually failed");
  });

  it("no timeout: plain passthrough with settle-based release", async () => {
    const releases: number[] = [];
    const result = await executeTimedHandler({
      label: "plain",
      releaseSlot: () => releases.push(1),
      run: async () => 42,
    });
    await flushPromises();
    expect(result).toBe(42);
    expect(releases).toHaveLength(1);
  });
});

// ============================================================================
// jobsPlugin wiring — one integration proof (mocked BullMQ)
// ============================================================================

const { processors } = vi.hoisted(() => ({
  processors: new Map<string, (job: unknown) => Promise<unknown>>(),
}));
vi.mock("bullmq", async () => (await import("../_support/bullmq.js")).createBullmqMock(processors));

describe("jobsPlugin wiring", () => {
  afterEach(() => {
    processors.clear();
  });

  it("threads signal into JobMeta, semaphore into releaseSlot, and serializes under maxConcurrent", async () => {
    const starts: Record<string, number> = {};
    let seenSignal: AbortSignal | undefined;
    const t0 = Date.now();

    const fastify = Fastify({ logger: false });
    await fastify.register(eventPlugin);
    await fastify.register(jobsPlugin, {
      connection: { host: "localhost", port: 6379 },
      jobs: [
        defineJob({
          name: "guarded",
          timeout: 20,
          maxConcurrent: 1,
          cancelGraceMs: 5000,
          handler: async (data: { id: string; runMs: number }, meta: JobMeta) => {
            starts[data.id] = Date.now() - t0;
            seenSignal = meta.signal;
            await wait(data.runMs);
            return { ok: true };
          },
        }),
      ],
    });
    await fastify.ready();
    const processor = processors.get("guarded");
    if (!processor) throw new Error("processor not captured");

    // A times out at ~20ms but runs ~100ms; B must wait for A's settle.
    const a = processor({ id: "a", data: { id: "a", runMs: 100 } }).catch(() => "timed-out");
    await wait(30);
    expect(seenSignal?.aborted).toBe(true); // meta.signal wired to the timeout
    const b = processor({ id: "b", data: { id: "b", runMs: 1 } });

    await Promise.all([a, b]);
    expect(starts.b).toBeGreaterThanOrEqual(95); // slot held until A settled
    await fastify.close();
  });
});
