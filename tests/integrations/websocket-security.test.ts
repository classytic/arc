/**
 * WebSocket Security Tests
 *
 * Tests fail-closed auth, room authorization policy, message size caps,
 * and subscription limits.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { websocketPlugin } from "../../src/integrations/websocket.js";

// ============================================================================
// Helpers
// ============================================================================

function connectWs(
  port: number,
  path = "/ws",
): Promise<{ ws: WebSocket; connected: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Connection timeout"));
    }, 5000);

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "connected") {
        clearTimeout(timeout);
        resolve({ ws, connected: msg });
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function sendAndReceive(ws: WebSocket, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Response timeout")),
      3000,
    );
    ws.once("message", (raw) => {
      clearTimeout(timeout);
      resolve(JSON.parse(raw.toString()));
    });
    ws.send(JSON.stringify(payload));
  });
}

function getPort(app: FastifyInstance): number {
  return (app.server.address() as { port: number }).port;
}

// ============================================================================
// Fail-Closed Auth
// ============================================================================

describe("WebSocket fail-closed auth", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("throws when auth:true but no authenticate decorator and no custom auth", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);

    let threw = false;
    try {
      await app.register(websocketPlugin, { auth: true });
      await app.ready();
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("fastify.authenticate is not registered");
    }
    expect(threw).toBe(true);
  });

  it("auth:true with custom authenticate does not throw", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: true,
      authenticate: async () => ({ userId: "u1" }),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws, connected } = await connectWs(getPort(app));
    expect(connected.type).toBe("connected");
    ws.close();
  });

  it("auth:true with authenticate decorator does not throw", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    app.decorate("authenticate", async () => {});
    app.addHook("preHandler", async (request) => {
      (request as any).user = { id: "user-1" };
    });
    await app.register(websocketPlugin, { auth: true });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws, connected } = await connectWs(getPort(app));
    expect(connected.type).toBe("connected");
    ws.close();
  });
});

// ============================================================================
// Room Policy
// ============================================================================

describe("WebSocket room policy", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("roomPolicy denies subscription and returns error", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      roomPolicy: (_client, room) => room === "allowed",
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    const res = await sendAndReceive(ws, {
      type: "subscribe",
      resource: "forbidden",
    });
    expect(res.type).toBe("error");
    expect(res.error).toBe("Subscription denied");
    ws.close();
  });

  it("roomPolicy allows subscription", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      roomPolicy: (_client, room) => room === "allowed",
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    const res = await sendAndReceive(ws, {
      type: "subscribe",
      resource: "allowed",
    });
    expect(res.type).toBe("subscribed");
    expect(res.channel).toBe("allowed");
    ws.close();
  });

  it("async roomPolicy works", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      roomPolicy: async (_client, room) => {
        // Simulate async authorization check
        await new Promise((r) => setTimeout(r, 10));
        return room === "products";
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    const res = await sendAndReceive(ws, {
      type: "subscribe",
      resource: "products",
    });
    expect(res.type).toBe("subscribed");
    ws.close();
  });
});

// ============================================================================
// Subscription Limit
// ============================================================================

describe("WebSocket subscription limit", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("maxSubscriptionsPerClient exceeded returns error", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      maxSubscriptionsPerClient: 2,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));

    const r1 = await sendAndReceive(ws, { type: "subscribe", resource: "a" });
    expect(r1.type).toBe("subscribed");

    const r2 = await sendAndReceive(ws, { type: "subscribe", resource: "b" });
    expect(r2.type).toBe("subscribed");

    // Third subscription should be denied
    const r3 = await sendAndReceive(ws, { type: "subscribe", resource: "c" });
    expect(r3.type).toBe("error");
    expect(r3.error).toBe("Subscription limit reached");

    ws.close();
  });
});

// ============================================================================
// Message Size Cap
// ============================================================================

describe("WebSocket message size cap", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("oversized messages are rejected", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      maxMessageBytes: 50,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));

    // Send a message larger than 50 bytes
    const responsePromise = new Promise<any>((resolve) => {
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    const bigPayload = JSON.stringify({
      type: "subscribe",
      resource: "a".repeat(100),
    });
    ws.send(bigPayload);

    const res = await responsePromise;
    expect(res.type).toBe("error");
    expect(res.error).toBe("Message too large");

    ws.close();
  });

  it("messages within size limit are processed normally", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      maxMessageBytes: 1024,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    const res = await sendAndReceive(ws, {
      type: "subscribe",
      resource: "products",
    });
    expect(res.type).toBe("subscribed");

    ws.close();
  });
});
