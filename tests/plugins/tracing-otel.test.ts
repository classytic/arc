/**
 * Tracing Plugin — against the REAL OpenTelemetry JS SDK (3.x line).
 *
 * The test registers a global `TracerProvider` with an in-memory exporter BEFORE the
 * plugin, the way a host using `NodeSDK` would; the plugin keeps that provider and
 * installs the async context manager and W3C propagator. Every span the plugin emits
 * therefore lands in `exporter`.
 */

import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import tracingPlugin, { createSpan, traced } from "../../src/plugins/tracing.js";

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
});

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

beforeEach(() => {
  exporter.reset();
});

const finished = (): ReadableSpan[] => exporter.getFinishedSpans();

describe("createSpan with the real SDK", () => {
  it("creates a child span of the request span and sets OK on success", async () => {
    const tracer = trace.getTracer("test");
    const parentSpan = tracer.startSpan("http-request");
    const request = { tracer: { tracer, currentSpan: parentSpan } } as unknown as FastifyRequest;

    const result = await createSpan(request, "db.findProducts", async (span) => {
      expect(span).not.toBeNull();
      span?.setAttribute("db.collection.name", "products");
      return [{ id: "1" }];
    });
    parentSpan.end();

    expect(result).toEqual([{ id: "1" }]);
    const child = finished().find((s) => s.name === "db.findProducts");
    expect(child?.attributes["db.collection.name"]).toBe("products");
    expect(child?.status.code).toBe(SpanStatusCode.OK);
    expect(child?.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
  });

  it("records the exception and sets ERROR when fn throws", async () => {
    const tracer = trace.getTracer("test");
    const parentSpan = tracer.startSpan("http-request");
    const request = { tracer: { tracer, currentSpan: parentSpan } } as unknown as FastifyRequest;

    await expect(
      createSpan(request, "db.failingQuery", async () => {
        throw new Error("Connection refused");
      }),
    ).rejects.toThrow("Connection refused");
    parentSpan.end();

    const failed = finished().find((s) => s.name === "db.failingQuery");
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("traced() names the operation with the stable db.operation.name key", async () => {
    const tracer = trace.getTracer("test");
    const parentSpan = tracer.startSpan("http-request");
    const request = { tracer: { tracer, currentSpan: parentSpan } } as unknown as FastifyRequest;

    class Repo {
      async findActive(_req: unknown) {
        return ["a"];
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(Repo.prototype, "findActive");
    if (!descriptor) throw new Error("no descriptor");
    traced()(Repo.prototype, "findActive", descriptor);
    Object.defineProperty(Repo.prototype, "findActive", descriptor);

    expect(await new Repo().findActive(request)).toEqual(["a"]);
    parentSpan.end();

    const span = finished().find((s) => s.name === "Repo.findActive");
    expect(span?.attributes["db.operation.name"]).toBe("findActive");
    expect(span?.attributes).not.toHaveProperty("db.system");
  });
});

describe("Fastify hook lifecycle (onRequest → handler → onResponse)", () => {
  let app: FastifyInstance;
  let activeInHandler: string | undefined;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(tracingPlugin, {
      serviceName: "arc-test",
      autoInstrumentation: false,
      sampleRate: 1.0,
    });
    app.get("/hello", async () => ({ ok: true }));
    app.get("/items/:id", async () => {
      await new Promise((r) => setTimeout(r, 1));
      activeInHandler = trace.getActiveSpan()?.spanContext().spanId;
      return { ok: true };
    });
    app.get("/boom", async () => {
      throw new Error("intentional test error");
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("emits a span named METHOD + route with stable HTTP attributes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/hello",
      headers: { "user-agent": "t/1" },
    });
    expect(res.statusCode).toBe(200);

    const span = finished().find((s) => s.name === "GET /hello");
    expect(span, "expected a GET /hello span").toBeDefined();
    expect(span?.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.route": "/hello",
      "url.path": "/hello",
      "url.scheme": "http",
      "user_agent.original": "t/1",
      "http.response.status_code": 200,
    });
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("uses the route template, never the URL or its query string", async () => {
    await app.inject({ method: "GET", url: "/items/42?token=s3cret" });
    const span = finished().at(-1);
    expect(span?.name).toBe("GET /items/:id");
    expect(span?.attributes["url.path"]).toBe("/items/42");
    expect(JSON.stringify(span?.attributes)).not.toContain("s3cret");
  });

  it("keeps the request span active across await in the handler", async () => {
    await app.inject({ method: "GET", url: "/items/1" });
    const span = finished().find((s) => s.name === "GET /items/:id");
    expect(activeInHandler).toBe(span?.spanContext().spanId);
  });

  it("names an unmatched request by method alone", async () => {
    const res = await app.inject({ method: "GET", url: "/nope/9?x=1" });
    expect(res.statusCode).toBe(404);
    const span = finished().at(-1);
    expect(span?.name).toBe("GET");
    expect(span?.attributes).not.toHaveProperty("http.route");
  });

  it("joins an incoming W3C traceparent", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    await app.inject({
      method: "GET",
      url: "/hello",
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(finished().at(-1)?.spanContext().traceId).toBe(traceId);
  });

  it("marks a 5xx span ERROR with error.type and records the exception", async () => {
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);

    const span = finished().find((s) => s.name === "GET /boom");
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["http.response.status_code"]).toBe(500);
    expect(span?.attributes["error.type"]).toBe("500");
  });

  it("ends one independent span per request", async () => {
    await app.inject({ method: "GET", url: "/hello" });
    await app.inject({ method: "GET", url: "/hello" });
    const spans = finished().filter((s) => s.name === "GET /hello");
    expect(spans).toHaveLength(2);
    expect(spans[0]?.spanContext().spanId).not.toBe(spans[1]?.spanContext().spanId);
  });
});
