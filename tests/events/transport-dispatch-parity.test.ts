/**
 * The same subscriptions dispatch the same way on every local transport: a handler whose
 * patterns overlap for one event runs ONCE, in subscription order.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import { RedisStreamTransport } from "../../src/events/transports/redis-stream.js";

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe("dispatch parity across transports", () => {
  it("memory: overlapping patterns run a handler once", async () => {
    const t = new MemoryEventTransport({ logger: silent });
    const calls: string[] = [];
    const h = async () => void calls.push("h");
    await t.subscribe("order:*", h);
    await t.subscribe("order:created", h);
    await t.publish({ type: "order:created", payload: {}, meta: { id: "1", timestamp: new Date() } } as never);
    expect(calls).toEqual(["h"]);
  });

  it("redis stream: the same subscriptions resolve to the same handlers — once each", () => {
    const t = new RedisStreamTransport({ xadd: vi.fn(), xreadgroup: vi.fn(), xgroup: vi.fn() } as never, {
      logger: silent,
    });
    const internals = t as unknown as {
      router: { add(p: string, h: unknown): void };
      getMatchingHandlers(type: string): readonly unknown[];
    };
    const first = async () => {};
    const second = async () => {};
    internals.router.add("order:*", first);
    internals.router.add("order:created", second);
    internals.router.add("order:created", first);
    expect(internals.getMatchingHandlers("order:created")).toEqual([first, second]);
  });
});
