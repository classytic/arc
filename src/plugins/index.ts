/**
 * Arc Plugins
 *
 * Fastify plugins for production-ready features.
 *
 * @example
 * import {
 *   requestIdPlugin,
 *   healthPlugin,
 *   tracingPlugin,
 *   gracefulShutdownPlugin,
 * } from '@classytic/arc/plugins';
 *
 * await fastify.register(requestIdPlugin);
 * await fastify.register(healthPlugin, { metrics: true });
 * await fastify.register(tracingPlugin, { serviceName: 'my-api' });
 * await fastify.register(gracefulShutdownPlugin);
 */

export type { ArcCore, ArcCorePluginOptions, PluginMeta } from "../core/arcCorePlugin.js";
// Arc core (instance-scoped hooks & registry)
export {
  arcCorePlugin as arcCorePluginFn,
  default as arcCorePlugin,
} from "../core/arcCorePlugin.js";
export type { CachingOptions, CachingRule } from "./caching.js";
// Caching headers (ETag + Cache-Control)
export {
  cachingPlugin as cachingPluginFn,
  default as cachingPlugin,
} from "./caching.js";
export type { ArcPlugin, CreatePluginDefinition, PluginResourceResult } from "./createPlugin.js";
// Plugin factory (forRoot/forFeature pattern)
export { createPlugin } from "./createPlugin.js";
export type { ErrorHandlerOptions, ErrorMapper } from "./errorHandler.js";

// Global error handling
export {
  defaultIsDuplicateKeyError,
  errorHandlerPlugin,
  errorHandlerPlugin as errorHandlerPluginFn,
} from "./errorHandler.js";
export type { GracefulShutdownOptions } from "./gracefulShutdown.js";
// Graceful shutdown handling
export {
  default as gracefulShutdownPlugin,
  gracefulShutdownPlugin as gracefulShutdownPluginFn,
} from "./gracefulShutdown.js";
export type { HealthCheck, HealthOptions } from "./health.js";
// Health checks (liveness, readiness, metrics)
export {
  default as healthPlugin,
  healthPlugin as healthPluginFn,
} from "./health.js";
export type { MetricEntry, MetricsCollector, MetricsOptions } from "./metrics.js";
// Metrics (Prometheus-compatible)
export {
  default as metricsPlugin,
  metricsPlugin as metricsPluginFn,
} from "./metrics.js";
// Reply helpers (response envelope decorators)
export { replyHelpersPlugin } from "./replyHelpers.js";
export type { RequestIdOptions } from "./requestId.js";
// Request ID for distributed tracing
export {
  default as requestIdPlugin,
  requestIdPlugin as requestIdPluginFn,
} from "./requestId.js";
export type { SSEOptions } from "./sse.js";
// Server-Sent Events
export {
  default as ssePlugin,
  ssePlugin as ssePluginFn,
} from "./sse.js";
// OpenTelemetry distributed tracing — use dedicated subpath to avoid
// pulling @opentelemetry/* into your bundle:
//   import { tracingPlugin } from '@classytic/arc/plugins/tracing';
export type { TracingOptions } from "./tracing.js";
export type { VersioningOptions } from "./versioning.js";
// API Versioning (header or prefix)
export {
  default as versioningPlugin,
  versioningPlugin as versioningPluginFn,
} from "./versioning.js";
