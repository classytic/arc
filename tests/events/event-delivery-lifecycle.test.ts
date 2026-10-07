/**
 * Delivery is never decided by boot order or by a telemetry callback:
 *   - a stream consumer is held for the whole boot and started once every handler exists;
 *   - a throwing onPublish / onPublishError never changes a publish's outcome.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import { RedisStreamTransport } from "../../src/events/transports/redis-stream.js";

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function streamRedis() {
  return {
    xadd: vi.fn(async () => "1-1"),
    xreadgroup: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return null;
    }),
    xack: vi.fn(async () => 1),
    xgroup: vi.fn(async () => "OK"),
    xpending: vi.fn(async () => []),
    xclaim: vi.fn(async () => []),
    xlen: vi.fn(async () => 0),
    hset: vi.fn(async () => 1),
    hgetall: vi.fn(async () => ({})),
    del: vi.fn(async () => 1),
    pexpire: vi.fn(async () => 1),
    quit: vi.fn(async () => "OK"),
    disconnect: vi.fn(() => {}),
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});

describe("a held stream consumer reads nothing until start()", () => {
  it("subscribe while held registers the handler but creates no group and reads no entry", async () => {
    const redis = streamRedis();
    const t = new RedisStreamTransport(redis as never, { logger: silent });
    t.hold();
    await t.subscribe("order:*", async () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(redis.xgroup).not.toHaveBeenCalled();
    expect(redis.xreadgroup).not.toHaveBeenCalled();

    await t.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(redis.xreadgroup).toHaveBeenCalled();
    await t.close();
  });

  it("arc holds the transport through boot and starts it on ready", async () => {
    const redis = streamRedis();
    const transport = new RedisStreamTransport(redis as never, { logger: silent });
    app = Fastify({ logger: false });
    await app.register(eventPlugin, { transport });
    // A module subscribing during boot must not open consumption.
    await app.events.subscribe("order:*", async () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(redis.xreadgroup).not.toHaveBeenCalled();

    await app.ready();
    await new Promise((r) => setTimeout(r, 20));
    expect(redis.xreadgroup).toHaveBeenCalled();
    await transport.close();
  });
});

describe("telemetry callbacks never change delivery", () => {
  it("a throwing onPublish: the event was delivered, so publish succeeds", async () => {
    const received: string[] = [];
    app = Fastify({ logger: false });
    await app.register(eventPlugin, {
      transport: new MemoryEventTransport(),
      failOpen: false,
      onPublish: () => {
        throw new Error("metrics down");
      },
    });
    await app.events.subscribe("x.*", async (e) => {
      received.push(e.type);
    });
    await expect(app.events.publish("x.created", { id: "1" })).resolves.toBeUndefined();
    expect(received).toEqual(["x.created"]);
  });

  it("a throwing onPublishError does not escape fail-open", async () => {
    const failing = new MemoryEventTransport();
    failing.publish = async () => {
      throw new Error("broker down");
    };
    app = Fastify({ logger: false });
    await app.register(eventPlugin, {
      transport: failing,
      failOpen: true,
      onPublishError: () => {
        throw new Error("alerting down");
      },
    });
    await expect(app.events.publish("x.created", { id: "1" })).resolves.toBeUndefined();
  });
});
