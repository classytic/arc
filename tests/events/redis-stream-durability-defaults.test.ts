/**
 * A durable stream's defaults never lose an entry silently: no trimming unless asked, a new
 * group's start is an explicit choice, and the payload limit counts BYTES, not characters.
 */

import { describe, expect, it, vi } from "vitest";
import { RedisStreamTransport } from "../../src/events/transports/redis-stream.js";

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const redis = () => ({
  xadd: vi.fn(async (..._args: unknown[]) => "1-1"),
  xgroup: vi.fn(async (..._args: unknown[]) => "OK"),
  xreadgroup: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return null;
  }),
  quit: vi.fn(async () => "OK"),
  disconnect: vi.fn(() => {}),
  xack: vi.fn(async () => 1),
  xpending: vi.fn(async () => []),
  xclaim: vi.fn(async () => []),
  xlen: vi.fn(async () => 0),
  hset: vi.fn(async () => 1),
  hgetall: vi.fn(async () => ({})),
  del: vi.fn(async () => 1),
  pexpire: vi.fn(async () => 1),
});
const event = (payload: unknown) => ({
  type: "order:placed",
  payload,
  meta: { id: "e1", timestamp: new Date() },
});

describe("RedisStreamTransport durability defaults", () => {
  it("does not trim by default — MAXLEN only when configured", async () => {
    const r = redis();
    await new RedisStreamTransport(r as never, { logger: silent }).publish(event({}) as never);
    expect(r.xadd.mock.calls[0]).not.toContain("MAXLEN");

    const bounded = redis();
    await new RedisStreamTransport(bounded as never, { logger: silent, maxLen: 500 }).publish(
      event({}) as never,
    );
    expect(bounded.xadd.mock.calls[0]).toEqual(expect.arrayContaining(["MAXLEN", "~", "500"]));
  });

  it("a new group starts at the latest entry unless told to replay", async () => {
    const latest = redis();
    const t1 = new RedisStreamTransport(latest as never, { logger: silent });
    t1.hold();
    await t1.subscribe("order:*", async () => {});
    await t1.start();
    expect(latest.xgroup.mock.calls[0]?.[3]).toBe("$");
    await t1.close();

    const replay = redis();
    const t2 = new RedisStreamTransport(replay as never, {
      logger: silent,
      groupStart: "beginning",
    });
    t2.hold();
    await t2.subscribe("order:*", async () => {});
    await t2.start();
    expect(replay.xgroup.mock.calls[0]?.[3]).toBe("0");
    await t2.close();
  });

  it("the payload limit counts UTF-8 bytes — Bengali is 3 bytes a character", async () => {
    const t = new RedisStreamTransport(redis() as never, { logger: silent, maxPayloadBytes: 200 });
    // ~90 characters, ~270 bytes: under a character count, over the byte limit.
    await expect(t.publish(event({ note: "বাংলা".repeat(18) }) as never)).rejects.toThrow(
      /bytes\) exceeds limit/,
    );
  });
});
