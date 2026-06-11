/**
 * `RedisStreamTransport` poll-loop resilience under distributed failure:
 *
 *   1. `claimPending` scales its XPENDING window with `batchSize` (floor 10)
 *      — crash-recovery throughput is no longer capped at 10 entries per
 *      poll regardless of the configured read batch.
 *   2. Poll errors back off exponentially with full jitter (base 1s, cap
 *      30s, floor 100ms) and reset on a successful poll — a fleet of
 *      consumers no longer retries in lockstep after a shared Redis blip.
 *
 * Deterministic on purpose: `Math.random` is pinned (full jitter draws the
 * exact window edge) and the private `sleep()` is stubbed to record the
 * requested delay without waiting. Exercises the transport CLASS, not a
 * parallel mock.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type RedisStreamLike,
  RedisStreamTransport,
} from "../../src/events/transports/redis-stream.js";

// ---------- Helpers ----------

function silentLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

/** Fake that records XPENDING args; everything else is a benign no-op. */
function recordingRedis(): RedisStreamLike & { xpendingArgs: Array<(string | number)[]> } {
  const xpendingArgs: Array<(string | number)[]> = [];
  return {
    xpendingArgs,
    async xadd() {
      return "1-1";
    },
    async xreadgroup() {
      return null;
    },
    async xack() {
      return 0;
    },
    async xgroup() {
      return "OK";
    },
    async xpending(key, group, ...args) {
      xpendingArgs.push([key, group, ...args]);
      return [];
    },
    async xclaim() {
      return [];
    },
    async xlen() {
      return 0;
    },
    async quit() {
      return "OK";
    },
  };
}

/**
 * Fake whose `xreadgroup` consumes a script of "fail" | "ok" steps, then
 * parks (never-resolving read) so the poll loop sits still while the test
 * asserts. `disconnect()` releases the parked read — exactly how a real
 * socket teardown breaks `XREADGROUP BLOCK` — so `close()` drains cleanly.
 */
function scriptedRedis(script: Array<"fail" | "ok">) {
  let parkedResolve: ((value: null) => void) | null = null;
  const redis: RedisStreamLike = {
    async xadd() {
      return "1-1";
    },
    async xreadgroup() {
      const step = script.shift();
      if (step === "fail") throw new Error("redis blip");
      if (step === "ok") return null;
      return new Promise((resolve) => {
        parkedResolve = resolve;
      });
    },
    async xack() {
      return 0;
    },
    async xgroup() {
      return "OK";
    },
    async xpending() {
      return [];
    },
    async xclaim() {
      return [];
    },
    async xlen() {
      return 0;
    },
    async quit() {
      return "OK";
    },
    disconnect() {
      parkedResolve?.(null);
      parkedResolve = null;
    },
  };
  return { redis, isParked: () => parkedResolve !== null };
}

/** Stub the private sleep() to record requested delays without waiting. */
function stubSleep(transport: RedisStreamTransport): number[] {
  const sleeps: number[] = [];
  vi.spyOn(
    transport as unknown as { sleep: (ms: number) => Promise<void> },
    "sleep",
  ).mockImplementation(async (ms: number) => {
    sleeps.push(ms);
  });
  return sleeps;
}

/** Run the scripted poll loop until it parks, returning the recorded backoff sleeps. */
async function runScriptedLoop(script: Array<"fail" | "ok">): Promise<number[]> {
  const { redis, isParked } = scriptedRedis(script);
  const transport = new RedisStreamTransport(redis, {
    logger: silentLogger(),
    closeTimeoutMs: 5,
  });
  const sleeps = stubSleep(transport);
  await transport.subscribe("*", async () => {});
  await vi.waitFor(() => {
    if (!isParked()) throw new Error("poll loop not parked yet");
  });
  // Snapshot BEFORE close() — close() also routes through sleep() for its
  // bounded-drain race and would pollute the recording.
  const recorded = [...sleeps];
  await transport.close();
  return recorded;
}

// ============================================================================
// 1. claimPending — XPENDING window scales with batchSize
// ============================================================================

describe("RedisStreamTransport claimPending — recovery window scales with batchSize", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses batchSize as the XPENDING count when batchSize > 10", async () => {
    const redis = recordingRedis();
    const transport = new RedisStreamTransport(redis, {
      batchSize: 50,
      logger: silentLogger(),
    });

    await (transport as unknown as { claimPending(): Promise<void> }).claimPending();

    expect(redis.xpendingArgs).toEqual([["arc:events", "default", "-", "+", 50]]);
  });

  it("keeps a floor of 10 when batchSize is smaller", async () => {
    const redis = recordingRedis();
    const transport = new RedisStreamTransport(redis, {
      batchSize: 3,
      logger: silentLogger(),
    });

    await (transport as unknown as { claimPending(): Promise<void> }).claimPending();

    expect(redis.xpendingArgs).toEqual([["arc:events", "default", "-", "+", 10]]);
  });
});

// ============================================================================
// 2. Poll-error backoff — exponential, full-jitter, reset-on-success
// ============================================================================

describe("RedisStreamTransport poll-error backoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("grows the backoff window exponentially and caps at 30s", async () => {
    // Pin the jitter draw to the window's upper edge: delay = capped exactly.
    vi.spyOn(Math, "random").mockReturnValue(1);

    const sleeps = await runScriptedLoop(["fail", "fail", "fail", "fail", "fail", "fail"]);

    // base 1s doubling per consecutive error, capped at 30s (2^5 * 1s = 32s → 30s).
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it("resets the backoff window after a successful poll", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);

    const sleeps = await runScriptedLoop(["fail", "fail", "ok", "fail"]);

    // Third error comes AFTER a healthy poll — back to the base window.
    expect(sleeps).toEqual([1000, 2000, 1000]);
  });

  it("never sleeps below the 100ms floor (no hot-spin on a near-zero jitter draw)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    const sleeps = await runScriptedLoop(["fail", "fail", "fail"]);

    expect(sleeps).toEqual([100, 100, 100]);
  });

  it("draws jittered delays strictly inside [floor, window] with real randomness", async () => {
    const sleeps = await runScriptedLoop(["fail", "fail", "fail", "fail"]);

    expect(sleeps).toHaveLength(4);
    const windows = [1000, 2000, 4000, 8000];
    sleeps.forEach((delay, i) => {
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(windows[i] as number);
    });
  });
});
