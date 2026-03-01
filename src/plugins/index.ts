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

// Request ID for distributed tracing
export {
  default as requestIdPlugin,
  requestIdPlugin as requestIdPluginFn,
} from './requestId.js';
export type { RequestIdOptions } from './requestId.js';

// Health checks (liveness, readiness, metrics)
export {
  default as healthPlugin,
  healthPlugin as healthPluginFn,
} from './health.js';
export type { HealthOptions, HealthCheck } from './health.js';

// OpenTelemetry distributed tracing — use dedicated subpath to avoid
// pulling @opentelemetry/* into your bundle:
//   import { tracingPlugin } from '@classytic/arc/plugins/tracing';
export type { TracingOptions } from './tracing.js';

// Graceful shutdown handling
export {
  default as gracefulShutdownPlugin,
  gracefulShutdownPlugin as gracefulShutdownPluginFn,
} from './gracefulShutdown.js';
export type { GracefulShutdownOptions } from './gracefulShutdown.js';

// Global error handling
export {
  default as errorHandlerPlugin,
  errorHandlerPlugin as errorHandlerPluginFn,
} from './errorHandler.js';
export type { ErrorHandlerOptions } from './errorHandler.js';

// Caching headers (ETag + Cache-Control)
export {
  default as cachingPlugin,
  cachingPlugin as cachingPluginFn,
} from './caching.js';
export type { CachingOptions, CachingRule } from './caching.js';

// Server-Sent Events
export {
  default as ssePlugin,
  ssePlugin as ssePluginFn,
} from './sse.js';
export type { SSEOptions } from './sse.js';

// Plugin factory (forRoot/forFeature pattern)
export { createPlugin } from './createPlugin.js';
export type { ArcPlugin, PluginResourceResult, CreatePluginDefinition } from './createPlugin.js';

// Arc core (instance-scoped hooks & registry)
export {
  default as arcCorePlugin,
  arcCorePlugin as arcCorePluginFn,
} from '../core/arcCorePlugin.js';
export type { ArcCorePluginOptions, ArcCore, PluginMeta } from '../core/arcCorePlugin.js';
