/**
 * SSE Auth Enforcement Tests
 *
 * Tests fail-closed auth behavior: SSE must throw at registration
 * when requireAuth is true but fastify.authenticate is missing.
 * Also tests org-scoped event filtering.
 */

import http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import ssePlugin from "../../src/plugins/sse.js";

// ============================================================================
// Helper
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

// ============================================================================
// Fail-Closed Auth
// ============================================================================

describe("SSE Auth Enforcement", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("throws when requireAuth is true but authenticate decorator is missing", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);

    let threw = false;
    try {
      await app.register(ssePlugin, { requireAuth: true });
      await app.ready();
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("fastify.authenticate is not registered");
    }
    expect(threw).toBe(true);
  });

  it("requireAuth: false + no authenticate decorator works fine", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(ssePlugin, { requireAuth: false, heartbeat: 100 });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const address = app.server.address() as { port: number };
    const result = await fetchSSE(`http://127.0.0.1:${address.port}/events/stream`, 300);
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("text/event-stream");
  });

  it("requireAuth: true + authenticate decorator registers route with auth", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);

    // Simulate an auth decorator that rejects unauthenticated requests
    app.decorate("authenticate", async (request: any, reply: any) => {
      if (!request.headers.authorization) {
        reply.code(401).send({ error: "Unauthorized" });
      }
    });

    await app.register(ssePlugin, { requireAuth: true, heartbeat: 60000 });
    await app.ready();

    // inject() should hit the preHandler and return 401
    const res = await app.inject({
      method: "GET",
      url: "/events/stream",
    });
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================================
// Org-Scoped Filtering
// ============================================================================

describe("SSE Org-Scoped Filtering", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("orgScoped: true filters events by organization from request.scope", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);

    // Simulate org scope on the request
    app.addHook("onRequest", async (request) => {
      (request as any).scope = {
        kind: "member",
        organizationId: "org-123",
        orgRoles: ["admin"],
      };
    });

    await app.register(ssePlugin, {
      requireAuth: false,
      orgScoped: true,
      heartbeat: 60000,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const address = app.server.address() as { port: number };

    // Start SSE, publish matching org event, then publish non-matching
    const ssePromise = fetchSSE(`http://127.0.0.1:${address.port}/events/stream`, 500);

    await new Promise((r) => setTimeout(r, 100));

    // Matching org event
    await app.events.publish(
      "order.created",
      { orderId: "1" },
      {
        organizationId: "org-123",
      },
    );

    // Non-matching org event — should be filtered out
    await app.events.publish(
      "order.created",
      { orderId: "2" },
      {
        organizationId: "org-other",
      },
    );

    const result = await ssePromise;
    expect(result.body).toContain('"orderId":"1"');
    expect(result.body).not.toContain('"orderId":"2"');
  });

  it("orgScoped: true drops all org events when request has no org scope", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);

    // No org scope on request — simulates authenticated user with no active org
    app.addHook("onRequest", async (request) => {
      (request as any).scope = { kind: "authenticated" };
    });

    await app.register(ssePlugin, {
      requireAuth: false,
      orgScoped: true,
      heartbeat: 60000,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const address = app.server.address() as { port: number };
    const ssePromise = fetchSSE(`http://127.0.0.1:${address.port}/events/stream`, 500);

    await new Promise((r) => setTimeout(r, 100));
    await app.events.publish(
      "order.created",
      { orderId: "1" },
      {
        organizationId: "org-123",
      },
    );

    const result = await ssePromise;
    // Event had org context but client has no org — should be dropped
    expect(result.body).not.toContain('"orderId":"1"');
  });
});
