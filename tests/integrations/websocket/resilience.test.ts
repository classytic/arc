/**
 * Direct coverage for the three resilience branches added in the post-2.17.1
 * WebSocket hardening pass:
 *
 *   1. RoomManager — `bufferedAmount` backpressure skip (room-manager.ts).
 *   2. Connection — heartbeat liveness close after MISSED_PINGS_LIMIT
 *      unanswered pings (connection.ts).
 *   3. Plugin    — standalone auto-registration of @fastify/websocket when
 *      the host hasn't registered it yet (plugin.ts).
 *
 * The pre-existing websocket tests exercise these paths indirectly; this
 * file pins each new branch to a dedicated assertion so a regression can
 * never sneak past green tests again.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { RoomManager, websocketPlugin } from "../../../src/integrations/websocket.js";

function mockSocket(overrides: Partial<{ bufferedAmount: number; readyState: number }> = {}) {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: overrides.readyState ?? 1,
    bufferedAmount: overrides.bufferedAmount ?? 0,
  };
}

function getPort(app: FastifyInstance): number {
  return (app.server.address() as { port: number }).port;
}

// ============================================================================
// 0. RoomManager — pushRef + userId indexes & stale-connection close guard
// ============================================================================

describe("RoomManager — pushRef + userId indexes", () => {
  it("resolves a client by pushRef (session-level lookup)", () => {
    const rm = new RoomManager();
    rm.addClient({
      id: "c1",
      pushRef: "tab-A",
      socket: mockSocket(),
      subscriptions: new Set(),
    });
    expect(rm.getClientByPushRef("tab-A")?.id).toBe("c1");
    expect(rm.getClientByPushRef("nope")).toBeUndefined();
  });

  it("indexes multiple connections per user (same user, many tabs)", () => {
    const rm = new RoomManager();
    rm.addClient({
      id: "c1",
      pushRef: "tab-A",
      socket: mockSocket(),
      subscriptions: new Set(),
      userId: "u1",
    });
    rm.addClient({
      id: "c2",
      pushRef: "tab-B",
      socket: mockSocket(),
      subscriptions: new Set(),
      userId: "u1",
    });
    rm.addClient({
      id: "c3",
      pushRef: "tab-C",
      socket: mockSocket(),
      subscriptions: new Set(),
      userId: "u2",
    });
    expect(
      rm
        .getClientsByUserId("u1")
        .map((c) => c.id)
        .sort(),
    ).toEqual(["c1", "c2"]);
    expect(rm.getClientsByUserId("u2").map((c) => c.id)).toEqual(["c3"]);
    expect(rm.getClientsByUserId("u-unknown")).toEqual([]);
  });

  it("close-guard: reconnect with same pushRef does not evict the new connection", () => {
    // Scenario: old socket closes AFTER a new one with the same pushRef
    // has registered. The old close handler must not delete the new
    // entry. This is the n8n websocket.push.ts:63 invariant.
    const rm = new RoomManager();
    rm.addClient({
      id: "old",
      pushRef: "tab-X",
      socket: mockSocket(),
      subscriptions: new Set(),
      userId: "u1",
    });
    // Newer reconnect — same pushRef + userId, new clientId
    rm.addClient({
      id: "new",
      pushRef: "tab-X",
      socket: mockSocket(),
      subscriptions: new Set(),
      userId: "u1",
    });
    // Old socket's late close fires now
    rm.removeClient("old");

    // New connection survived
    expect(rm.getClient("new")).toBeDefined();
    expect(rm.getClientByPushRef("tab-X")?.id).toBe("new");
    expect(rm.getClientsByUserId("u1").map((c) => c.id)).toEqual(["new"]);
  });
});

// ============================================================================
// 1. RoomManager — bufferedAmount backpressure
// ============================================================================

describe("RoomManager — backpressure skip", () => {
  // 256 KB is the hard-coded WS_BACKPRESSURE_LIMIT in room-manager.ts.
  const OVER_LIMIT = 256 * 1024 + 1;
  const UNDER_LIMIT = 256 * 1024 - 1;

  it("broadcast skips clients whose bufferedAmount exceeds the limit", () => {
    const rm = new RoomManager();
    const slow = mockSocket({ bufferedAmount: OVER_LIMIT });
    const fast = mockSocket({ bufferedAmount: 0 });
    rm.addClient({ id: "slow", socket: slow, subscriptions: new Set() });
    rm.addClient({ id: "fast", socket: fast, subscriptions: new Set() });
    rm.subscribe("slow", "room");
    rm.subscribe("fast", "room");

    rm.broadcast("room", "payload");

    expect(slow.send).not.toHaveBeenCalled();
    expect(fast.send).toHaveBeenCalledWith("payload");
  });

  it("broadcast still delivers when bufferedAmount is exactly at the threshold boundary", () => {
    const rm = new RoomManager();
    const edge = mockSocket({ bufferedAmount: UNDER_LIMIT });
    rm.addClient({ id: "edge", socket: edge, subscriptions: new Set() });
    rm.subscribe("edge", "room");

    rm.broadcast("room", "payload");

    expect(edge.send).toHaveBeenCalledWith("payload");
  });

  it("broadcastToOrg skips saturated clients in the matching org", () => {
    const rm = new RoomManager();
    const slow = mockSocket({ bufferedAmount: OVER_LIMIT });
    const fast = mockSocket({ bufferedAmount: 0 });
    rm.addClient({
      id: "slow",
      socket: slow,
      subscriptions: new Set(),
      organizationId: "org-a",
    });
    rm.addClient({
      id: "fast",
      socket: fast,
      subscriptions: new Set(),
      organizationId: "org-a",
    });
    rm.subscribe("slow", "room");
    rm.subscribe("fast", "room");

    rm.broadcastToOrg("org-a", "room", "payload");

    expect(slow.send).not.toHaveBeenCalled();
    expect(fast.send).toHaveBeenCalledWith("payload");
  });

  it("broadcast evicts clients whose send() throws (dead-socket cleanup)", () => {
    const rm = new RoomManager();
    const dead = mockSocket();
    dead.send = vi.fn(() => {
      throw new Error("broken pipe");
    });
    rm.addClient({ id: "dead", socket: dead, subscriptions: new Set() });
    rm.subscribe("dead", "room");

    rm.broadcast("room", "payload");

    // After a failing send, the client is purged from the manager so the
    // next broadcast skips it without re-invoking the throwing send().
    expect(rm.getClient("dead")).toBeUndefined();
    expect(rm.getStats().rooms).toBe(0);
  });
});

// ============================================================================
// 2. Plugin — standalone auto-registration of @fastify/websocket
// ============================================================================

describe("Plugin — auto-registers @fastify/websocket when host hasn't", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("registers without a prior `app.register(fastifyWebsocket)` call", async () => {
    app = Fastify({ logger: false });
    // Deliberately DO NOT register @fastify/websocket — the plugin must
    // auto-register it (mirrors event-gateway behavior).
    await app.register(websocketPlugin, { auth: false });
    await app.ready();

    expect(app.hasDecorator("websocketServer")).toBe(true);
    expect((app as unknown as { ws?: unknown }).ws).toBeDefined();
  });

  it("real WebSocket upgrade succeeds against an auto-registered plugin", async () => {
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, { auth: false, heartbeatInterval: 0 });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const port = getPort(app);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const connected = await new Promise<{ type: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 3000);
      ws.on("message", (raw) => {
        clearTimeout(timeout);
        resolve(JSON.parse(raw.toString()));
      });
      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(connected.type).toBe("connected");
    ws.close();
  });
});

// ============================================================================
// 3. Connection — heartbeat liveness close after MISSED_PINGS_LIMIT
// ============================================================================

describe("Connection — heartbeat timeout close", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("terminates a zombie that never answers native pings", async () => {
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, { auth: false, heartbeatInterval: 60 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(app);

    // `autoPong: false` (ws ≥8.6) disables the client's automatic
    // protocol-level pong reply — simulating a zombie / dead reader.
    // After two missed pings the server calls `terminate()`, which the
    // client surfaces as a close event with code 1006 (abnormal closure;
    // no Close frame was sent — exactly what `terminate()` does per
    // RFC 6455 §7.1.7).
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: false });
    const pings: Buffer[] = [];
    ws.on("ping", (data) => pings.push(data));

    const { code } = await new Promise<{ code: number }>((resolve) => {
      ws.on("close", (c) => resolve({ code: c }));
    });

    // 1006 = abnormal close (no Close frame). That's the signature of
    // `terminate()`. If we ever fall back to `close(4008)` (no native
    // terminate on the socket shim), the code will be 4008 — both are
    // acceptable proof we hit the zombie branch.
    expect([1006, 4008]).toContain(code);
    expect(pings.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT close when the client (auto-)pongs at the protocol layer", async () => {
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, { auth: false, heartbeatInterval: 60 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(app);

    // Default ws client auto-responds to pings with pongs at the protocol
    // layer (no application code needed — same as every browser).
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const pings: Buffer[] = [];
    ws.on("ping", (data) => pings.push(data));

    // 350 ms ≫ heartbeatInterval × 3 — without auto-pong this would close.
    const closed = await Promise.race([
      new Promise<true>((resolve) => ws.on("close", () => resolve(true))),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 350)),
    ]);

    expect(closed).toBe(false);
    expect(pings.length).toBeGreaterThanOrEqual(2);
    ws.close();
  });
});
