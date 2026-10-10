/**
 * A partially failed stream message must not re-run the handlers that already completed it —
 * on retry, on ANY replica, only the handlers that have not finished run again.
 */
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "../../src/events/EventTransport.js";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import { withRetry } from "../../src/events/retry.js";
import { withSubscriberId } from "../../src/events/subscriberIdentity.js";
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
  it.each(["plain", "automatic retry", "explicit retry"])(
    "preserves named subscriber identities through eventPlugin with %s",
    async (mode) => {
      const redis = sharedRedis();
      const transport = new RedisStreamTransport(redis as never, {
        logger: silent,
        externalLifecycle: true,
      });
      const app = Fastify();
      try {
        await app.register(eventPlugin, {
          transport,
          retry: mode === "automatic retry" ? { maxRetries: 0 } : undefined,
        });
        const calls: string[] = [];
        async function ledger() {
          calls.push("ledger");
        }
        async function notify() {
          calls.push("notify");
        }
        const wrap =
          mode === "explicit retry"
            ? (handler: typeof ledger) => withRetry(handler, { maxRetries: 0 })
            : (handler: typeof ledger) => handler;
        await app.events.subscribe("order:*", wrap(ledger));
        await app.events.subscribe("order:*", wrap(notify));
        const internals = transport as unknown as Internals;
        expect([...internals.handlerKeys.values()]).toEqual(["order:*#ledger", "order:*#notify"]);
        await internals.processEntry("1-0", fields("order:created"));
        expect(calls).toEqual(["ledger", "notify"]);
      } finally {
        await app.close();
      }
    },
  );

  it("reordered anonymous subscribers retain their own completion records across replicas", async () => {
    const redis = sharedRedis();
    const calls: string[] = [];
    const first = new RedisStreamTransport(redis as never, { logger: silent });
    first.hold();
    await first.subscribe(
      "order:*",
      withSubscriberId("ledger", async () => {
        calls.push("ledger:A");
      }),
    );
    await first.subscribe(
      "order:*",
      withSubscriberId("notify", async () => {
        calls.push("notify:A");
        throw new Error("offline");
      }),
    );
    await (first as unknown as Internals).processEntry("1-0", fields("order:created"));
    const second = new RedisStreamTransport(redis as never, { logger: silent });
    second.hold();
    await second.subscribe(
      "order:*",
      withSubscriberId("notify", async () => {
        calls.push("notify:B");
      }),
    );
    await second.subscribe(
      "order:*",
      withSubscriberId("ledger", async () => {
        calls.push("ledger:B");
      }),
    );
    await (second as unknown as Internals).processEntry("1-0", fields("order:created"), true);
    expect(calls).toEqual(["ledger:A", "notify:A", "notify:B"]);
    expect(redis.xack).toHaveBeenCalledTimes(1);
  });

  it("allows a subscriber identity to be reinstalled after its last subscription is removed", async () => {
    const t = new RedisStreamTransport(sharedRedis() as never, { logger: silent });
    t.hold();
    const unsubscribe = await t.subscribe(
      "order:*",
      withSubscriberId("ledger", async () => {}),
    );
    unsubscribe();
    await expect(
      t.subscribe(
        "order:*",
        withSubscriberId("ledger", async () => {}),
      ),
    ).resolves.toBeTypeOf("function");
  });

  it("releases subscriber identities on close and ignores a stale unsubscribe", async () => {
    const redis = { ...sharedRedis(), quit: vi.fn(async () => "OK") };
    const t = new RedisStreamTransport(redis as never, { logger: silent, externalLifecycle: true });
    t.hold();
    const old = await t.subscribe(
      "order:*",
      withSubscriberId("ledger", async () => {}),
    );
    await t.close();
    await expect(
      t.subscribe(
        "order:*",
        withSubscriberId("ledger", async () => {}),
      ),
    ).resolves.toBeTypeOf("function");
    old();
    await expect(
      t.subscribe(
        "order:*",
        withSubscriberId("ledger", async () => {}),
      ),
    ).rejects.toThrow(/Ambiguous subscriber identity/);
  });
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

  it("refuses ambiguous implicit handler identities rather than assigning registration indexes", async () => {
    const t = new RedisStreamTransport(sharedRedis() as never, { logger: silent });
    const internals = t as unknown as Internals & { running: boolean };
    const a = async function h() {};
    const b = async function h() {};
    // subscribe() assigns keys; stop the poll loop it would start.
    internals.running = true;
    await t.subscribe("order:*", a);
    await expect(t.subscribe("order:*", b)).rejects.toThrow(/withSubscriberId/);
  });
});
