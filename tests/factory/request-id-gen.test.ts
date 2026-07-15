/**
 * Server-level request-id resolution (genReqId)
 *
 * createApp wires `createRequestIdGenerator()` into Fastify's `genReqId`
 * option so `request.id`, the `request.log` reqId binding, and the echoed
 * `x-request-id` response header all agree. Pre-2.22 the requestId plugin
 * overwrote `request.id` inside an onRequest hook — AFTER Fastify had
 * already bound the request logger — so every log line carried a different
 * id than the response header.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("server-level request id (createApp genReqId)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function makeApp(loggerStream?: { write: (s: string) => void }) {
    app = await createApp({
      preset: "testing",
      auth: false,
      ...(loggerStream ? { logger: { level: "info", stream: loggerStream } as never } : {}),
    });
    app.get("/id", async (request) => ({
      id: request.id,
      requestId: request.requestId,
    }));
    await app.ready();
    return app;
  }

  it("adopts a valid incoming x-request-id as request.id itself", async () => {
    await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/id",
      headers: { "x-request-id": "trace-abc.123:span" },
    });
    const body = res.json();
    expect(body.id).toBe("trace-abc.123:span");
    // Decorated alias and native id must agree — one id per request.
    expect(body.requestId).toBe(body.id);
    expect(res.headers["x-request-id"]).toBe("trace-abc.123:span");
  });

  it("generates a UUID for invalid (injection-shaped) incoming ids", async () => {
    await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/id",
      headers: { "x-request-id": "bad id\r\nX-Injected: true" },
    });
    const body = res.json();
    expect(body.id).toMatch(UUID_RE);
    expect(res.headers["x-request-id"]).toBe(body.id);
  });

  it("generates a UUID when no header is present (not Fastify's req-N)", async () => {
    await makeApp();
    const res = await app.inject({ method: "GET", url: "/id" });
    expect(res.json().id).toMatch(UUID_RE);
  });

  it("binds the SAME id into request.log's reqId (the whole point)", async () => {
    const lines: string[] = [];
    await makeApp({ write: (s: string) => void lines.push(s) });

    await app.inject({
      method: "GET",
      url: "/id",
      headers: { "x-request-id": "log-binding-check-1" },
    });

    const reqIds = lines
      .map((l) => {
        try {
          return (JSON.parse(l) as { reqId?: string }).reqId;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    expect(reqIds.length).toBeGreaterThan(0);
    for (const reqId of reqIds) {
      expect(reqId).toBe("log-binding-check-1");
    }
  });
});
