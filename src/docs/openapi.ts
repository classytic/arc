/**
 * Back-compat shim — the OpenAPI emitter has been split into
 * `./openapi/` for maintainability. This file re-exports the public
 * surface so any existing import (`from './openapi.js'` or
 * `@classytic/arc/docs`) keeps working unchanged.
 *
 * See `./openapi/index.ts` for the entry point and `./openapi/*.ts`
 * for the per-concern emitters (canonical schemas, CRUD paths,
 * actions, aggregations, custom routes).
 */

export type {
  OpenApiBuildOptions,
  OpenApiOptions,
  OpenApiSpec,
} from "./openapi/index.js";
export { buildOpenApiSpec, default, openApiPlugin } from "./openapi/index.js";
