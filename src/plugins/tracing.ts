/**
 * OpenTelemetry Distributed Tracing Plugin
 *
 * Traces HTTP requests, repository operations, and MongoDB queries
 * across the entire application lifecycle.
 *
 * @example
 * import { tracingPlugin } from '@classytic/arc/plugins';
 *
 * await fastify.register(tracingPlugin, {
 *   serviceName: 'my-api',
 *   exporterUrl: 'http://localhost:4318/v1/traces', // OTLP endpoint
 * });
 *
 * ## Type strategy
 *
 * `@opentelemetry/api` is the stable surface — its types are type-only
 * imported here so hook handlers, `createSpan`, and `traced` don't hand
 * out `any` for Tracer / Span. Only the runtime-loaded module BODIES
 * (`trace.getTracer`, `context.with`, etc.) go through the optional-require
 * path; everything downstream keeps its shape through the plugin.
 *
 * The SDK-side factories (`NodeTracerProvider`, `BatchSpanProcessor`,
 * `OTLPTraceExporter`) aren't in @classytic/arc's devDeps and aren't
 * type-importable without adding install weight, so those retain
 * minimal constructor-style `unknown`-valued boxes. If a future refactor
 * moves SDK types into devDependencies we can tighten further.
 */

import { createRequire } from "node:module";
import type {
  ContextAPI,
  Context as OTContext,
  Span,
  SpanStatus,
  TraceAPI,
  Tracer,
} from "@opentelemetry/api";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

declare const __ARC_VERSION__: string;

const require = createRequire(import.meta.url);

// ============================================================================
// Runtime-loaded bindings
//
// `@opentelemetry/api` is a stable peer, so `trace` / `context` / `SpanStatusCode`
// get real types once loaded. The SDK side (NodeTracerProvider,
// BatchSpanProcessor, OTLPTraceExporter, instrumentations) is optional and
// changes shape across minor versions — those stay as minimal constructor
// boxes, good enough for the narrow usage here.
// ============================================================================

type SpanStatusCodeValue = 0 | 1 | 2; // UNSET | OK | ERROR — matches @opentelemetry/api

interface TracerCtorBox {
  new (
    options: unknown,
  ): {
    addSpanProcessor(processor: unknown): void;
    register(): void;
  };
}

interface SpanProcessorCtor {
  new (exporter: unknown): unknown;
}

interface OtlpExporterCtor {
  new (options: { url: string }): unknown;
}

interface Instrumentation {
  enable(): void;
}

type AutoInstrFactory = (config: Record<string, { enabled: boolean }>) => Instrumentation[];

let trace: TraceAPI | undefined;
let context: ContextAPI | undefined;
let SpanStatusCode:
  | { UNSET: SpanStatusCodeValue; OK: SpanStatusCodeValue; ERROR: SpanStatusCodeValue }
  | undefined;
let NodeTracerProvider: TracerCtorBox | undefined;
let BatchSpanProcessor: SpanProcessorCtor | undefined;
let OTLPTraceExporter: OtlpExporterCtor | undefined;
let getNodeAutoInstrumentations: AutoInstrFactory | undefined;

// Try to load OpenTelemetry (optional peer dependency)
let isAvailable = false;
try {
  const api = require("@opentelemetry/api");
  trace = api.trace as TraceAPI;
  context = api.context as ContextAPI;
  SpanStatusCode = api.SpanStatusCode;

  const sdkNode = require("@opentelemetry/sdk-node");
  NodeTracerProvider = sdkNode.NodeTracerProvider as TracerCtorBox;
  BatchSpanProcessor = sdkNode.BatchSpanProcessor as SpanProcessorCtor;

  const exporterTraceOtlp = require("@opentelemetry/exporter-trace-otlp-http");
  OTLPTraceExporter = exporterTraceOtlp.OTLPTraceExporter as OtlpExporterCtor;

  // HTTP + MongoDB instrumentation modules are loaded for their side-effect
  // registration inside `getNodeAutoInstrumentations` (below). No direct
  // usage here — the variables would be dead symbols.
  require("@opentelemetry/instrumentation-http");
  require("@opentelemetry/instrumentation-mongodb");

  const autoInstr = require("@opentelemetry/auto-instrumentations-node");
  getNodeAutoInstrumentations = autoInstr.getNodeAutoInstrumentations as AutoInstrFactory;

  isAvailable = true;
} catch (_e) {
  // OpenTelemetry not installed - plugin will be no-op
}

// ============================================================================
// Public options + types
// ============================================================================

export interface TracingOptions {
  /**
   * Service name for traces
   */
  serviceName?: string;

  /**
   * Service version for trace metadata (rollout diagnostics).
   * @default package version from build-time define
   */
  serviceVersion?: string;

  /**
   * OTLP exporter endpoint URL
   * @default 'http://localhost:4318/v1/traces'
   */
  exporterUrl?: string;

  /**
   * Enable auto-instrumentation for HTTP, MongoDB, etc.
   * @default true
   */
  autoInstrumentation?: boolean;

  /**
   * Sample rate (0.0 to 1.0)
   * @default 1.0 (trace everything)
   */
  sampleRate?: number;
}

interface TracerContext {
  tracer: Tracer;
  currentSpan: Span;
}

declare module "fastify" {
  interface FastifyRequest {
    tracer?: TracerContext;
  }
}

/**
 * Create a tracer provider
 */
function createTracerProvider(options: TracingOptions) {
  if (!isAvailable || !NodeTracerProvider || !BatchSpanProcessor || !OTLPTraceExporter) {
    return null;
  }

  const {
    serviceName = "@classytic/arc",
    serviceVersion,
    exporterUrl = "http://localhost:4318/v1/traces",
  } = options;

  // Resolve version: explicit option > build-time define > fallback
  const resolvedVersion =
    serviceVersion ??
    (typeof __ARC_VERSION__ === "string" && __ARC_VERSION__ !== "__ARC_VERSION__"
      ? __ARC_VERSION__
      : "0.0.0");

  const exporter = new OTLPTraceExporter({ url: exporterUrl });

  const provider = new NodeTracerProvider({
    resource: {
      attributes: {
        "service.name": serviceName,
        "service.version": resolvedVersion,
      },
    },
  });

  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  return provider;
}

/**
 * OpenTelemetry Distributed Tracing Plugin
 */
async function tracingPlugin(fastify: FastifyInstance, options: TracingOptions = {}) {
  const { serviceName = "@classytic/arc", autoInstrumentation = true, sampleRate = 1.0 } = options;

  // Skip if OpenTelemetry is not available
  if (!isAvailable || !trace || !context || !SpanStatusCode) {
    fastify.log.warn("OpenTelemetry not installed. Tracing disabled.");
    fastify.log.warn("Install: npm install @opentelemetry/api @opentelemetry/sdk-node");
    return;
  }

  // From here, the narrow `isAvailable` flag plus the three defined checks
  // above let us treat `trace`, `context`, `SpanStatusCode` as required.
  const otelTrace = trace;
  const otelContext = context;
  const otelStatus = SpanStatusCode;

  // Initialize tracer provider
  const provider = createTracerProvider(options);
  if (!provider) {
    return;
  }

  // Auto-instrumentation — enable HTTP + MongoDB tracing
  if (autoInstrumentation && getNodeAutoInstrumentations) {
    const instrumentations = getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": { enabled: true },
      "@opentelemetry/instrumentation-mongodb": { enabled: true },
    });
    for (const instrumentation of instrumentations) {
      instrumentation.enable();
    }
    fastify.log.debug("OpenTelemetry auto-instrumentation enabled");
  }

  const tracer: Tracer = otelTrace.getTracer(serviceName);

  // Add tracer to request
  fastify.decorateRequest("tracer", undefined);

  // Create span for each HTTP request
  fastify.addHook("onRequest", async (request: FastifyRequest, _reply: FastifyReply) => {
    // Sampling
    if (Math.random() > sampleRate) {
      return;
    }

    const span: Span = tracer.startSpan(`HTTP ${request.method} ${request.url}`, {
      kind: 1, // SpanKind.SERVER
      attributes: {
        "http.method": request.method,
        "http.url": request.url,
        "http.target": request.routeOptions?.url ?? request.url,
        "http.host": request.hostname,
        "http.scheme": request.protocol,
        "http.user_agent": request.headers["user-agent"],
      },
    });

    // Store span in request for child spans
    request.tracer = { tracer, currentSpan: span };

    // Set active context
    otelContext.with(otelTrace.setSpan(otelContext.active(), span), () => {
      // Context is now active for this request
    });
  });

  // End span after response
  fastify.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tracer?.currentSpan) {
      return;
    }

    const span = request.tracer.currentSpan;

    // Add response attributes
    span.setAttributes({
      "http.status_code": reply.statusCode,
      "http.response_content_length": reply.getHeader("content-length") as
        | string
        | number
        | undefined,
    });

    // Set span status
    const status: SpanStatus =
      reply.statusCode >= 500
        ? { code: otelStatus.ERROR, message: `HTTP ${reply.statusCode}` }
        : { code: otelStatus.OK };
    span.setStatus(status);

    span.end();
  });

  // Error tracking
  fastify.addHook(
    "onError",
    async (request: FastifyRequest, _reply: FastifyReply, error: Error) => {
      if (!request.tracer?.currentSpan) {
        return;
      }

      const span = request.tracer.currentSpan;
      span.recordException(error);
      span.setStatus({ code: otelStatus.ERROR, message: error.message });
    },
  );

  fastify.log.debug({ serviceName }, "OpenTelemetry tracing enabled");
}

/**
 * Utility to create custom spans in your code
 *
 * @example
 * import { createSpan } from '@classytic/arc/plugins';
 *
 * async function expensiveOperation(req) {
 *   return createSpan(req, 'expensiveOperation', async (span) => {
 *     span.setAttribute('custom.attribute', 'value');
 *     return await doWork();
 *   });
 * }
 */
export function createSpan<T>(
  request: FastifyRequest,
  name: string,
  fn: (span: Span | null) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  if (!request.tracer || !trace || !context || !SpanStatusCode) {
    // No tracing context on this request, just execute function
    return fn(null);
  }

  const otelTrace = trace;
  const otelContext = context;
  const otelStatus = SpanStatusCode;

  const { tracer, currentSpan } = request.tracer;

  const span: Span = tracer.startSpan(
    name,
    {
      attributes: attributes ?? {},
    },
    otelTrace.setSpan(otelContext.active(), currentSpan),
  );

  return otelContext.with(otelTrace.setSpan(otelContext.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: otelStatus.OK });
      return result;
    } catch (error) {
      const err = error as Error;
      span.recordException(err);
      span.setStatus({ code: otelStatus.ERROR, message: err.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Decorator to automatically trace repository methods
 *
 * @example
 * class ProductRepository extends Repository {
 *   @traced()
 *   async findActive() {
 *     return this.findAll({ filter: { isActive: true } });
 *   }
 * }
 */
export function traced(spanName?: string) {
  return (
    target: { constructor: { name: string } },
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<unknown>;

    descriptor.value = async function (this: unknown, ...args: unknown[]) {
      // Extract request from args if available
      const request = args.find(
        (arg): arg is FastifyRequest =>
          !!(arg && typeof arg === "object" && "tracer" in arg && (arg as FastifyRequest).tracer),
      );

      if (!request?.tracer) {
        // No tracing context, just execute
        return originalMethod.apply(this, args);
      }

      const name = spanName ?? `${target.constructor.name}.${propertyKey}`;
      return createSpan(request, name, async (span) => {
        if (span) {
          span.setAttribute("db.operation", propertyKey);
          span.setAttribute("db.system", "mongodb");
        }
        return originalMethod.apply(this, args);
      });
    };

    return descriptor;
  };
}

/**
 * Check if OpenTelemetry is available
 */
export function isTracingAvailable(): boolean {
  return isAvailable;
}

// Internal — exported only for the lifecycle integration tests. The types
// here give the test suite enough surface to construct a plugin context,
// but are NOT part of the public API. Signal via the `_` prefix.
export type _OTContext = OTContext;

export default fp(tracingPlugin, {
  name: "arc-tracing",
  fastify: "5.x",
});
