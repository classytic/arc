/**
 * Streaming helper — `pipeUIMessageStreamToReply` + `UI_MESSAGE_STREAM_HEADERS`
 *
 * Pins the contract every arc-ai host depends on:
 *   - Web ReadableStream → SSE-encoded data frames on Fastify reply.raw
 *   - Default UI message stream headers set when caller didn't.
 *   - Client disconnect cancels the source stream (no zombie LLM cost).
 *   - Auto-detection via `isReadableStream`.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  isReadableStream,
  pipeUIMessageStreamToReply,
  UI_MESSAGE_STREAM_HEADERS,
} from "../../src/utils/streaming.js";

describe("pipeUIMessageStreamToReply", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("pipes a Web ReadableStream of objects as SSE data frames", async () => {
    app = Fastify({ logger: false });
    app.get("/chat", async (_req, reply) => {
      const stream = new ReadableStream<unknown>({
        start(controller) {
          controller.enqueue({ type: "start" });
          controller.enqueue({ type: "text-delta", delta: "Hello" });
          controller.enqueue({ type: "text-delta", delta: " world" });
          controller.enqueue({ type: "finish" });
          controller.close();
        },
      });
      await pipeUIMessageStreamToReply(reply, stream);
    });

    await app.ready();
    const res = await app.inject({ method: "GET", url: "/chat" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["x-vercel-ai-ui-message-stream"]).toBe("v1");
    expect(res.body).toContain('data: {"type":"start"}');
    expect(res.body).toContain('data: {"type":"text-delta","delta":"Hello"}');
    expect(res.body).toContain('data: {"type":"finish"}');
  });

  it("sets UI_MESSAGE_STREAM_HEADERS when reply has no prior headers", async () => {
    app = Fastify({ logger: false });
    app.get("/s", async (_req, reply) => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ ok: true });
          c.close();
        },
      });
      await pipeUIMessageStreamToReply(reply, stream);
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/s" });
    for (const [k, v] of Object.entries(UI_MESSAGE_STREAM_HEADERS)) {
      expect(res.headers[k]).toBe(v);
    }
  });

  it("accepts a custom serialiser for string chunks", async () => {
    app = Fastify({ logger: false });
    app.get("/s", async (_req, reply) => {
      const stream = new ReadableStream<string>({
        start(c) {
          c.enqueue("one");
          c.enqueue("two");
          c.close();
        },
      });
      await pipeUIMessageStreamToReply(reply, stream, { serialize: (s) => String(s) });
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/s" });
    expect(res.body).toBe("data: one\n\ndata: two\n\n");
  });

  it("removes the abort listener from a caller-supplied signal once the stream completes", async () => {
    // Regression: previously the helper only removed the `close` listener
    // on `request.raw` in `finally`. The `options.signal` listener was
    // registered with `{ once: true }` but never removed explicitly — if
    // the signal was a long-lived one (request-lifecycle longer than the
    // stream) and never fired, the closure pinned `reader` indefinitely.
    app = Fastify({ logger: false });

    const controller = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const realAdd = controller.signal.addEventListener.bind(controller.signal);
    const realRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type, listener, opts) => {
      if (type === "abort") addCount += 1;
      return realAdd(type, listener, opts);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((type, listener, opts) => {
      if (type === "abort") removeCount += 1;
      return realRemove(type, listener, opts);
    }) as typeof controller.signal.removeEventListener;

    app.get("/s", async (_req, reply) => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ ok: true });
          c.close();
        },
      });
      await pipeUIMessageStreamToReply(reply, stream, { signal: controller.signal });
    });
    await app.ready();
    await app.inject({ method: "GET", url: "/s" });

    expect(addCount).toBe(1);
    expect(removeCount).toBe(1);
  });

  it("emits an SSE error frame and re-throws when the source throws", async () => {
    app = Fastify({ logger: false });
    app.get("/s", async (_req, reply) => {
      const stream = new ReadableStream({
        async start(c) {
          c.enqueue({ first: true });
          // Yield once so the consumer's first `read()` resolves with the
          // enqueued chunk before the error tears the stream down.
          await new Promise((r) => setTimeout(r, 0));
          c.error(new Error("boom"));
        },
      });
      // Don't propagate to Fastify (it's already flushed headers) — swallow here.
      await pipeUIMessageStreamToReply(reply, stream).catch(() => undefined);
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/s" });
    expect(res.body).toContain('data: {"first":true}');
    expect(res.body).toContain("event: error");
    expect(res.body).toContain("boom");
  });
});

describe("isReadableStream", () => {
  it("identifies Web ReadableStream instances", () => {
    const s = new ReadableStream();
    expect(isReadableStream(s)).toBe(true);
  });

  it("rejects non-stream values", () => {
    expect(isReadableStream(null)).toBe(false);
    expect(isReadableStream(undefined)).toBe(false);
    expect(isReadableStream("string")).toBe(false);
    expect(isReadableStream(42)).toBe(false);
    expect(isReadableStream({})).toBe(false);
    expect(isReadableStream({ getReader: () => null })).toBe(false);
  });

  it("accepts duck-typed cross-realm stream-like values", () => {
    const duck = { getReader: () => null, cancel: () => null, locked: false };
    expect(isReadableStream(duck)).toBe(true);
  });
});
