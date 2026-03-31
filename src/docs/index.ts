/**
 * Documentation Module
 *
 * OpenAPI spec generation and Scalar UI for beautiful API docs.
 *
 * @example
 * import { openApiPlugin, scalarPlugin } from '@classytic/arc/docs';
 *
 * // Register OpenAPI spec generator
 * await fastify.register(openApiPlugin, {
 *   title: 'My API',
 *   version: '1.0.0',
 *   description: 'My awesome API',
 * });
 *
 * // Register Scalar UI
 * await fastify.register(scalarPlugin, {
 *   routePrefix: '/docs',
 *   theme: 'moon',
 * });
 *
 * // Spec: /_docs/openapi.json
 * // UI: /docs
 */

// External paths (for Better Auth, custom integrations, etc.)
export type { ExternalOpenApiPaths } from "./externalPaths.js";
export type { OpenApiBuildOptions, OpenApiOptions, OpenApiSpec } from "./openapi.js";
// OpenAPI spec generator
export {
  buildOpenApiSpec,
  default as openApiPlugin,
  openApiPlugin as openApiPluginFn,
} from "./openapi.js";
export type { ScalarOptions } from "./scalar.js";
// Scalar UI
export {
  default as scalarPlugin,
  scalarPlugin as scalarPluginFn,
} from "./scalar.js";
