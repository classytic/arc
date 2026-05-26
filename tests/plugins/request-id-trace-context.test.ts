/**
 * requestIdPlugin — W3C Trace Context propagation (audit Rec 2).
 */

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { requestIdPlugin } from "../../src/plugins/requestId.js";

describe("requestIdPlugin trace context propagation", () => {
  let app: ReturnType<typeof Fastify>;
  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("parses a valid traceparent and echoes it in the response", async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    app.get("/ping", async (_req, reply) => reply.send({ ok: true }));
    await app.ready();

    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { traceparent: tp },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["traceparent"]).toBe(tp);
  });

  it("also propagates tracestate alongside traceparent", async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    app.get("/ping", async (_req, reply) => reply.send({ ok: true }));
    await app.ready();

    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const ts = "vendor=opaquevalue,rojo=00f067aa0ba902b7";

    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { traceparent: tp, tracestate: ts },
    });

    expect(res.headers["traceparent"]).toBe(tp);
    expect(res.headers["tracestate"]).toBe(ts);
  });

  it("ignores a malformed traceparent (wrong format)", async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    app.get("/ping", async (_req, reply) => reply.send({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { traceparent: "not-a-valid-traceparent" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["traceparent"]).toBeUndefined();
  });

  it("does not forward trace context when propagateTraceContext is false", async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin, { propagateTraceContext: false });
    app.get("/ping", async (_req, reply) => reply.send({ ok: true }));
    await app.ready();

    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { traceparent: tp },
    });

    expect(res.headers["traceparent"]).toBeUndefined();
  });

  it("sets request.traceContext with parsed traceparent", async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);

    let captured: unknown;
    app.get("/ping", async (req, reply) => {
      captured = req.traceContext;
      return reply.send({ ok: true });
    });
    await app.ready();

    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    await app.inject({ method: "GET", url: "/ping", headers: { traceparent: tp } });

    expect(captured).toEqual({ traceparent: tp });
  });

  it("includes tracestate in request.traceContext when present", async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);

    let captured: unknown;
    app.get("/ping", async (req, reply) => {
      captured = req.traceContext;
      return reply.send({ ok: true });
    });
    await app.ready();

    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const ts = "vendor=value";
    await app.inject({
      method: "GET",
      url: "/ping",
      headers: { traceparent: tp, tracestate: ts },
    });

    expect(captured).toEqual({ traceparent: tp, tracestate: ts });
  });

  it("rejects all-zero traceId (W3C §3.2.2)", async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    app.get("/ping", async (_req, reply) => reply.send({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["traceparent"]).toBeUndefined();
  });

  it("rejects all-zero parentId (W3C §3.2.3)", async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    app.get("/ping", async (_req, reply) => reply.send({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["traceparent"]).toBeUndefined();
  });

  it("rejects version ff (reserved, W3C §3.2.1)", async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);
    app.get("/ping", async (_req, reply) => reply.send({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { traceparent: "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["traceparent"]).toBeUndefined();
  });

  it("request.traceContext is undefined when no traceparent header", async () => {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin);

    let captured: unknown = "sentinel";
    app.get("/ping", async (req, reply) => {
      captured = req.traceContext;
      return reply.send({ ok: true });
    });
    await app.ready();

    await app.inject({ method: "GET", url: "/ping" });
    expect(captured).toBeUndefined();
  });
});
