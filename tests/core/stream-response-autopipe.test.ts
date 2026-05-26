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
          raw: true,
          streamResponse: true,
          permissions: allowPublic(),
          handler: async () => {
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
          raw: true,
          streamResponse: true,
          permissions: allowPublic(),
          handler: async () =>
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
          raw: true,
          streamResponse: true,
          permissions: allowPublic(),
          handler: async (_req, reply) => {
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
