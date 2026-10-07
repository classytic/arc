/**
 * A partially failed stream message must not re-run the handlers that already completed it —
 * on retry, on ANY replica, only the handlers that have not finished run again.
 */
import { describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "../../src/events/EventTransport.js";
import { RedisStreamTransport } from "../../src/events/transports/redis-stream.js";

const silent = { info: () => {}, warn: vi.fn(), error: () => {}, debug: () => {} };

/** One shared Redis for every replica: stream ops stubbed, hashes real. */
function sharedRedis() {
  const hashes = new Map<string, Record<string, string>>();
  return {
    hashes,
    xadd: vi.fn(async () => "1-1"),
    xreadgroup: vi.fn(async () => null),
    xack: vi.fn(async () => 1),
    xgroup: vi.fn(async () => "OK"),
    xpending: vi.fn(async () => []),
    xclaim: vi.fn(async () => []),
    xlen: vi.fn(async () => 0),
    hset: vi.fn(async (key: string, ...kv: string[]) => {
      const h = hashes.get(key) ?? {};
      for (let i = 0; i < kv.length; i += 2) h[kv[i] as string] = kv[i + 1] as string;
      hashes.set(key, h);
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => hashes.get(key) ?? {}),
    del: vi.fn(async (key: string) => (hashes.delete(key) ? 1 : 0)),
    pexpire: vi.fn(async () => 1),
  };
}

type Internals = {
  router: { add(p: string, h: unknown): void };
  handlerKeys: Map<unknown, string>;
  processEntry(id: string, fields: string[], retry?: boolean): Promise<void>;
};

const fields = (type: string) => [
  "type",
  type,
  "data",
  JSON.stringify({
    type,
    payload: {},
    meta: { id: "e1", timestamp: new Date().toISOString() },
  } satisfies Partial<DomainEvent>),
];

function replica(
  redis: ReturnType<typeof sharedRedis>,
  handlers: Array<(e: DomainEvent) => Promise<void>>,
) {
  const t = new RedisStreamTransport(redis as never, { logger: silent });
  // Register as subscribe() would, without starting the poll loop.
    void (t as unknown as { subscribe(p: string, h: unknown): Promise<unknown> }).subscribe;
  const internals = t as unknown as Internals;
  for (const h of handlers) {
    internals.handlerKeys.set(h, `order:*#${h.name}`);
    internals.router.add("order:*", h);
  }
  return internals;
}

describe("RedisStreamTransport — per-handler progress across a retry", () => {
  it("a retry on another replica runs only the handler that failed; success clears the record", async () => {
    const redis = sharedRedis();
    const calls: string[] = [];
    let emailDown = true;

    // Replica A: billing succeeds, email fails.
    const billingA = async function billing() {
      calls.push("A:billing");
    };
    const emailA = async function email() {
      calls.push("A:email");
      if (emailDown) throw new Error("smtp down");
    };
    await replica(redis, [billingA, emailA]).processEntry("1-0", fields("order:created"));
    expect(redis.xack).not.toHaveBeenCalled();
    expect(Object.keys(redis.hashes.get("arc:events:handled:default:1-0") ?? {})).toEqual([
      "order:*#billing",
    ]);

    // Replica B claims the retry.
    emailDown = false;
    const billingB = async function billing() {
      calls.push("B:billing");
    };
    const emailB = async function email() {
      calls.push("B:email");
    };
    await replica(redis, [billingB, emailB]).processEntry("1-0", fields("order:created"), true);

    expect(calls).toEqual(["A:billing", "A:email", "B:email"]);
    expect(redis.xack).toHaveBeenCalledTimes(1);
    expect(redis.hashes.has("arc:events:handled:default:1-0")).toBe(false);
  });

  it("a first attempt that fully succeeds does no progress bookkeeping", async () => {
    const redis = sharedRedis();
    await replica(redis, [async function ok() {}]).processEntry("2-0", fields("order:created"));
    expect(redis.hgetall).not.toHaveBeenCalled();
    expect(redis.hset).not.toHaveBeenCalled();
    expect(redis.xack).toHaveBeenCalledTimes(1);
  });

  it("a client without hash commands warns at construction instead of silently re-running", () => {
    silent.warn.mockClear();
    const { hset: _h, hgetall: _g, del: _d, pexpire: _p, ...bare } = sharedRedis();
    new RedisStreamTransport(bare as never, { logger: silent });
    expect(silent.warn).toHaveBeenCalledWith(
      expect.stringContaining("re-runs handlers that already succeeded"),
    );
  });

  it("handler keys are stable and distinct for same-named handlers on one pattern", async () => {
    const t = new RedisStreamTransport(sharedRedis() as never, { logger: silent });
    const internals = t as unknown as Internals & { running: boolean };
    const a = async function h() {};
    const b = async function h() {};
    // subscribe() assigns keys; stop the poll loop it would start.
    internals.running = true;
    await t.subscribe("order:*", a);
    await t.subscribe("order:*", b);
    expect([internals.handlerKeys.get(a), internals.handlerKeys.get(b)]).toEqual([
      "order:*#h",
      "order:*#h#1",
    ]);
  });
});
