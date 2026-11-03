/**
 * `RedisEventTransport` while Redis is down: an app boots and a publisher retries instead of hanging.
 *
 * Before: `subscribe()` awaited Redis' SUBSCRIBE confirmation and `publish()` awaited PUBLISH. ioredis queues
 * both while it reconnects (forever with `maxRetriesPerRequest: null`), so a boot that subscribed at startup
 * never finished (the plugin timeout crashed it: FLOW OCC with Redis unreachable), and an outbox relay pass
 * hung on its first publish. Now a subscription that is not confirmed within `subscribeTimeoutMs` is
 * registered anyway and left queued (sent when Redis connects; later subscriptions do not wait while the
 * subscriber is down), and an unconfirmed publish rejects after `publishTimeoutMs` so the caller retries.
 */
import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { createEvent } from "../../src/events/EventTransport.js";
import {
  RedisEventTransport,
  type RedisLike,
  TRANSPORT_UNAVAILABLE,
} from "../../src/events/transports/redis.js";

/** A client whose commands stay pending until `connect()`, like ioredis' offline queue. */
function offlineClient() {
  const emitter = new EventEmitter();
  const queued: Array<() => void> = [];
  const pending = <T>(value: T) =>
    new Promise<T>((resolve) => {
      queued.push(() => resolve(value));
    });
  const sub = Object.assign(emitter, {
    publish: vi.fn(() => pending(1)),
    subscribe: vi.fn(() => pending(1)),
    psubscribe: vi.fn(() => pending(1)),
    duplicate: () => sub as unknown as RedisLike,
    quit: async () => "OK",
  });
  return {
    client: sub as unknown as RedisLike,
    queued,
    connect() {
      for (const send of queued.splice(0)) send();
      emitter.emit("ready");
    },
    deliver(channel: string, message: string) {
      emitter.emit("message", channel, message);
    },
  };
}

const logger = () => ({ warn: vi.fn(), error: vi.fn() });

describe("RedisEventTransport with Redis unavailable", () => {
  it("subscribe does not stall boot: bounded once, then no wait; one warning", async () => {
    const redis = offlineClient();
    const log = logger();
    const transport = new RedisEventTransport(redis.client, {
      subscribeTimeoutMs: 50,
      logger: log,
    });
    const started = Date.now();
    await transport.subscribe("order.created", () => {});
    for (let i = 0; i < 20; i++) await transport.subscribe(`order.e${i}`, () => {});
    expect(Date.now() - started).toBeLessThan(1_000); // ~50 ms, not 21 x 50 ms, not forever
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(redis.queued.length).toBe(21); // every SUBSCRIBE is queued for when Redis connects
  });

  it("handlers registered while down receive events once Redis connects", async () => {
    const redis = offlineClient();
    const transport = new RedisEventTransport(redis.client, {
      subscribeTimeoutMs: 20,
      logger: logger(),
    });
    const seen: string[] = [];
    await transport.subscribe("order.created", (e) => void seen.push(e.type));
    redis.connect();
    const event = createEvent("order.created", { id: 1 });
    redis.deliver("arc-events:order.created", JSON.stringify(event));
    expect(seen).toEqual(["order.created"]);
  });

  it("after the subscriber is ready again, a new subscription waits for its confirmation", async () => {
    const redis = offlineClient();
    const log = logger();
    const transport = new RedisEventTransport(redis.client, {
      subscribeTimeoutMs: 20,
      logger: log,
    });
    await transport.subscribe("a.one", () => {});
    redis.connect();
    let done = false;
    const second = transport
      .subscribe("a.two", () => {})
      .then(() => {
        done = true;
      });
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false); // waiting on Redis (healthy path), not skipped
    redis.connect();
    await second;
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("publish rejects after publishTimeoutMs instead of hanging (the outbox retries)", async () => {
    const redis = offlineClient();
    const transport = new RedisEventTransport(redis.client, {
      publishTimeoutMs: 50,
      logger: logger(),
    });
    const started = Date.now();
    await expect(transport.publish(createEvent("order.created", {}))).rejects.toMatchObject({
      message: expect.stringMatching(/not confirmed within 50 ms/),
      code: TRANSPORT_UNAVAILABLE, // an outbox failurePolicy retries it, never dead-letters it
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a real ioredis client against a closed port: subscribe returns, publish rejects", async () => {
    const client = new Redis("redis://127.0.0.1:6399/0", {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    client.on("error", () => {});
    const transport = new RedisEventTransport(client, {
      subscribeTimeoutMs: 100,
      publishTimeoutMs: 100,
      logger: logger(),
    });
    try {
      await transport.subscribe("order.*", () => {});
      await expect(transport.publish(createEvent("order.created", {}))).rejects.toThrow(
        /not confirmed/,
      );
    } finally {
      await transport.close().catch(() => {});
      client.disconnect();
    }
  });

  it("refuses a non-positive timeout", () => {
    const redis = offlineClient();
    expect(() => new RedisEventTransport(redis.client, { publishTimeoutMs: 0 })).toThrow(
      /publishTimeoutMs/,
    );
  });
});

describe("RedisEventTransport publish during an outage", () => {
  it("after one timeout, publishes fail at once until the client is ready again", async () => {
    const redis = offlineClient();
    const transport = new RedisEventTransport(redis.client, {
      publishTimeoutMs: 50,
      logger: logger(),
    });
    await expect(transport.publish(createEvent("a.one", {}))).rejects.toThrow(/not confirmed/);
    const started = Date.now();
    for (let i = 0; i < 10; i++)
      await expect(transport.publish(createEvent("a.two", {}))).rejects.toThrow(
        /Redis unavailable/,
      );
    expect(Date.now() - started).toBeLessThan(50);
    // Only the first (timed-out) publish ever reached the client; the refused ones never did.
    expect(redis.queued.length).toBe(1);
    redis.connect(); // flushes the queue and emits ready
    const sent = transport.publish(createEvent("a.three", {}));
    expect(redis.queued.length).toBe(1); // sent to Redis again
    redis.connect();
    await expect(sent).resolves.toBeUndefined();
  });
});
