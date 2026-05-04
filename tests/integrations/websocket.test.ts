/**
 * WebSocket Integration Tests
 *
 * Tests the Arc WebSocket plugin: auth enforcement, room management,
 * message handling, stats endpoint gating, heartbeat, and cleanup.
 *
 * WebSocket upgrade bypasses Fastify's inject(), so tests that need
 * real connections use app.listen({ port: 0 }) + ws client.
 */

import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { RoomManager, websocketPlugin } from "../../src/integrations/websocket.js";

// ============================================================================
// Helpers
// ============================================================================

function mockSocket() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 };
}

/** Connect a WS client and wait for the "connected" message. */
function connectWs(port: number, path = "/ws"): Promise<{ ws: WebSocket; connected: any }> {
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

/** Send a message and wait for the next response. */
function sendAndReceive(ws: WebSocket, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Response timeout")), 3000);
    ws.once("message", (raw) => {
      clearTimeout(timeout);
      resolve(JSON.parse(raw.toString()));
    });
    ws.send(JSON.stringify(payload));
  });
}

/** Collect messages from a ws within a timeout period. */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<any[]> {
  return new Promise((resolve) => {
    const msgs: any[] = [];
    const timeout = setTimeout(() => resolve(msgs), timeoutMs);
    const handler = (raw: Buffer | string) => {
      msgs.push(JSON.parse(raw.toString()));
      if (msgs.length >= count) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve(msgs);
      }
    };
    ws.on("message", handler);
  });
}

/** Wait for a close event on a WebSocket. */
function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Get a random available port by starting and immediately getting the address. */
function getPort(app: FastifyInstance): number {
  return (app.server.address() as { port: number }).port;
}

// ============================================================================
// RoomManager Unit Tests
// ============================================================================

describe("RoomManager", () => {
  it("addClient + getClient round-trips", () => {
    const rm = new RoomManager();
    const client = {
      id: "c1",
      socket: mockSocket(),
      subscriptions: new Set<string>(),
    };
    rm.addClient(client);
    expect(rm.getClient("c1")).toBe(client);
  });

  it("removeClient cleans up all subscriptions", () => {
    const rm = new RoomManager();
    const client = {
      id: "c1",
      socket: mockSocket(),
      subscriptions: new Set<string>(),
    };
    rm.addClient(client);
    rm.subscribe("c1", "room-a");
    rm.subscribe("c1", "room-b");
    rm.removeClient("c1");
    expect(rm.getClient("c1")).toBeUndefined();
    expect(rm.getStats().rooms).toBe(0);
  });

  it("subscribe respects maxClientsPerRoom", () => {
    const rm = new RoomManager(2);
    for (let i = 0; i < 3; i++) {
      rm.addClient({
        id: `c${i}`,
        socket: mockSocket(),
        subscriptions: new Set<string>(),
      });
    }
    expect(rm.subscribe("c0", "room")).toBe(true);
    expect(rm.subscribe("c1", "room")).toBe(true);
    expect(rm.subscribe("c2", "room")).toBe(false);
  });

  it("subscribe returns false for unknown client", () => {
    const rm = new RoomManager();
    expect(rm.subscribe("unknown", "room")).toBe(false);
  });

  it("unsubscribe removes client from room and cleans up empty rooms", () => {
    const rm = new RoomManager();
    const client = {
      id: "c1",
      socket: mockSocket(),
      subscriptions: new Set<string>(),
    };
    rm.addClient(client);
    rm.subscribe("c1", "room");
    rm.unsubscribe("c1", "room");
    expect(rm.getStats().rooms).toBe(0);
    expect(client.subscriptions.size).toBe(0);
  });

  it("broadcast sends to subscribed clients, skips excluded", () => {
    const rm = new RoomManager();
    const s1 = mockSocket();
    const s2 = mockSocket();
    rm.addClient({ id: "c1", socket: s1, subscriptions: new Set() });
    rm.addClient({ id: "c2", socket: s2, subscriptions: new Set() });
    rm.subscribe("c1", "room");
    rm.subscribe("c2", "room");
    rm.broadcast("room", '{"test":1}', "c1");
    expect(s1.send).not.toHaveBeenCalled();
    expect(s2.send).toHaveBeenCalledWith('{"test":1}');
  });

  it("broadcastToOrg only sends to clients in the matching org", () => {
    const rm = new RoomManager();
    const s1 = mockSocket();
    const s2 = mockSocket();
    rm.addClient({
      id: "c1",
      socket: s1,
      subscriptions: new Set(),
      organizationId: "org-a",
    });
    rm.addClient({
      id: "c2",
      socket: s2,
      subscriptions: new Set(),
      organizationId: "org-b",
    });
    rm.subscribe("c1", "room");
    rm.subscribe("c2", "room");
    rm.broadcastToOrg("org-a", "room", '{"x":1}');
    expect(s1.send).toHaveBeenCalled();
    expect(s2.send).not.toHaveBeenCalled();
  });

  it("getStats returns correct counts", () => {
    const rm = new RoomManager();
    rm.addClient({
      id: "c1",
      socket: mockSocket(),
      subscriptions: new Set(),
    });
    rm.addClient({
      id: "c2",
      socket: mockSocket(),
      subscriptions: new Set(),
    });
    rm.subscribe("c1", "products");
    rm.subscribe("c2", "products");
    rm.subscribe("c1", "orders");
    expect(rm.getStats()).toEqual({
      clients: 2,
      rooms: 2,
      subscriptions: { products: 2, orders: 1 },
    });
  });

  it("broadcast silently handles send errors", () => {
    const rm = new RoomManager();
    const badSocket = mockSocket();
    badSocket.send = vi.fn(() => {
      throw new Error("broken pipe");
    });
    rm.addClient({ id: "c1", socket: badSocket, subscriptions: new Set() });
    rm.subscribe("c1", "room");
    expect(() => rm.broadcast("room", "msg")).not.toThrow();
  });

  it("broadcast skips clients with readyState !== 1", () => {
    const rm = new RoomManager();
    const s = mockSocket();
    s.readyState = 0;
    rm.addClient({ id: "c1", socket: s, subscriptions: new Set() });
    rm.subscribe("c1", "room");
    rm.broadcast("room", "msg");
    expect(s.send).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Plugin Registration
// ============================================================================

describe("Plugin registration", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("decorates fastify with ws.rooms, ws.broadcast, ws.getStats", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, { auth: false });
    await app.ready();

    const ws = (app as any).ws;
    expect(ws).toBeDefined();
    expect(ws.rooms).toBeInstanceOf(RoomManager);
    expect(typeof ws.broadcast).toBe("function");
    expect(typeof ws.broadcastToOrg).toBe("function");
    expect(typeof ws.getStats).toBe("function");
  });
});

// ============================================================================
// Auth Enforcement
// ============================================================================

describe("Auth enforcement", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("auth:true rejects connections when request.user is absent", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    // Provide authenticate decorator so registration passes (fail-closed check)
    app.decorate("authenticate", async () => {});
    await app.register(websocketPlugin, { auth: true });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws = new WebSocket(`ws://127.0.0.1:${getPort(app)}/ws`);
    const close = await waitForClose(ws);
    expect(close.code).toBe(4001);
    expect(close.reason).toBe("Unauthorized");
  });

  it("auth:false allows unauthenticated connections", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, { auth: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws, connected } = await connectWs(getPort(app));
    expect(connected.type).toBe("connected");
    expect(connected.clientId).toBeDefined();
    ws.close();
  });

  it("customAuth returning null rejects the connection", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: true,
      authenticate: async () => null,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const ws = new WebSocket(`ws://127.0.0.1:${getPort(app)}/ws`);
    const close = await waitForClose(ws);
    expect(close.code).toBe(4001);
  });

  it("customAuth returning userId populates client identity", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: true,
      authenticate: async () => ({ userId: "u1", organizationId: "org-1" }),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws, connected } = await connectWs(getPort(app));
    expect(connected.type).toBe("connected");
    ws.close();
  });

  it("auth:true with request.user populated allows connection", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    // Provide authenticate decorator so registration passes (fail-closed check)
    app.decorate("authenticate", async () => {});
    // Simulate upstream auth middleware
    app.addHook("preHandler", async (request) => {
      (request as any).user = { id: "user-123" };
      (request as any).scope = { organizationId: "org-abc" };
    });
    await app.register(websocketPlugin, { auth: true });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws, connected } = await connectWs(getPort(app));
    expect(connected.type).toBe("connected");
    ws.close();
  });
});

// ============================================================================
// Message Handling
// ============================================================================

describe("Message handling", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("subscribe returns subscribed confirmation", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, { auth: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    const res = await sendAndReceive(ws, {
      type: "subscribe",
      resource: "products",
    });
    expect(res).toEqual({ type: "subscribed", channel: "products" });
    ws.close();
  });

  it("subscribe via channel field works", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, { auth: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    const res = await sendAndReceive(ws, {
      type: "subscribe",
      channel: "orders",
    });
    expect(res).toEqual({ type: "subscribed", channel: "orders" });
    ws.close();
  });

  it("unsubscribe returns unsubscribed confirmation", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, { auth: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    await sendAndReceive(ws, { type: "subscribe", resource: "products" });
    const res = await sendAndReceive(ws, {
      type: "unsubscribe",
      resource: "products",
    });
    expect(res).toEqual({ type: "unsubscribed", channel: "products" });
    ws.close();
  });

  it("invalid JSON returns error message", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, { auth: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    const responsePromise = new Promise<any>((resolve) => {
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    ws.send("not-json{{{");
    const res = await responsePromise;
    expect(res).toEqual({ type: "error", error: "Invalid message format" });
    ws.close();
  });

  it("custom onMessage handler receives unknown message types", async () => {
    const onMessage = vi.fn();
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, { auth: false, onMessage });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    ws.send(JSON.stringify({ type: "custom-action", data: { foo: "bar" } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][1]).toEqual({
      type: "custom-action",
      data: { foo: "bar" },
    });
    ws.close();
  });

  it("subscribe at room capacity returns error", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      maxClientsPerRoom: 1,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws: ws1 } = await connectWs(getPort(app));
    const res1 = await sendAndReceive(ws1, {
      type: "subscribe",
      resource: "products",
    });
    expect(res1.type).toBe("subscribed");

    const { ws: ws2 } = await connectWs(getPort(app));
    const res2 = await sendAndReceive(ws2, {
      type: "subscribe",
      resource: "products",
    });
    expect(res2.type).toBe("error");
    expect(res2.error).toBe("Room at capacity");

    ws1.close();
    ws2.close();
  });
});

// ============================================================================
// Heartbeat
// ============================================================================

describe("Heartbeat", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("sends ping messages at configured interval", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      heartbeatInterval: 100,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    const msgs = await collectMessages(ws, 3, 350);
    const pings = msgs.filter((m) => m.type === "ping");
    expect(pings.length).toBeGreaterThanOrEqual(2);
    expect(pings[0].timestamp).toBeDefined();
    ws.close();
  });

  it("heartbeatInterval: 0 disables heartbeat", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      heartbeatInterval: 0,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    const msgs = await collectMessages(ws, 1, 300);
    const pings = msgs.filter((m) => m.type === "ping");
    expect(pings.length).toBe(0);
    ws.close();
  });
});

// ============================================================================
// Stats Endpoint
// ============================================================================

describe("Stats endpoint", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("exposeStats: false (default) does not register /ws/stats", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, { auth: false });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/ws/stats" });
    expect(res.statusCode).toBe(404);
  });

  it("exposeStats: true registers an unauthenticated /ws/stats", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      exposeStats: true,
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/ws/stats" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // No-envelope: stats payload emitted raw at the top level.
    expect(body).toEqual({ clients: 0, rooms: 0, subscriptions: {} });
  });

  it("exposeStats: 'authenticated' adds preHandler when fastify.authenticate exists", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);

    // Simulate an auth decorator
    app.decorate("authenticate", async (request: any, reply: any) => {
      if (!request.headers.authorization) {
        reply.code(401).send({ error: "Unauthorized" });
      }
    });

    await app.register(websocketPlugin, {
      auth: false,
      exposeStats: "authenticated",
    });
    await app.ready();

    // Without auth header -> 401
    const noAuth = await app.inject({ method: "GET", url: "/ws/stats" });
    expect(noAuth.statusCode).toBe(401);

    // With auth header -> 200
    const withAuth = await app.inject({
      method: "GET",
      url: "/ws/stats",
      headers: { authorization: "Bearer test" },
    });
    expect(withAuth.statusCode).toBe(200);
  });

  it("exposeStats: 'authenticated' without fastify.authenticate skips endpoint", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    // No authenticate decorator registered
    await app.register(websocketPlugin, {
      auth: false,
      exposeStats: "authenticated",
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/ws/stats" });
    expect(res.statusCode).toBe(404);
  });

  it("stats reflect connected clients and subscriptions", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      exposeStats: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    await sendAndReceive(ws, { type: "subscribe", resource: "products" });

    const res = await app.inject({ method: "GET", url: "/ws/stats" });
    const body = JSON.parse(res.body);
    expect(body.clients).toBe(1);
    expect(body.rooms).toBe(1);
    expect(body.subscriptions.products).toBe(1);

    ws.close();
  });
});

// ============================================================================
// Client Cleanup
// ============================================================================

describe("Client cleanup", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("removing client on disconnect cleans up stats", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      exposeStats: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    await sendAndReceive(ws, { type: "subscribe", resource: "products" });

    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    const res = await app.inject({ method: "GET", url: "/ws/stats" });
    const body = JSON.parse(res.body);
    expect(body.clients).toBe(0);
    expect(body.rooms).toBe(0);
  });

  it("onConnect and onDisconnect callbacks are invoked", async () => {
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();

    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      auth: false,
      onConnect,
      onDisconnect,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    expect(onConnect).toHaveBeenCalledOnce();

    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// Broadcast via Decorator
// ============================================================================

describe("Broadcast via fastify.ws decorator", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("ws.broadcast sends to subscribed clients", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, { auth: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));
    await sendAndReceive(ws, { type: "subscribe", resource: "products" });

    const msgPromise = new Promise<any>((resolve) => {
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    (app as any).ws.broadcast("products", {
      action: "created",
      id: "123",
    });
    const msg = await msgPromise;
    expect(msg.type).toBe("broadcast");
    expect(msg.channel).toBe("products");
    expect(msg.data).toEqual({ action: "created", id: "123" });
    ws.close();
  });
});

// ============================================================================
// Custom Path
// ============================================================================

describe("Custom path", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("registers WebSocket at custom path", async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(websocketPlugin, {
      path: "/api/realtime",
      auth: false,
      exposeStats: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws, connected } = await connectWs(getPort(app), "/api/realtime");
    expect(connected.type).toBe("connected");
    ws.close();

    // Stats at custom path
    const res = await app.inject({
      method: "GET",
      url: "/api/realtime/stats",
    });
    expect(res.statusCode).toBe(200);
  });
});
