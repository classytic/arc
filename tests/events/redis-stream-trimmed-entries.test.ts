/**
 * Entries trimmed out of the stream while they sat in this group's pending
 * list — XDEL, or MAXLEN evicting them behind a slow consumer.
 *
 * Redis still reports them (XREADGROUP on the PEL, XCLAIM) but with `null`
 * fields: the id exists, the payload is gone. There is nothing to process and
 * nothing to dead-letter, so the ONLY way to clear one is to ack it. Left
 * alone it is a ghost — every claim cycle re-delivers it, forever, and the
 * pending count never returns to zero.
 *
 * What is pinned here is the handling AROUND that ack, because the ack sits in
 * front of the batch's live work:
 *   - one variadic XACK per batch, not one round trip per ghost (a stream
 *     trimmed mid-batch yields `batchSize` of them at once);
 *   - a failing ack must not take the live entries down with it.
 */

import { describe, expect, it, vi } from "vitest";
import { RedisStreamTransport } from "../../src/events/transports/redis-stream.js";

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

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
  processEntries(entries: Array<[string, string[] | null]>): Promise<void>;
  processEntry(messageId: string, fields: string[]): Promise<void>;
};

/** A transport over the stub, with `processEntry` replaced by a recorder. */
function harness(redis = makeRedisStub(), opts: Record<string, unknown> = {}) {
  const transport = new RedisStreamTransport(redis as never, {
    logger: noopLogger,
    ...opts,
  }) as unknown as Internals;
  const processed: string[] = [];
  transport.processEntry = vi.fn(async (messageId: string) => {
    processed.push(messageId);
  });
  return { transport, redis, processed };
}

const live = (id: string): [string, string[]] => [id, ["event", "{}"]];
const ghost = (id: string): [string, null] => [id, null];

/** The stream/group the transport defaults to, as XACK receives them. */
function ackCalls(redis: ReturnType<typeof makeRedisStub>) {
  return redis.xack.mock.calls as unknown as Array<[string, string, ...string[]]>;
}

describe("RedisStreamTransport — trimmed (ghost) entries", () => {
  it("acks a trimmed entry instead of processing it", async () => {
    const { transport, redis, processed } = harness();

    await transport.processEntries([ghost("1-0")]);

    expect(processed).toEqual([]);
    expect(redis.xack).toHaveBeenCalledTimes(1);
    expect(ackCalls(redis)[0]?.slice(2)).toEqual(["1-0"]);
  });

  it("acks a whole batch of ghosts in ONE variadic call", async () => {
    const { transport, redis } = harness();
    const ids = ["1-0", "2-0", "3-0", "4-0", "5-0"];

    await transport.processEntries(ids.map(ghost));

    // The point: one round trip, not five. Per-id awaits would stall every
    // live entry in the batch behind them.
    expect(redis.xack).toHaveBeenCalledTimes(1);
    expect(ackCalls(redis)[0]?.slice(2)).toEqual(ids);
  });

  it("live entries in a mixed batch still process, in order", async () => {
    const { transport, redis, processed } = harness();

    await transport.processEntries([live("1-0"), ghost("2-0"), live("3-0"), ghost("4-0")]);

    expect(processed).toEqual(["1-0", "3-0"]);
    expect(ackCalls(redis)[0]?.slice(2)).toEqual(["2-0", "4-0"]);
  });

  it("makes no ack call at all when nothing was trimmed", async () => {
    const { transport, redis, processed } = harness();

    await transport.processEntries([live("1-0"), live("2-0")]);

    expect(processed).toEqual(["1-0", "2-0"]);
    // `processEntry` is stubbed, so any XACK here could only be the ghost path.
    expect(redis.xack).not.toHaveBeenCalled();
  });

  it("a FAILING ghost ack does not take the batch's live entries with it", async () => {
    // The ack is a cleanup for entries that can never be processed. Letting it
    // reject would surface as a poll error and back the whole consumer off —
    // real work dropped for the sake of housekeeping on entries that no longer
    // exist. The ghosts simply stay pending and the next cycle retries.
    const redis = makeRedisStub();
    redis.xack = vi.fn(async () => {
      throw new Error("READONLY You can't write against a read only replica.");
    });
    const error = vi.fn();
    const { transport, processed } = harness(redis, { logger: { ...noopLogger, error } });

    await expect(
      transport.processEntries([ghost("1-0"), live("2-0"), live("3-0")]),
    ).resolves.toBeUndefined();

    expect(processed).toEqual(["2-0", "3-0"]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("ghosts do not consume worker-pool slots under raised concurrency", async () => {
    const { transport, processed } = harness(makeRedisStub(), { processingConcurrency: 3 });

    await transport.processEntries([
      ghost("1-0"),
      ghost("2-0"),
      live("3-0"),
      ghost("4-0"),
      live("5-0"),
    ]);

    // The pool sizes to the LIVE count; a batch that is mostly ghosts must not
    // spin up (or starve) workers over entries there is no work for.
    expect(processed.sort()).toEqual(["3-0", "5-0"]);
  });
});
