/**
 * `streamResponse: true` auto-pipe contract (2.17.1).
 *
 * Pre-2.17.1, returning a Web `ReadableStream` from a streamResponse route
 * crashed Fastify with `chunk must be a string or Buffer`. arc now
 * detects the returned stream and pipes it via `pipeUIMessageStreamToReply`,
 * so AI SDK hosts no longer have to write the JsonToSseTransformStream
 * boilerplate themselves.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";

describe("streamResponse auto-pipe", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("auto-pipes a returned Web ReadableStream as SSE data frames", async () => {
    const resource = defineResource({
      name: "chat",
      customRoutesOnly: true,
      routes: [
        {
          method: "POST",
          path: "/stream",
          streamResponse: true,
          permissions: allowPublic(),
          rawHandler: async () => {
            return new ReadableStream<unknown>({
              start(controller) {
                controller.enqueue({ type: "start" });
                controller.enqueue({ type: "text-delta", delta: "hi" });
                controller.enqueue({ type: "finish" });
                controller.close();
              },
            });
          },
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/chats/stream" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toContain('data: {"type":"start"}');
    expect(res.body).toContain('data: {"type":"text-delta","delta":"hi"}');
    expect(res.body).toContain('data: {"type":"finish"}');
  });

  it("does NOT double-send the returned stream (regression for ERR_HTTP_HEADERS_SENT)", async () => {
    // Regression: in the original 2.17.1 wiring, the wrapper did
    //   `await pipeUIMessageStreamToReply(reply, result); return result;`
    // — the helper sends the response via `reply.send(...)`, then
    // returning `result` (the original ReadableStream) made Fastify try
    // to send it AGAIN, crashing with ERR_HTTP_HEADERS_SENT on the
    // second turn (the first turn often appeared fine because Fastify
    // tolerated the duplicate before the headers had flushed).
    //
    // Two sequential requests on the same app catch this — the second
    // surfaces the headers-already-sent error if `return reply` is
    // missing.
    const resource = defineResource({
      name: "ds",
      customRoutesOnly: true,
      routes: [
        {
          method: "POST",
          path: "/s",
          streamResponse: true,
          permissions: allowPublic(),
          rawHandler: async () =>
            new ReadableStream<unknown>({
              start(c) {
                c.enqueue({ ok: true });
                c.close();
              },
            }),
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    const first = await app.inject({ method: "POST", url: "/dss/s" });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('data: {"ok":true}');

    const second = await app.inject({ method: "POST", url: "/dss/s" });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('data: {"ok":true}');
  });

  it("leaves direct reply.raw handlers untouched (back-compat)", async () => {
    const resource = defineResource({
      name: "log",
      customRoutesOnly: true,
      routes: [
        {
          method: "GET",
          path: "/raw",
          streamResponse: true,
          permissions: allowPublic(),
          rawHandler: async (_req, reply) => {
            reply.raw.write("event: legacy\ndata: ok\n\n");
            reply.raw.end();
          },
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/logs/raw" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: legacy");
  });
});

describe("streamResponse execution-model invariant", () => {
  // `streamResponse` invokes the handler with `(request, reply)` and hands it
  // the socket. Stated as "requires rawHandler", not "rejects handler" — the
  // router derives raw-ness from `rawHandler` alone, so a `controllerMethod`
  // route would otherwise validate, get pipeline-wrapped, and then be fed to
  // the streaming wrapper as a third execution model nobody declared.
  const base = { method: "GET" as const, path: "/s", permissions: allowPublic() };

  it("rejects streamResponse + pipeline `handler`", () => {
    expect(() =>
      defineResource({
        name: "stream-pipeline",
        disableDefaultRoutes: true,
        routes: [{ ...base, streamResponse: true, handler: async () => ({ data: 1 }) }],
      }),
    ).toThrow(/`streamResponse: true` requires `rawHandler`/);
  });

  it("rejects streamResponse + `controllerMethod`", () => {
    expect(() =>
      defineResource({
        name: "stream-ctrl-method",
        disableDefaultRoutes: true,
        controller: { stream: async () => ({ data: 1 }) } as never,
        routes: [
          {
            ...base,
            streamResponse: true,
            controllerMethod: (c: unknown) => (c as { stream: never }).stream,
          },
        ],
      }),
    ).toThrow(/`streamResponse: true` requires `rawHandler`/);
  });

  it("rejects streamResponse with no handler at all", () => {
    expect(() =>
      defineResource({
        name: "stream-none",
        disableDefaultRoutes: true,
        routes: [{ ...base, streamResponse: true } as never],
      }),
    ).toThrow(/`streamResponse: true` requires `rawHandler`/);
  });

  it("accepts streamResponse + `rawHandler`", () => {
    expect(() =>
      defineResource({
        name: "stream-ok",
        disableDefaultRoutes: true,
        routes: [
          {
            ...base,
            streamResponse: true,
            rawHandler: async (_req, reply) => {
              reply.raw.end();
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("preserves Fastify's instance as `this` inside the streaming wrapper", async () => {
    // Fastify binds the instance when it invokes a handler, and
    // `RawRouteHandler` declares that context. The wrapper calls the inner
    // handler itself, so without `.call(this, …)` the SAME handler would read
    // a decorator fine as a plain raw route and break once `streamResponse`
    // was switched on.
    const resource = defineResource({
      name: "stream-this",
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/who",
          permissions: allowPublic(),
          streamResponse: true,
          rawHandler: async function (this: { fromDecorator?: string }, _req, reply) {
            reply.raw.write(`data: ${this?.fromDecorator ?? "MISSING"}\n\n`);
            reply.raw.end();
          },
        },
      ],
    });

    const app = Fastify({ logger: false });
    app.decorate("fromDecorator", "decorated");
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/stream-thiss/who" });
    expect(res.body).toContain("data: decorated");
    expect(res.body).not.toContain("MISSING");

    await app.close();
  });
});
