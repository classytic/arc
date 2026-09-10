/**
 * Every transport enters ONE work scope per delivered event, around the whole
 * handler set — so the per-request mechanisms (`requestScopedCache`, the memo
 * slot, correlation) work for a relay-driven or broker-driven dispatch exactly
 * as they do inside an HTTP request.
 *
 * The shared-cache assertion is the one that matters: N parallel handlers of
 * one event must resolve the SAME store, or a repository memo dedupes nothing
 * and every subscriber pays its own round trip — invisibly, because each read
 * still returns the right document.
 */
import { describe, expect, it, vi } from "vitest";
import { requestContext } from "../../src/context/requestContext.js";
import { requestScopedCache } from "../../src/context/requestScopedCache.js";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import type { DomainEvent } from "../../src/events/EventTransport.js";
import { RedisEventTransport } from "../../src/events/transports/redis.js";
import { RedisStreamTransport } from "../../src/events/transports/redis-stream.js";

const silent = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

function evt(meta: Partial<DomainEvent["meta"]> = {}): DomainEvent {
  return {
    type: "order:created",
    payload: { orderNumber: "ORD-1" },
    meta: { id: "e1", timestamp: new Date(), correlationId: "corr-1", organizationId: "org-1", ...meta },
  } as DomainEvent;
}

describe.each(["sequential", "parallel"] as const)("MemoryEventTransport (%s) work scope", (handlerDispatch) => {
  it("a handler published OUTSIDE a request runs inside an event scope", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch });
    let seen: ReturnType<typeof requestContext.get>;
    t.subscribe("order:*", async () => {
      seen = requestContext.get();
    });

    expect(requestContext.get()).toBeUndefined();
    await t.publish(evt());

    expect(seen?.kind).toBe("event");
    expect(seen?.requestId).toBe("corr-1");
    expect(seen?.organizationId).toBe("org-1");
  });

  it("ALL handlers of one event share ONE requestScopedCache()", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch });
    const stores: unknown[] = [];
    for (let i = 0; i < 3; i++) t.subscribe("order:*", async () => void stores.push(requestScopedCache()));

    await t.publish(evt());

    expect(stores).toHaveLength(3);
    expect(stores[0]).toBeDefined();
    expect(new Set(stores).size).toBe(1);
  });

  it("two publishes do NOT share a store", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch });
    const stores: unknown[] = [];
    t.subscribe("order:*", async () => void stores.push(requestScopedCache()));

    await t.publish(evt({ id: "e1", correlationId: "c1" }));
    await t.publish(evt({ id: "e2", correlationId: "c2" }));

    expect(stores[0]).not.toBe(stores[1]);
  });

  it("a publish INSIDE a request inherits the request's store (no shadowing)", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch });
    let inner: unknown;
    t.subscribe("order:*", async () => {
      inner = requestScopedCache();
    });

    await requestContext.run({ startTime: 1, requestId: "req-1", kind: "request" }, async () => {
      const outer = requestScopedCache();
      await t.publish(evt());
      expect(inner).toBe(outer);
      expect(requestContext.get()?.requestId).toBe("req-1");
    });
  });

  it("the scope ends with the publish — nothing leaks to the caller", async () => {
    const t = new MemoryEventTransport({ logger: silent, handlerDispatch });
    t.subscribe("order:*", async () => {});
    await t.publish(evt());
    expect(requestContext.get()).toBeUndefined();
  });
});

describe("RedisStreamTransport work scope", () => {
  function redisStub() {
    return {
      xadd: vi.fn(async () => "1-1"),
      xreadgroup: vi.fn(async () => null),
      xack: vi.fn(async () => 1),
      xgroup: vi.fn(async () => "OK"),
      xpending: vi.fn(async () => []),
      xclaim: vi.fn(async () => []),
      quit: vi.fn(async () => "OK"),
      disconnect: vi.fn(),
    };
  }
  type Internals = { processEntry(id: string, fields: string[]): Promise<void> };

  // The `order:*` pattern below is deliberate: the stream transport's private
  // matcher accepted only `prefix.*`, so a colon-glob subscription received
  // nothing. Matching now goes through primitives' `matchEventPattern`.
  it("a delivered entry's handlers run inside an event scope and share a store", async () => {
    const t = new RedisStreamTransport(redisStub() as never, { logger: silent });
    const stores: unknown[] = [];
    let kind: string | undefined;
    // Register directly — subscribe() would start the poll loop.
    const handlers = (t as unknown as { handlers: Map<string, Set<(e: DomainEvent) => Promise<void>>> }).handlers;
    handlers.set(
      "order:*",
      new Set([
        async () => {
          kind = requestContext.get()?.kind;
          stores.push(requestScopedCache());
        },
        async () => void stores.push(requestScopedCache()),
      ]),
    );

    await (t as unknown as Internals).processEntry("1-0", ["type", "order:created", "data", JSON.stringify(evt())]);

    expect(kind).toBe("event");
    expect(stores).toHaveLength(2);
    expect(stores[0]).toBeDefined();
    expect(stores[0]).toBe(stores[1]);
  });
});

describe("RedisEventTransport work scope", () => {
  it("a dispatched message's handler runs inside an event scope", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const sub = {
      on: (name: string, fn: (...args: unknown[]) => void) => void listeners.set(name, fn),
      subscribe: vi.fn(async () => 1),
      psubscribe: vi.fn(async () => 1),
      quit: vi.fn(async () => "OK"),
    };
    const redis = { publish: vi.fn(async () => 1), duplicate: () => sub, quit: vi.fn(async () => "OK") };
    const t = new RedisEventTransport(redis as never, { logger: silent });

    let seen: ReturnType<typeof requestContext.get>;
    const done = new Promise<void>((resolve) => {
      t.subscribe("order:created", async () => {
        seen = requestContext.get();
        resolve();
      });
    });
    await Promise.resolve();
    listeners.get("message")?.("arc-events:order:created", JSON.stringify(evt()));
    await done;

    expect(seen?.kind).toBe("event");
    expect(seen?.requestId).toBe("corr-1");
  });
});
