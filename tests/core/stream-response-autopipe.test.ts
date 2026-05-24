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
