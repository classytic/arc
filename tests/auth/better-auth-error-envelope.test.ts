/**
 * Better Auth refusals carry arc's envelope fields.
 *
 * Arc's own errors always carry `status` and `correlationId`; a Better Auth
 * refusal routed through the `/api/auth/*` bridge used to arrive as Better
 * Auth's bare `{ code, message }`, so clients branching on `status` or logging
 * `correlationId` had to special-case auth. The bridge now adds both when
 * absent, on buffered JSON errors only — everything else is byte-identical.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BetterAuthHandler, createBetterAuthAdapter } from "../../src/auth/betterAuth.js";

const RAW_401 = JSON.stringify({
  code: "INVALID_EMAIL_OR_PASSWORD",
  message: "Invalid email or password",
});

function handler(): BetterAuthHandler {
  return {
    handler: async (request: Request) => {
      const path = new URL(request.url).pathname;
      const json = (body: string, status: number, extra: Record<string, string> = {}) =>
        new Response(body, {
          status,
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            ...extra,
          },
        });
      if (path.endsWith("/sign-in")) {
        const headers = new Headers({
          "content-type": "application/json",
          "content-length": String(RAW_401.length),
        });
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response(RAW_401, { status: 401, headers });
      }
      if (path.endsWith("/has-fields")) {
        return json(JSON.stringify({ code: "X", status: 418, correlationId: "upstream" }), 403);
      }
      if (path.endsWith("/problem")) {
        return new Response(JSON.stringify({ title: "Bad" }), {
          status: 400,
          headers: { "content-type": "application/problem+json; charset=utf-8" },
        });
      }
      if (path.endsWith("/text")) {
        return new Response("Forbidden", {
          status: 403,
          headers: { "content-type": "text/plain" },
        });
      }
      if (path.endsWith("/bad-json")) return json("{not json", 500);
      if (path.endsWith("/array")) return json("[1,2]", 400);
      if (path.endsWith("/ok")) return json('{ "ok" : true }', 200);
      if (path.endsWith("/stream")) {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"code":"x"}\n\n'));
            c.close();
          },
        });
        return new Response(stream, {
          status: 401,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return json("{}", 404);
    },
    api: { getSession: async () => null },
  };
}

describe("Better Auth bridge — error envelope", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, genReqId: () => "req-fixed-1" });
    const { plugin } = createBetterAuthAdapter({ auth: handler() });
    await app.register(plugin);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("adds status and correlationId to a 401 { code, message }", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/sign-in", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid email or password",
      status: 401,
      correlationId: "req-fixed-1",
    });
    // Length recomputed for the rewritten body, not Better Auth's original.
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(res.body));
    // Every set-cookie survives.
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("never overwrites an existing status or correlationId (byte-identical)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/has-fields" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe(JSON.stringify({ code: "X", status: 418, correlationId: "upstream" }));
  });

  it("covers +json media types", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/problem" });
    expect(res.json()).toEqual({ title: "Bad", status: 400, correlationId: "req-fixed-1" });
  });

  it.each([
    ["/text", "Forbidden"],
    ["/bad-json", "{not json"],
    ["/array", "[1,2]"],
    ["/ok", '{ "ok" : true }'],
  ])("%s is passed through byte-identical", async (path, raw) => {
    const res = await app.inject({ method: "GET", url: `/api/auth${path}` });
    expect(res.body).toBe(raw);
  });

  it("an SSE body is streamed untouched", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/stream" });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('data: {"code":"x"}\n\n');
  });
});
