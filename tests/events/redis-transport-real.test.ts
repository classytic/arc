/**
 * Real `RedisEventTransport` integration tests — passes a fake `RedisLike`
 * directly into `new RedisEventTransport(...)` instead of duplicating the
 * transport's logic in the test (which is what `redis-transport-mock.test.ts`
 * accidentally did pre-2.11.3).
 *
 * Catches real-class regressions: channel prefixing, listener attachment
 * idempotence, deserialization, dispatch routing, close lifecycle, and
 * the externalLifecycle opt-out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvent, type DomainEvent } from "../../src/events/EventTransport.js";
import { RedisEventTransport, type RedisLike } from "../../src/events/transports/redis.js";

// ---------- Fake RedisLike ----------
//
// Single in-process router that lets us reason about transport behaviour as
// if Redis were live. Subscriptions register handlers on the SUBSCRIBE side
// (the duplicate). The PUBLISH side calls into the same router so messages
// flow exactly as ioredis would deliver them.

interface FakeRedisHub {
  exact: Map<string, Set<(channel: string, message: string) => void>>;
  globs: Map<string, Set<(pattern: string, channel: string, message: string) => void>>;
}

function createHub(): FakeRedisHub {
  return { exact: new Map(), globs: new Map() };
}

function fakeRedisLike(hub: FakeRedisHub, role: "pub" | "sub" = "pub"): RedisLike {
  // Each Redis client maintains its own listener set keyed by event name —
  // mirrors ioredis's EventEmitter shape (`on('pmessage', ...)`,
  // `on('message', ...)` are independent slots).
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const client: RedisLike = {
    publish: vi.fn(async (channel: string, message: string) => {
      // Deliver to exact subscribers
      const exactSet = hub.exact.get(channel);
      if (exactSet) {
        for (const cb of exactSet) cb(channel, message);
      }
      // Deliver to glob subscribers
      for (const [pattern, set] of hub.globs) {
        if (matchGlob(pattern, channel)) {
          for (const cb of set) cb(pattern, channel, message);
        }
      }
      return 1;
    }),

    subscribe: vi.fn(async (...channels: string[]) => {
      for (const channel of channels) {
        if (!hub.exact.has(channel)) hub.exact.set(channel, new Set());
        // Use the listener attached via on('message'); fan into hub.
        const cb = (chan: string, msg: string) => {
          for (const handler of listeners.get("message") ?? []) handler(chan, msg);
        };
        hub.exact.get(channel)?.add(cb);
      }
      return undefined;
    }),

    psubscribe: vi.fn(async (...patterns: string[]) => {
      for (const pattern of patterns) {
        if (!hub.globs.has(pattern)) hub.globs.set(pattern, new Set());
        const cb = (p: string, chan: string, msg: string) => {
          for (const handler of listeners.get("pmessage") ?? []) handler(p, chan, msg);
        };
        hub.globs.get(pattern)?.add(cb);
      }
      return undefined;
    }),

    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
      return client;
    }),

    duplicate: vi.fn(() => fakeRedisLike(hub, "sub")),

    quit: vi.fn(async () => {
      // Mark closed — listeners won't fire after this; in real ioredis the
      // socket is gone. The test asserts quit() was called, not that
      // listeners are torn down (we leave the hub intact for inspection).
      void role; // tag captured for breakpoint inspection
      return "OK";
    }),
  };
  return client;
}

function matchGlob(pattern: string, channel: string): boolean {
  if (pattern === channel) return true;
  if (pattern === "*") return true;
  if (pattern.endsWith(":*")) return channel.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith(".*")) return channel.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith("*"))
    return channel.startsWith(pattern.slice(0, -1));
  return false;
}

// ============================================================================
// Tests
// ============================================================================

describe("RedisEventTransport — real class against a fake RedisLike", () => {
  let transport: RedisEventTransport | undefined;

  afterEach(async () => {
    if (transport) {
      await transport.close().catch(() => undefined);
      transport = undefined;
    }
  });

  it("publish writes JSON to `<channel>:<event.type>` (channel prefixing)", async () => {
    const hub = createHub();
    const pub = fakeRedisLike(hub, "pub");
    transport = new RedisEventTransport(pub, { channel: "myapp" });

    const event = createEvent("order.created", { id: "ord-1" });
    await transport.publish(event);

    // Channel = `${channel}:${type}` — `myapp:order.created`.
    expect(pub.publish).toHaveBeenCalledTimes(1);
    const [chan, raw] = (pub.publish as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chan).toBe("myapp:order.created");
    const parsed = JSON.parse(raw as string);
    expect(parsed.type).toBe("order.created");
    expect(parsed.payload).toEqual({ id: "ord-1" });
  });

  it("subscribe with literal pattern uses Redis SUBSCRIBE; subscribe with glob uses PSUBSCRIBE", async () => {
    const hub = createHub();
    const pub = fakeRedisLike(hub, "pub");
    transport = new RedisEventTransport(pub, { channel: "arc-events" });

    await transport.subscribe("order.created", vi.fn());
    await transport.subscribe("user.*", vi.fn());

    // Reach into the duplicate (sub) — subscribe(literal) → SUBSCRIBE,
    // subscribe(glob) → PSUBSCRIBE. The transport made the call for us.
    const sub = (pub.duplicate as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as RedisLike;
    expect((sub.subscribe as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "arc-events:order.created",
    );
    expect((sub.psubscribe as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "arc-events:user.*",
    );
  });

  it("delivers events to handlers, with Date revival on meta.timestamp", async () => {
    const hub = createHub();
    const pub = fakeRedisLike(hub, "pub");
    transport = new RedisEventTransport(pub, { channel: "arc-events" });

    const received: DomainEvent[] = [];
    await transport.subscribe("order.*", async (event) => {
      received.push(event);
    });

    const event = createEvent("order.shipped", { id: "ord-2" });
    await transport.publish(event);
    // Allow microtask queue to drain
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("order.shipped");
    // Timestamp arrives as a real Date, not the wire string.
    expect(received[0]?.meta.timestamp).toBeInstanceOf(Date);
  });

  it("attaches Redis 'pmessage' / 'message' listeners exactly once across N subscribes", async () => {
    const hub = createHub();
    const pub = fakeRedisLike(hub, "pub");
    transport = new RedisEventTransport(pub, { channel: "arc-events" });

    await transport.subscribe("a.*", vi.fn());
    await transport.subscribe("b.*", vi.fn());
    await transport.subscribe("c.*", vi.fn());

    const sub = (pub.duplicate as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as RedisLike;
    // pmessage attached ONCE — subsequent subscribes only call psubscribe().
    const onCalls = (sub.on as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "pmessage",
    );
    expect(onCalls).toHaveLength(1);
  });

  it("ignores malformed payloads on the wire (non-Arc publishers can share the channel)", async () => {
    const hub = createHub();
    const pub = fakeRedisLike(hub, "pub");
    transport = new RedisEventTransport(pub, { channel: "arc-events" });

    const handler = vi.fn();
    await transport.subscribe("bad.*", handler);

    // Inject a non-JSON message via the publisher path.
    await pub.publish("arc-events:bad.thing", "{ this is not json");
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).not.toHaveBeenCalled();
  });

  it("close() calls quit() on BOTH pub and sub by default (owns lifecycle)", async () => {
    const hub = createHub();
    const pub = fakeRedisLike(hub, "pub");
    transport = new RedisEventTransport(pub);

    const sub = (pub.duplicate as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as RedisLike;

    await transport.close();
    transport = undefined; // already closed

    expect((pub.quit as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((sub.quit as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("close() with externalLifecycle:true skips pub.quit() (host owns the publisher)", async () => {
    const hub = createHub();
    const pub = fakeRedisLike(hub, "pub");
    transport = new RedisEventTransport(pub, { externalLifecycle: true });

    const sub = (pub.duplicate as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as RedisLike;

    await transport.close();
    transport = undefined;

    // The sub duplicate is always quit (we created it). The pub is left alone.
    expect((sub.quit as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((pub.quit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("handler errors are logged and do NOT prevent siblings from firing", async () => {
    const hub = createHub();
    const pub = fakeRedisLike(hub, "pub");
    const errors: unknown[] = [];
    transport = new RedisEventTransport(pub, {
      channel: "arc-events",
      logger: {
        warn: vi.fn(),
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
    });

    const ok = vi.fn();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    await transport.subscribe("any.*", bad);
    await transport.subscribe("any.*", ok);

    await transport.publish(createEvent("any.thing", {}));
    await new Promise((r) => setTimeout(r, 0));

    expect(bad).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(errors.length).toBeGreaterThan(0);
  });
});
