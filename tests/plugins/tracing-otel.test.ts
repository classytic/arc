/**
 * Tracing Plugin — OpenTelemetry Integration Tests
 *
 * Tests the REAL OTel path when @opentelemetry packages are installed.
 * Skips gracefully when OTel is not available (optional peer dep).
 *
 * To run these tests with OTel:
 *   npm install @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/sdk-trace-node
 *   npx vitest run tests/plugins/tracing-otel.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSpan } from "../../src/plugins/tracing.js";

// Dynamic import — skip entire suite if OTel not installed
let trace: any;
let context: any;
let SpanStatusCode: any;
let InMemorySpanExporter: any;
let SimpleSpanProcessor: any;
let NodeTracerProvider: any;

let otelAvailable = false;
let exporter: any;
let provider: any;

try {
  const api = await import("@opentelemetry/api");
  trace = api.trace;
  context = api.context;
  SpanStatusCode = api.SpanStatusCode;

  const base = await import("@opentelemetry/sdk-trace-base");
  InMemorySpanExporter = base.InMemorySpanExporter;
  SimpleSpanProcessor = base.SimpleSpanProcessor;

  const node = await import("@opentelemetry/sdk-trace-node");
  NodeTracerProvider = node.NodeTracerProvider;

  otelAvailable = true;
} catch {
  // OTel not installed — tests will be skipped
}

const describeOTel = otelAvailable ? describe : describe.skip;

describeOTel("OTel span creation (requires @opentelemetry/*)", () => {
  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  it("should create and finish spans with attributes", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("test-operation");
    span.setAttribute("test.key", "test-value");
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("test-operation");
    expect(spans[0].attributes["test.key"]).toBe("test-value");
  });

  it("should record exceptions on spans", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("failing-operation");
    span.recordException(new Error("something broke"));
    span.setStatus({ code: SpanStatusCode.ERROR, message: "something broke" });
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].events).toHaveLength(1);
  });
});

describeOTel("createSpan with real OTel tracer", () => {
  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  it("should create a child span and set OK status on success", async () => {
    const tracer = trace.getTracer("test");
    const parentSpan = tracer.startSpan("http-request");

    const mockRequest = {
      tracer: { tracer, currentSpan: parentSpan },
    } as any;

    const result = await createSpan(mockRequest, "db.findProducts", async (span: any) => {
      expect(span).not.toBeNull();
      span.setAttribute("db.collection", "products");
      return [{ id: "1", name: "Widget" }];
    });

    parentSpan.end();

    expect(result).toEqual([{ id: "1", name: "Widget" }]);

    const spans = exporter.getFinishedSpans();
    const dbSpan = spans.find((s: any) => s.name === "db.findProducts");
    expect(dbSpan).toBeDefined();
    expect(dbSpan.attributes["db.collection"]).toBe("products");
    expect(dbSpan.status.code).toBe(SpanStatusCode.OK);
  });

  it("should record exception and set ERROR status when fn throws", async () => {
    const tracer = trace.getTracer("test");
    const parentSpan = tracer.startSpan("http-request");

    const mockRequest = {
      tracer: { tracer, currentSpan: parentSpan },
    } as any;

    await expect(
      createSpan(mockRequest, "db.failingQuery", async () => {
        throw new Error("Connection refused");
      }),
    ).rejects.toThrow("Connection refused");

    parentSpan.end();

    const spans = exporter.getFinishedSpans();
    const failSpan = spans.find((s: any) => s.name === "db.failingQuery");
    expect(failSpan).toBeDefined();
    expect(failSpan.status.code).toBe(SpanStatusCode.ERROR);
  });
});

// ============================================================================
// Fastify hook lifecycle — the REAL integration surface.
//
// Pre-2.11.x, the `onRequest` / `onResponse` / `onError` path through the
// tracing plugin was uncovered: unit tests exercised `createSpan` in
// isolation, but no test booted Fastify with the plugin registered and
// asserted that an HTTP request produced a span with the expected
// attributes. A regression in the hook chain (wrong span kind, missing
// status set, onError not recording exceptions) could land silently.
//
// These tests register the real plugin against an `InMemorySpanExporter`
// and then drive traffic through `app.inject()` so the full Fastify hook
// lifecycle runs. Gated on `otelAvailable` so the suite still passes when
// optional peer deps aren't installed.
// ============================================================================

describeOTel("Fastify hook lifecycle (HTTP → onRequest → handler → onResponse)", () => {
  // Minimal Fastify app wired through tracingPlugin. Shares one provider
  // across all tests in this describe so we can reset the exporter between
  // cases without re-plumbing SDK state.
  //
  // biome-ignore lint/suspicious/noExplicitAny: Fastify + SDK types cross
  // the test boundary; the integration surface is what we care about.
  let app: any;

  beforeAll(async () => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();

    const Fastify = (await import("fastify")).default;
    const { default: tracingPlugin } = await import("../../src/plugins/tracing.js");

    app = Fastify({ logger: false });
    // Register with auto-instrumentation OFF so we don't double-count
    // HTTP spans (the auto-instrumentation path is a separate integration
    // concern; this test locks the in-plugin hook behaviour).
    await app.register(tracingPlugin, {
      serviceName: "arc-test",
      autoInstrumentation: false,
      sampleRate: 1.0,
    });

    app.get("/hello", async () => ({ ok: true }));
    app.get("/boom", async () => {
      throw new Error("intentional test error");
    });

    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  it("emits a span with http attributes on 2xx request", async () => {
    const res = await app.inject({ method: "GET", url: "/hello" });
    expect(res.statusCode).toBe(200);

    // span.end() runs in `onResponse`. Hook completion is synchronous
    // with the reply, so the exporter's buffer already has it by the time
    // inject() resolves.
    const spans = exporter.getFinishedSpans();
    const httpSpan = spans.find((s: any) => s.name.startsWith("HTTP GET"));
    expect(httpSpan, "expected an HTTP GET span").toBeDefined();
    expect(httpSpan.attributes["http.method"]).toBe("GET");
    expect(httpSpan.attributes["http.url"]).toContain("/hello");
    expect(httpSpan.attributes["http.status_code"]).toBe(200);
    expect(httpSpan.status.code).toBe(SpanStatusCode.OK);
  });

  it("emits a span with ERROR status on 5xx + records the exception", async () => {
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);

    const spans = exporter.getFinishedSpans();
    const boomSpan = spans.find((s: any) => s.name === "HTTP GET /boom");
    expect(boomSpan, "expected an HTTP GET /boom span").toBeDefined();
    // onError records the exception (as a span event).
    expect(boomSpan.events?.length ?? 0).toBeGreaterThanOrEqual(1);
    const exEvent = boomSpan.events.find((e: any) => e.name === "exception");
    expect(exEvent).toBeDefined();
    // onResponse sets status to ERROR for 5xx (overrides any earlier OK).
    expect(boomSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(boomSpan.attributes["http.status_code"]).toBe(500);
  });

  it("does not leak tracer context between requests", async () => {
    // Two sequential requests — each should end its own span. If an
    // onResponse hook regressed and dropped span.end(), the exporter
    // would hold onto the first request's span and this assertion fails.
    await app.inject({ method: "GET", url: "/hello" });
    await app.inject({ method: "GET", url: "/hello" });

    const spans = exporter.getFinishedSpans();
    const httpSpans = spans.filter((s: any) => s.name.startsWith("HTTP GET"));
    expect(httpSpans).toHaveLength(2);
    // Both should be independent (different span IDs).
    expect(httpSpans[0].spanContext().spanId).not.toBe(httpSpans[1].spanContext().spanId);
  });
});

// When OTel is NOT installed, verify the test file doesn't crash
describe("OTel availability check", () => {
  it("should report whether OTel packages are installed", () => {
    // This test always runs — documents the current state
    if (otelAvailable) {
      expect(otelAvailable).toBe(true);
    } else {
      expect(otelAvailable).toBe(false);
      // OTel tests above were skipped — that's expected
    }
  });
});
