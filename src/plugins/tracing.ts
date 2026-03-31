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
 */

import { createRequire } from "node:module";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

declare const __ARC_VERSION__: string;

const require = createRequire(import.meta.url);

// OpenTelemetry imports (peer dependencies)
let trace: any;
let context: any;
let SpanStatusCode: any;
let NodeTracerProvider: any;
let BatchSpanProcessor: any;
let OTLPTraceExporter: any;
let _HttpInstrumentation: any;
let _MongoDBInstrumentation: any;
let getNodeAutoInstrumentations: any;

// Try to load OpenTelemetry (optional peer dependency)
let isAvailable = false;
try {
  const api = require("@opentelemetry/api");
  trace = api.trace;
  context = api.context;
  SpanStatusCode = api.SpanStatusCode;

  const sdkNode = require("@opentelemetry/sdk-node");
  NodeTracerProvider = sdkNode.NodeTracerProvider;
  BatchSpanProcessor = sdkNode.BatchSpanProcessor;

  const exporterTraceOtlp = require("@opentelemetry/exporter-trace-otlp-http");
  OTLPTraceExporter = exporterTraceOtlp.OTLPTraceExporter;

  const instrHttp = require("@opentelemetry/instrumentation-http");
  _HttpInstrumentation = instrHttp.HttpInstrumentation;

  const instrMongo = require("@opentelemetry/instrumentation-mongodb");
  _MongoDBInstrumentation = instrMongo.MongoDBInstrumentation;

  const autoInstr = require("@opentelemetry/auto-instrumentations-node");
  getNodeAutoInstrumentations = autoInstr.getNodeAutoInstrumentations;

  isAvailable = true;
} catch (_e) {
  // OpenTelemetry not installed - plugin will be no-op
}

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
  tracer: any;
  currentSpan: any;
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
  if (!isAvailable) {
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

  const exporter = new OTLPTraceExporter({
    url: exporterUrl,
  });

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
  if (!isAvailable) {
    fastify.log.warn("OpenTelemetry not installed. Tracing disabled.");
    fastify.log.warn("Install: npm install @opentelemetry/api @opentelemetry/sdk-node");
    return;
  }

  // Initialize tracer provider
  const provider = createTracerProvider(options);
  if (!provider) {
    return;
  }

  // Auto-instrumentation — enable HTTP + MongoDB tracing
  if (autoInstrumentation && getNodeAutoInstrumentations) {
    const instrumentations = getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": {
        enabled: true,
      },
      "@opentelemetry/instrumentation-mongodb": {
        enabled: true,
      },
    });
    for (const instrumentation of instrumentations) {
      instrumentation.enable();
    }
    fastify.log.debug("OpenTelemetry auto-instrumentation enabled");
  }

  const tracer = trace.getTracer(serviceName);

  // Add tracer to request
  fastify.decorateRequest("tracer", undefined);

  // Create span for each HTTP request
  fastify.addHook("onRequest", async (request: FastifyRequest, _reply: FastifyReply) => {
    // Sampling
    if (Math.random() > sampleRate) {
      return;
    }

    const span = tracer.startSpan(`HTTP ${request.method} ${request.url}`, {
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
    request.tracer = {
      tracer,
      currentSpan: span,
    };

    // Set active context
    context.with(trace.setSpan(context.active(), span), () => {
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
      "http.response_content_length": reply.getHeader("content-length"),
    });

    // Set span status
    if (reply.statusCode >= 500) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `HTTP ${reply.statusCode}`,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

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
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
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
  fn: (span: any) => Promise<T>,
  attributes?: Record<string, any>,
): Promise<T> {
  if (!request.tracer) {
    // No tracing context on this request, just execute function
    return fn(null);
  }

  const { tracer, currentSpan } = request.tracer;

  const span = tracer.startSpan(
    name,
    {
      parent: currentSpan,
      attributes: attributes || {},
    },
    trace.setSpan(context.active(), currentSpan),
  );

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: any) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
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
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (this: any, ...args: any[]) {
      // Extract request from args if available
      const request = args.find((arg) => arg?.tracer);

      if (!request?.tracer) {
        // No tracing context, just execute
        return originalMethod.apply(this, args);
      }

      const name = spanName || `${target.constructor.name}.${propertyKey}`;
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

export default fp(tracingPlugin, {
  name: "arc-tracing",
  fastify: "5.x",
});
