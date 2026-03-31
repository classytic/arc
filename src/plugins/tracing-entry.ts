/**
 * OpenTelemetry Tracing Plugin — Dedicated Entry Point
 *
 * Import from '@classytic/arc/plugins/tracing' to avoid pulling
 * @opentelemetry/* packages into your bundle.
 *
 * @example
 * import { tracingPlugin, createSpan } from '@classytic/arc/plugins/tracing';
 *
 * await fastify.register(tracingPlugin, {
 *   serviceName: 'my-api',
 *   exporterUrl: 'http://localhost:4318/v1/traces',
 * });
 */

export type { TracingOptions } from "./tracing.js";
export {
  createSpan,
  default as tracingPlugin,
  isTracingAvailable,
  traced,
} from "./tracing.js";
