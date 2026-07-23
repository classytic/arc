/**
 * Wave-12 performance: bounded `processingConcurrency` in
 * RedisStreamTransport.
 *
 * Default (1) processes a batch's entries strictly sequentially — the
 * ordering-safe default. Raising it runs a worker pool over the batch:
 * at most N entries in flight, every entry still processed exactly once.
 *
 * These tests exercise the internal `processEntries` pool directly with a
 * stubbed `processEntry`, which keeps them free of a live Redis while still
 * pinning the pool invariants (bound, completeness, sequential default).
 */

import { describe, expect, it, vi } from "vitest";
import { RedisStreamTransport } from "../../src/events/transports/redis-stream.js";

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Minimal RedisStreamLike stub — the pool tests never touch Redis. */
function makeRedisStub() {
  return {
    xadd: vi.fn(async () => "1-1"),
    xreadgroup: vi.fn(async () => null),
    xack: vi.fn(async () => 1),
    xgroup: vi.fn(async () => "OK"),
    xpending: vi.fn(async () => []),
    xclaim: vi.fn(async () => []),
    duplicate: vi.fn(),
    quit: vi.fn(async () => "OK"),
    disconnect: vi.fn(),
  };
}

type Internals = {
  processEntries(entries: Array<[string, string[]]>): Promise<void>;
  processEntry(messageId: string, fields: string[]): Promise<void>;
};

function makeEntries(n: number): Array<[string, string[]]> {
  return Array.from({ length: n }, (_, i) => [`${i + 1}-0`, ["event", "{}"]]);
}

describe("RedisStreamTransport — processEntries worker pool", () => {
  it("default concurrency 1 processes entries strictly in order, one at a time", async () => {
    const transport = new RedisStreamTransport(makeRedisStub() as never, {
      logger: noopLogger,
    }) as unknown as Internals;

    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    transport.processEntry = vi.fn(async (messageId: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      order.push(messageId);
      inFlight -= 1;
    });

    await transport.processEntries(makeEntries(5));

    expect(maxInFlight).toBe(1);
    expect(order).toEqual(["1-0", "2-0", "3-0", "4-0", "5-0"]);
  });

  it("processingConcurrency: 3 caps in-flight entries at 3 and still processes all", async () => {
    const transport = new RedisStreamTransport(makeRedisStub() as never, {
      logger: noopLogger,
      processingConcurrency: 3,
    }) as unknown as Internals;

    const processed = new Set<string>();
    let inFlight = 0;
    let maxInFlight = 0;
    transport.processEntry = vi.fn(async (messageId: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      processed.add(messageId);
      inFlight -= 1;
    });

    await transport.processEntries(makeEntries(10));

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // the pool actually overlaps
    expect(processed.size).toBe(10); // every entry exactly once
  });

  it("pool never spawns more workers than entries", async () => {
    const transport = new RedisStreamTransport(makeRedisStub() as never, {
      logger: noopLogger,
      processingConcurrency: 8,
    }) as unknown as Internals;

    let inFlight = 0;
    let maxInFlight = 0;
    transport.processEntry = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
    });

    await transport.processEntries(makeEntries(2));
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("invalid values are clamped to the sequential floor of 1", async () => {
    const transport = new RedisStreamTransport(makeRedisStub() as never, {
      logger: noopLogger,
      processingConcurrency: 0,
    }) as unknown as Internals;

    let inFlight = 0;
    let maxInFlight = 0;
    transport.processEntry = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
    });

    await transport.processEntries(makeEntries(4));
    expect(maxInFlight).toBe(1);
  });
});
