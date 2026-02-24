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

// OpenAPI spec generator
export {
  default as openApiPlugin,
  openApiPlugin as openApiPluginFn,
  buildOpenApiSpec,
} from './openapi.js';
export type { OpenApiOptions, OpenApiSpec, OpenApiBuildOptions } from './openapi.js';

// External paths (for Better Auth, custom integrations, etc.)
export type { ExternalOpenApiPaths } from './externalPaths.js';

// Scalar UI
export {
  default as scalarPlugin,
  scalarPlugin as scalarPluginFn,
} from './scalar.js';
export type { ScalarOptions } from './scalar.js';
