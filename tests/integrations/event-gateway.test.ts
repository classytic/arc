/**
 * Event Gateway Integration Tests
 *
 * Tests the unified EventGateway plugin: shared auth enforcement,
 * SSE/WS selective registration, and room policy propagation.
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import { eventGatewayPlugin } from "../../src/integrations/event-gateway.js";
import http from "node:http";

// ============================================================================
// Helpers
// ============================================================================

function fetchSSE(
  url: string,
  timeoutMs = 500,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(url, (res) => {
      let body = "";
      const timer = setTimeout(() => {
        settled = true;
        res.destroy();
        req.destroy();
        resolve({
          statusCode: res.statusCode!,
          headers: res.headers as Record<string, string>,
          body,
        });
      }, timeoutMs);

      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({
            statusCode: res.statusCode!,
            headers: res.headers as Record<string, string>,
            body,
          });
        }
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
  });
}

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
// Auth — Fail-Closed at Gateway Level
// ============================================================================

describe("EventGateway auth", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("throws when auth:true but no authenticate decorator", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(fastifyWebsocket);

    let threw = false;
    try {
      await app.register(eventGatewayPlugin, { auth: true });
      await app.ready();
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("fastify.authenticate is not registered");
    }
    expect(threw).toBe(true);
  });

  it("auth:false allows registration without decorator", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(fastifyWebsocket);
    await app.register(eventGatewayPlugin, { auth: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    // SSE should work
    const address = app.server.address() as { port: number };
    const sseResult = await fetchSSE(
      `http://127.0.0.1:${address.port}/events/stream`,
      300,
    );
    expect(sseResult.statusCode).toBe(200);

    // WebSocket should work
    const { ws, connected } = await connectWs(address.port);
    expect(connected.type).toBe("connected");
    ws.close();
  });
});

// ============================================================================
// Selective Registration
// ============================================================================

describe("EventGateway selective registration", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("sse: false disables SSE, WebSocket still works", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(fastifyWebsocket);
    await app.register(eventGatewayPlugin, {
      auth: false,
      sse: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    // SSE endpoint should not exist
    const res = await app.inject({ method: "GET", url: "/events/stream" });
    expect(res.statusCode).toBe(404);

    // WebSocket should work
    const { ws, connected } = await connectWs(getPort(app));
    expect(connected.type).toBe("connected");
    ws.close();
  });

  it("ws: false disables WebSocket, SSE still works", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    // Don't register fastifyWebsocket since we're disabling WS
    await app.register(eventGatewayPlugin, {
      auth: false,
      ws: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    // SSE should work
    const address = app.server.address() as { port: number };
    const sseResult = await fetchSSE(
      `http://127.0.0.1:${address.port}/events/stream`,
      300,
    );
    expect(sseResult.statusCode).toBe(200);
  });
});

// ============================================================================
// Room Policy Propagation
// ============================================================================

describe("EventGateway room policy", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("roomPolicy is applied to WebSocket subscriptions", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(fastifyWebsocket);
    await app.register(eventGatewayPlugin, {
      auth: false,
      sse: false,
      roomPolicy: (_client, room) => room === "products",
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { ws } = await connectWs(getPort(app));

    // Allowed room
    const r1 = await sendAndReceive(ws, {
      type: "subscribe",
      resource: "products",
    });
    expect(r1.type).toBe("subscribed");

    // Denied room
    const r2 = await sendAndReceive(ws, {
      type: "subscribe",
      resource: "secret",
    });
    expect(r2.type).toBe("error");
    expect(r2.error).toBe("Subscription denied");

    ws.close();
  });
});

// ============================================================================
// Custom Paths
// ============================================================================

describe("EventGateway custom paths", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("uses custom paths for SSE and WebSocket", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(fastifyWebsocket);
    await app.register(eventGatewayPlugin, {
      auth: false,
      sse: { path: "/api/events" },
      ws: { path: "/api/ws" },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const port = getPort(app);

    // SSE at custom path
    const sseResult = await fetchSSE(
      `http://127.0.0.1:${port}/api/events`,
      300,
    );
    expect(sseResult.statusCode).toBe(200);
    expect(sseResult.headers["content-type"]).toBe("text/event-stream");

    // WS at custom path
    const { ws, connected } = await connectWs(port, "/api/ws");
    expect(connected.type).toBe("connected");
    ws.close();
  });
});
