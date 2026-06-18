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

function fetchSSEWithHeaders(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 500,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      const timer = setTimeout(() => {
        settled = true;
        res.destroy();
        req.destroy();
        resolve({ statusCode: res.statusCode!, headers: res.headers as Record<string, string>, body });
      }, timeoutMs);
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({ statusCode: res.statusCode!, headers: res.headers as Record<string, string>, body });
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

  it("throws (fail-closed) at ready when requireAuth is true but authenticate is never registered", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);

    let threw = false;
    try {
      await app.register(ssePlugin, { requireAuth: true });
      await app.ready(); // assertion now runs in an onReady hook (after all plugins)
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("Register an auth plugin");
    }
    expect(threw).toBe(true);
  });

  it("is registration-order independent: authenticate decorated AFTER SSE still works", async () => {
    // Regression for the arc factory bug: `arcPlugins` (incl. SSE) registers BEFORE
    // `registerAuth`, so `fastify.authenticate` is absent when SSE loads. The auth
    // decorator must be resolved LAZILY (at request time), asserted at onReady — not
    // captured at registration (which threw for every auth setup).
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    // SSE first (as arc's factory does), auth decorator AFTER.
    await app.register(ssePlugin, { requireAuth: true, heartbeat: 60000 });
    app.decorate("authenticate", async (request: any, reply: any) => {
      if (!request.headers.authorization) reply.code(401).send({ error: "Unauthorized" });
    });
    await app.ready(); // must NOT throw (the old code threw here)

    // Unauthenticated → 401 via the lazily-resolved preHandler (proves the route is
    // wired with auth despite auth being decorated AFTER the plugin). We don't inject
    // an AUTHENTICATED request here — it would hijack the socket into an open SSE
    // stream and never return (the streaming path is covered by the org-scoped tests).
    const denied = await app.inject({ method: "GET", url: "/events/stream" });
    expect(denied.statusCode).toBe(401);
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

// ============================================================================
// Bearer-via-query token + CORS (browser EventSource ergonomics)
// ============================================================================
//
// EventSource cannot set request headers, so arc-next's `buildStreamUrl` (bearer
// mode) appends the token as `?token=`. The SSE plugin must (a) promote that query
// token into the Authorization header so header-based auth validates the stream,
// and (b) carry @fastify/cors's headers onto the hijacked raw response (writeHead
// bypasses Fastify's onSend chain). Both were silent failures (401, then CORS).

describe("SSE bearer-via-query token", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  // header-based authenticate: passes ONLY with `Authorization: Bearer good`.
  const headerAuth = (request: any, reply: any) => {
    if (request.headers.authorization !== "Bearer good") {
      reply.code(401).send({ error: "Unauthorized" });
    }
    return Promise.resolve();
  };

  async function startAuthedSSE(opts: Record<string, unknown> = {}): Promise<number> {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    app.decorate("authenticate", headerAuth);
    await app.register(ssePlugin, { requireAuth: true, heartbeat: 60000, ...opts });
    await app.listen({ port: 0, host: "127.0.0.1" });
    return (app.server.address() as { port: number }).port;
  }

  it("authenticates via ?token= (header-less EventSource) → 200 stream", async () => {
    const port = await startAuthedSSE();
    const res = await fetchSSE(`http://127.0.0.1:${port}/events/stream?token=good`, 300);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
  });

  it("401s when no token and no header is present", async () => {
    const port = await startAuthedSSE();
    const res = await fetchSSE(`http://127.0.0.1:${port}/events/stream`, 300);
    expect(res.statusCode).toBe(401);
  });

  it("401s on a bad ?token= (token still goes through full auth)", async () => {
    const port = await startAuthedSSE();
    const res = await fetchSSE(`http://127.0.0.1:${port}/events/stream?token=bad`, 300);
    expect(res.statusCode).toBe(401);
  });

  it("never overrides a real Authorization header (header wins over query token)", async () => {
    const port = await startAuthedSSE();
    const res = await fetchSSEWithHeaders(
      `http://127.0.0.1:${port}/events/stream?token=bad`,
      { authorization: "Bearer good" },
      300,
    );
    expect(res.statusCode).toBe(200);
  });

  it("tokenQueryParam: null disables promotion (query token ignored → 401)", async () => {
    const port = await startAuthedSSE({ tokenQueryParam: null });
    const res = await fetchSSE(`http://127.0.0.1:${port}/events/stream?token=good`, 300);
    expect(res.statusCode).toBe(401);
  });
});

describe("SSE CORS on the hijacked stream", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("forwards @fastify/cors Access-Control-Allow-Origin onto the SSE response", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    const cors = (await import("@fastify/cors")).default;
    await app.register(cors, { origin: "https://app.example.com" });
    await app.register(ssePlugin, { requireAuth: false, heartbeat: 60000 });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const { port } = app.server.address() as { port: number };
    const res = await fetchSSEWithHeaders(
      `http://127.0.0.1:${port}/events/stream`,
      { origin: "https://app.example.com" },
      300,
    );
    expect(res.statusCode).toBe(200);
    // The header @fastify/cors set in its onRequest hook must survive the raw
    // writeHead — without the merge it would be absent and the browser blocks it.
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });
});
