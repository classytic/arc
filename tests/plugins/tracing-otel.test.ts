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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createSpan } from '../../src/plugins/tracing.js';

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
  const api = await import('@opentelemetry/api');
  trace = api.trace;
  context = api.context;
  SpanStatusCode = api.SpanStatusCode;

  const base = await import('@opentelemetry/sdk-trace-base');
  InMemorySpanExporter = base.InMemorySpanExporter;
  SimpleSpanProcessor = base.SimpleSpanProcessor;

  const node = await import('@opentelemetry/sdk-trace-node');
  NodeTracerProvider = node.NodeTracerProvider;

  otelAvailable = true;
} catch {
  // OTel not installed — tests will be skipped
}

const describeOTel = otelAvailable ? describe : describe.skip;

describeOTel('OTel span creation (requires @opentelemetry/*)', () => {
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

  it('should create and finish spans with attributes', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('test-operation');
    span.setAttribute('test.key', 'test-value');
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('test-operation');
    expect(spans[0].attributes['test.key']).toBe('test-value');
  });

  it('should record exceptions on spans', () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('failing-operation');
    span.recordException(new Error('something broke'));
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'something broke' });
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].events).toHaveLength(1);
  });
});

describeOTel('createSpan with real OTel tracer', () => {
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

  it('should create a child span and set OK status on success', async () => {
    const tracer = trace.getTracer('test');
    const parentSpan = tracer.startSpan('http-request');

    const mockRequest = {
      tracer: { tracer, currentSpan: parentSpan },
    } as any;

    const result = await createSpan(mockRequest, 'db.findProducts', async (span: any) => {
      expect(span).not.toBeNull();
      span.setAttribute('db.collection', 'products');
      return [{ id: '1', name: 'Widget' }];
    });

    parentSpan.end();

    expect(result).toEqual([{ id: '1', name: 'Widget' }]);

    const spans = exporter.getFinishedSpans();
    const dbSpan = spans.find((s: any) => s.name === 'db.findProducts');
    expect(dbSpan).toBeDefined();
    expect(dbSpan.attributes['db.collection']).toBe('products');
    expect(dbSpan.status.code).toBe(SpanStatusCode.OK);
  });

  it('should record exception and set ERROR status when fn throws', async () => {
    const tracer = trace.getTracer('test');
    const parentSpan = tracer.startSpan('http-request');

    const mockRequest = {
      tracer: { tracer, currentSpan: parentSpan },
    } as any;

    await expect(
      createSpan(mockRequest, 'db.failingQuery', async () => {
        throw new Error('Connection refused');
      }),
    ).rejects.toThrow('Connection refused');

    parentSpan.end();

    const spans = exporter.getFinishedSpans();
    const failSpan = spans.find((s: any) => s.name === 'db.failingQuery');
    expect(failSpan).toBeDefined();
    expect(failSpan.status.code).toBe(SpanStatusCode.ERROR);
  });
});

// When OTel is NOT installed, verify the test file doesn't crash
describe('OTel availability check', () => {
  it('should report whether OTel packages are installed', () => {
    // This test always runs — documents the current state
    if (otelAvailable) {
      expect(otelAvailable).toBe(true);
    } else {
      expect(otelAvailable).toBe(false);
      // OTel tests above were skipped — that's expected
    }
  });
});
