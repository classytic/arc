/**
 * Dual-mode smoke — proves the websocket plugin works:
 *
 *   1. WITHOUT any external dependencies (single-dep install of arc) —
 *      the default `MemoryPushRefStore` covers single-instance hosts.
 *
 *   2. WITH the Redis-backed store wired in — `RedisPushRefStore` from
 *      the optional subpath survives cross-node reconnects.
 *
 * Mode is selected by environment, in priority order:
 *   - `ARC_WS_SMOKE_REDIS_URL`  (explicit override, e.g. local docker)
 *   - `UPSTASH_REDIS_URL`       (the shared dev Upstash endpoint —
 *                                same `.env` key the e2e suite uses,
 *                                via dotenv/config)
 *
 * When neither is set, the Redis-mode tests skip — proving arc's
 * smoke path never assumes Redis is installed. When either is set,
 * the Redis tests run against the live broker.
 *
 * Designed to finish in <500 ms on the Memory path (no real Redis I/O)
 * so it can run as a pre-commit gate. The Upstash path adds network
 * latency but still completes in <5 s for the two regressions.
 */

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { websocketPlugin } from "../../../src/integrations/websocket.js";

const REDIS_URL = process.env.ARC_WS_SMOKE_REDIS_URL ?? process.env.UPSTASH_REDIS_URL;

function getPort(app: FastifyInstance): number {
  return (app.server.address() as { port: number }).port;
}

function nextMessage(ws: WebSocket, timeoutMs = 1500): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("smoke: message timeout")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(t);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

// ============================================================================
// Mode A — Memory store (default; no Redis dep)
// ============================================================================

describe("smoke / Memory store (single-dep arc install)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("boots and accepts a connection with no pushRefStore option", async () => {
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, {
      auth: false,
      heartbeatInterval: 0,
      messageEnvelope: "seq",
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws = new WebSocket(`ws://127.0.0.1:${getPort(app)}/ws`);
    const connected = await nextMessage(ws);
    expect(connected.type).toBe("connected");
    expect(typeof connected.pushRef).toBe("string");
    expect(connected.envelope).toBe("seq");
    ws.close();
  });

  it("supports the full RESUME flow without any external store", async () => {
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, {
      auth: false,
      heartbeatInterval: 0,
      messageEnvelope: "seq",
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(app);

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const conn = (await nextMessage(ws1)) as { pushRef: string };
    const wsApi = (app as unknown as { ws: { send: (t: object, d: unknown) => void } }).ws;

    wsApi.send({ pushRef: conn.pushRef }, { n: 1 });
    const first = await nextMessage(ws1);
    expect(first.seq).toBe(1);

    ws1.terminate();
    await new Promise((r) => setTimeout(r, 30));
    wsApi.send({ pushRef: conn.pushRef }, { n: 2 });

    // Continuous message collector — `once` between sends would lose
    // any message that arrives in the gap between handlers attaching.
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?pushRef=${conn.pushRef}`);
    const inbox: Record<string, unknown>[] = [];
    ws2.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
    await new Promise<void>((r) => ws2.once("open", () => r()));
    // Allow connected + initial server flush to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(inbox.find((m) => m.type === "connected")?.resumed).toBe(true);

    ws2.send(JSON.stringify({ type: "resume", lastSeq: 1 }));
    await new Promise((r) => setTimeout(r, 100));

    expect(inbox.some((m) => m.seq === 2)).toBe(true);
    expect(inbox.some((m) => m.type === "resumed")).toBe(true);
    ws2.close();
  });
});

// ============================================================================
// Mode B — Redis store (opt-in; only runs when ARC_WS_SMOKE_REDIS_URL is set)
// ============================================================================

describe.skipIf(!REDIS_URL)("smoke / Redis store (cross-node)", () => {
  let app: FastifyInstance;
  let redisClient: { quit(): Promise<unknown> } | undefined;
  // Per-suite unique prefix so concurrent runs against the shared
  // Upstash endpoint never collide. Auto-cleaned by Redis PEXPIRE.
  const keyPrefix = `arc:smoke:${process.pid}:${Date.now()}:`;

  /**
   * ioredis tuned for Upstash — same shape as `tests/e2e/upstash-redis-e2e.test.ts`.
   * `maxRetriesPerRequest: null` and `enableReadyCheck: false` are required by
   * BullMQ / serverless Redis providers; for our case they also bound first-
   * connection latency so the suite doesn't hang behind a TLS handshake.
   */
  async function makeRedis(): Promise<{ quit(): Promise<unknown> }> {
    const { default: IORedis } = (await import("ioredis")) as {
      default: new (
        url: string,
        opts: { maxRetriesPerRequest: null; enableReadyCheck: false; lazyConnect: false },
      ) => { quit(): Promise<unknown> };
    };
    return new IORedis(REDIS_URL as string, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
    });
  }

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
    try {
      await redisClient?.quit();
    } catch {}
  });

  it("boots with RedisPushRefStore wired and accepts a connection", async () => {
    const { RedisPushRefStore } = await import(
      "../../../src/integrations/websocket-pushref-redis.js"
    );

    redisClient = await makeRedis();
    const store = new RedisPushRefStore(redisClient as never, { keyPrefix });

    app = Fastify({ logger: false });
    await app.register(websocketPlugin, {
      auth: false,
      heartbeatInterval: 0,
      messageEnvelope: "seq",
      pushRefStore: store,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws = new WebSocket(`ws://127.0.0.1:${getPort(app)}/ws`);
    const connected = await nextMessage(ws, 5000);
    expect(connected.type).toBe("connected");
    expect(connected.envelope).toBe("seq");
    ws.close();
  });

  it("envelope state in Redis survives a full plugin teardown + restart", async () => {
    const { RedisPushRefStore } = await import(
      "../../../src/integrations/websocket-pushref-redis.js"
    );

    redisClient = await makeRedis();
    const store1 = new RedisPushRefStore(redisClient as never, { keyPrefix });

    // Boot app A, claim pushRef, write envelope, shut down.
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, {
      auth: false,
      heartbeatInterval: 0,
      messageEnvelope: "seq",
      pushRefStore: store1,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws1 = new WebSocket(`ws://127.0.0.1:${getPort(app)}/ws`);
    const conn1 = (await nextMessage(ws1, 5000)) as { pushRef: string };
    const wsApi = (app as unknown as { ws: { send: (t: object, d: unknown) => void } }).ws;
    wsApi.send({ pushRef: conn1.pushRef }, { n: 1 });
    await nextMessage(ws1, 5000); // drain envelope
    ws1.terminate();
    await new Promise((r) => setTimeout(r, 100));
    await app.close();

    // Boot app B (new plugin instance, same Redis prefix) — reconnect
    // with the same pushRef. The dead queue from app A must replay.
    const store2 = new RedisPushRefStore(redisClient as never, { keyPrefix });
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, {
      auth: false,
      heartbeatInterval: 0,
      messageEnvelope: "seq",
      pushRefStore: store2,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws2 = new WebSocket(`ws://127.0.0.1:${getPort(app)}/ws?pushRef=${conn1.pushRef}`);
    const conn2 = await nextMessage(ws2, 5000);
    expect(conn2.resumed).toBe(true);
    ws2.close();
  });
});
