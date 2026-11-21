/**
 * OpenTelemetry Distributed Tracing Plugin
 *
 * Traces HTTP requests and the spans your code adds (`createSpan`, `traced`).
 * Explicit opt-in: nothing is traced until a host registers this plugin.
 *
 * @example
 * import { tracingPlugin } from '@classytic/arc/plugins/tracing';
 *
 * await fastify.register(tracingPlugin, {
 *   serviceName: 'my-api',
 *   exporterUrl: 'http://localhost:4318/v1/traces', // OTLP endpoint
 * });
 *
 * ## What it needs (OpenTelemetry JS SDK 3.x line)
 *
 * CORE — without any of these the plugin is a no-op with one warning:
 * `@opentelemetry/api`, `@opentelemetry/sdk-trace` (`TracerProvider`),
 * `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`.
 *
 * OPTIONAL — each loads on its own; a missing one is named once and tracing continues:
 * - `@opentelemetry/exporter-trace-otlp-http` — where spans go (warning: not exported).
 * - `@opentelemetry/context-async-hooks` — keeps the request span active across
 *   `await`, so instrumentations parent their spans to it (warning).
 * - `@opentelemetry/core` — W3C `traceparent` / baggage propagation (warning).
 * - instrumentations: `@opentelemetry/auto-instrumentations-node`, else
 *   `@opentelemetry/instrumentation-http` / `@opentelemetry/instrumentation-mongodb`
 *   singly (debug line).
 *
 * A global provider, context manager or propagator the host already registered (for
 * example with `NodeSDK`) is kept: arc then uses it instead of its own.
 *
 * ## Span shape (stable OpenTelemetry HTTP semantic conventions)
 *
 * Name: `{METHOD} {route template}` (`GET /products/:id`), or `{METHOD}` alone when no
 * route matched; never the raw URL, whose ids and query strings make names unbounded.
 * The query string is not recorded (it can carry tokens).
 */

import { createRequire } from "node:module";
import type {
  ContextAPI,
  PropagationAPI,
  Span,
  SpanStatus,
  TextMapPropagator,
  TraceAPI,
  Tracer,
} from "@opentelemetry/api";
import type { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type * as OtelExporter from "@opentelemetry/exporter-trace-otlp-http";
import type * as OtelResources from "@opentelemetry/resources";
import type * as OtelTraceSdk from "@opentelemetry/sdk-trace";
import type * as Semconv from "@opentelemetry/semantic-conventions";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

declare const __ARC_VERSION__: string;

const require = createRequire(import.meta.url);

// ============================================================================
// Runtime-loaded bindings — every package optional at load time, so importing this
// subpath without OpenTelemetry installed degrades to a no-op instead of throwing.
// ============================================================================

interface Instrumentation {
  enable(): void;
}

type InstrumentationCtor = new (config?: Record<string, unknown>) => Instrumentation;

type AutoInstrFactory = (config: Record<string, { enabled: boolean }>) => Instrumentation[];

type ApiModule = { trace: TraceAPI; context: ContextAPI; propagation: PropagationAPI } & Pick<
  typeof import("@opentelemetry/api"),
  "SpanStatusCode" | "SpanKind"
>;

interface OtelBindings {
  api?: ApiModule;
  sdk?: Pick<typeof OtelTraceSdk, "TracerProvider" | "BatchSpanProcessor">;
  resources?: Pick<typeof OtelResources, "resourceFromAttributes">;
  semconv?: typeof Semconv;
  exporter?: Pick<typeof OtelExporter, "OTLPTraceExporter">;
  contextManager?: { AsyncLocalStorageContextManager: typeof AsyncLocalStorageContextManager };
  /**
   * `@opentelemetry/core` (W3C propagators). Typed structurally: it is an optional peer
   * arc does not install directly (the SDK depends on it).
   */
  core?: {
    CompositePropagator: new (config: { propagators: TextMapPropagator[] }) => TextMapPropagator;
    W3CTraceContextPropagator: new () => TextMapPropagator;
    W3CBaggagePropagator: new () => TextMapPropagator;
  };
  getNodeAutoInstrumentations?: AutoInstrFactory;
  instrumentations: Array<{ pkg: string; ctor: InstrumentationCtor }>;
  /** Every package that was not found, by name. */
  missing: string[];
}

const PKG = {
  api: "@opentelemetry/api",
  sdk: "@opentelemetry/sdk-trace",
  resources: "@opentelemetry/resources",
  semconv: "@opentelemetry/semantic-conventions",
  exporter: "@opentelemetry/exporter-trace-otlp-http",
  contextManager: "@opentelemetry/context-async-hooks",
  core: "@opentelemetry/core",
  auto: "@opentelemetry/auto-instrumentations-node",
} as const;

const CORE_PACKAGES: readonly string[] = [PKG.api, PKG.sdk, PKG.resources, PKG.semconv];

const SINGLE_INSTRUMENTATIONS = [
  { pkg: "@opentelemetry/instrumentation-http", exportName: "HttpInstrumentation" },
  { pkg: "@opentelemetry/instrumentation-mongodb", exportName: "MongoDBInstrumentation" },
] as const;

/** Load each OpenTelemetry package on its own, so one absence never hides the rest. */
function loadOtel(): OtelBindings {
  const missing: string[] = [];
  const load = <T>(pkg: string, has: (mod: Record<string, unknown>) => boolean): T | undefined => {
    try {
      const mod = require(pkg) as Record<string, unknown>;
      if (has(mod)) return mod as T;
    } catch {
      // not installed (or failed to load) — recorded below
    }
    missing.push(pkg);
    return undefined;
  };

  const bindings: OtelBindings = {
    api: load(PKG.api, (m) => typeof m.trace === "object"),
    sdk: load(PKG.sdk, (m) => typeof m.TracerProvider === "function"),
    resources: load(PKG.resources, (m) => typeof m.resourceFromAttributes === "function"),
    semconv: load(PKG.semconv, (m) => typeof m.ATTR_HTTP_REQUEST_METHOD === "string"),
    exporter: load(PKG.exporter, (m) => typeof m.OTLPTraceExporter === "function"),
    contextManager: load(
      PKG.contextManager,
      (m) => typeof m.AsyncLocalStorageContextManager === "function",
    ),
    core: load(PKG.core, (m) => typeof m.W3CTraceContextPropagator === "function"),
    instrumentations: [],
    missing,
  };

  const auto = load<{ getNodeAutoInstrumentations: AutoInstrFactory }>(
    PKG.auto,
    (m) => typeof m.getNodeAutoInstrumentations === "function",
  );
  if (auto) {
    bindings.getNodeAutoInstrumentations = auto.getNodeAutoInstrumentations;
  } else {
    // Without the meta-package, the two arc has always asked for, each on its own.
    for (const { pkg, exportName } of SINGLE_INSTRUMENTATIONS) {
      const mod = load<Record<string, InstrumentationCtor>>(
        pkg,
        (m) => typeof m[exportName] === "function",
      );
      const ctor = mod?.[exportName];
      if (ctor) bindings.instrumentations.push({ pkg, ctor });
    }
  }

  return bindings;
}

const otel = loadOtel();

const isAvailable = Boolean(otel.api && otel.sdk && otel.resources && otel.semconv);
const trace = otel.api?.trace;
const context = otel.api?.context;
const SpanStatusCode = otel.api?.SpanStatusCode;
const semconv = otel.semconv;

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
 * Build the SDK `TracerProvider` and register it globally, together with an async
 * context manager and W3C propagators when those packages are present. Anything the
 * host registered first stays; arc's copy is then shut down unused. Returns the
 * provider arc owns (to flush on close), or `undefined` when the host's is in use.
 */
function setupGlobals(
  api: ApiModule,
  options: TracingOptions,
  log: FastifyInstance["log"],
): OtelTraceSdk.TracerProvider | undefined {
  const { sdk, resources, semconv: sc } = otel;
  if (!sdk || !resources || !sc) return undefined;

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

  const spanProcessors: OtelTraceSdk.SpanProcessor[] = [];
  if (otel.exporter) {
    spanProcessors.push(
      new sdk.BatchSpanProcessor({
        exporter: new otel.exporter.OTLPTraceExporter({ url: exporterUrl }),
      }),
    );
  } else {
    log.warn(
      `[arc] tracing: ${PKG.exporter} not installed — spans are created but not exported. ` +
        `Install it to send spans to ${exporterUrl}.`,
    );
  }

  const provider = new sdk.TracerProvider({
    resource: resources.resourceFromAttributes({
      [sc.ATTR_SERVICE_NAME]: serviceName,
      [sc.ATTR_SERVICE_VERSION]: resolvedVersion,
    }),
    spanProcessors,
  });

  if (otel.contextManager) {
    const manager = new otel.contextManager.AsyncLocalStorageContextManager();
    if (!api.context.setGlobalContextManager(manager.enable())) manager.disable();
  } else {
    log.warn(
      `[arc] tracing: ${PKG.contextManager} not installed — the request span is not active ` +
        "across await, so instrumented calls start their own traces.",
    );
  }

  if (otel.core) {
    const { CompositePropagator, W3CTraceContextPropagator, W3CBaggagePropagator } = otel.core;
    api.propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
      }),
    );
  } else {
    log.warn(
      `[arc] tracing: ${PKG.core} not installed — incoming traceparent headers are not joined.`,
    );
  }

  if (!api.trace.setGlobalTracerProvider(provider)) {
    log.info("[arc] tracing: a global tracer provider is already registered — using it");
    void provider.shutdown();
    return undefined;
  }
  return provider;
}

/** Enable the instrumentations that are installed; name each one that is not. */
function enableInstrumentations(log: FastifyInstance["log"]): void {
  if (otel.getNodeAutoInstrumentations) {
    const instrumentations = otel.getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": { enabled: true },
      "@opentelemetry/instrumentation-mongodb": { enabled: true },
    });
    for (const instrumentation of instrumentations) instrumentation.enable();
    log.debug("OpenTelemetry auto-instrumentation enabled");
    return;
  }
  for (const pkg of otel.missing) {
    if (pkg === PKG.auto || SINGLE_INSTRUMENTATIONS.some((i) => i.pkg === pkg)) {
      log.debug(`[arc] tracing: ${pkg} not installed — skipped; tracing continues without it`);
    }
  }
  for (const { pkg, ctor } of otel.instrumentations) {
    try {
      new ctor().enable();
      log.debug(`[arc] tracing: ${pkg} enabled`);
    } catch (err) {
      log.warn({ err }, `[arc] tracing: ${pkg} failed to start — skipped`);
    }
  }
}

/** `{METHOD} {route template}`, or `{METHOD}` when no route matched — never the raw URL. */
function spanName(request: FastifyRequest): string {
  const route = request.routeOptions?.url;
  return route ? `${request.method} ${route}` : request.method;
}

/** Path without the query string — the query can carry tokens, so it is never recorded. */
function urlPath(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * OpenTelemetry Distributed Tracing Plugin
 */
async function tracingPlugin(fastify: FastifyInstance, options: TracingOptions = {}) {
  const { serviceName = "@classytic/arc", autoInstrumentation = true, sampleRate = 1.0 } = options;

  const api = otel.api;
  const sc = otel.semconv;
  if (!isAvailable || !api || !sc) {
    const core = otel.missing.filter((p) => CORE_PACKAGES.includes(p));
    fastify.log.warn(`OpenTelemetry not installed (${core.join(", ")}). Tracing disabled.`);
    fastify.log.warn(`Install: npm install ${CORE_PACKAGES.join(" ")}`);
    return;
  }

  const provider = setupGlobals(api, options, fastify.log);
  if (provider) fastify.addHook("onClose", async () => provider.shutdown());

  if (autoInstrumentation) enableInstrumentations(fastify.log);

  const tracer: Tracer = api.trace.getTracer(serviceName);
  const { SpanStatusCode: status, SpanKind } = api;

  // Add tracer to request
  fastify.decorateRequest("tracer", undefined);

  // Create span for each HTTP request.
  //
  // CALLBACK-STYLE HOOK ON PURPOSE — the one legitimate use of the `done`
  // signature (same pattern as arcCorePlugin's requestContext hook):
  // `context.with(ctx, fn)` keeps the OTel context active only for the
  // synchronous duration of `fn`, so passing `done` as `fn` continues the
  // ENTIRE remaining request lifecycle inside the context.
  fastify.addHook("onRequest", (request: FastifyRequest, _reply: FastifyReply, done) => {
    // Sampling
    if (Math.random() > sampleRate) {
      done();
      return;
    }

    // Join an incoming W3C trace (a no-op without a registered propagator).
    const parent = api.propagation.extract(api.context.active(), request.headers);
    const route = request.routeOptions?.url;
    const span: Span = tracer.startSpan(
      spanName(request),
      {
        kind: SpanKind.SERVER,
        attributes: {
          [sc.ATTR_HTTP_REQUEST_METHOD]: request.method,
          ...(route ? { [sc.ATTR_HTTP_ROUTE]: route } : {}),
          [sc.ATTR_URL_PATH]: urlPath(request.url),
          [sc.ATTR_URL_SCHEME]: request.protocol,
          [sc.ATTR_SERVER_ADDRESS]: request.hostname,
          [sc.ATTR_USER_AGENT_ORIGINAL]: request.headers["user-agent"],
        },
      },
      parent,
    );

    // Store span in request for child spans
    request.tracer = { tracer, currentSpan: span };

    // Continue the request lifecycle WITHIN the active span context.
    api.context.with(api.trace.setSpan(parent, span), done);
  });

  // End span after response
  fastify.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tracer?.currentSpan) {
      return;
    }

    const span = request.tracer.currentSpan;

    span.setAttributes({
      [sc.ATTR_HTTP_RESPONSE_STATUS_CODE]: reply.statusCode,
      // Semconv: a server span's 5xx names its error by status code.
      ...(reply.statusCode >= 500 ? { [sc.ATTR_ERROR_TYPE]: String(reply.statusCode) } : {}),
    });

    const spanStatus: SpanStatus =
      reply.statusCode >= 500
        ? { code: status.ERROR, message: `HTTP ${reply.statusCode}` }
        : { code: status.OK };
    span.setStatus(spanStatus);

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
      span.setStatus({ code: status.ERROR, message: error.message });
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
        // Arc is database-agnostic: name the operation, not a database system.
        if (span && semconv) span.setAttribute(semconv.ATTR_DB_OPERATION_NAME, propertyKey);
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
