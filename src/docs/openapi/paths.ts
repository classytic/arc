/**
 * Per-resource paths orchestrator.
 *
 * Composes the four path-source emitters (CRUD, custom, actions,
 * aggregations) into a single `Record<path, PathItem>` for one
 * resource.
 *
 * No early-return guard: each section below self-gates on its own
 * source (`disableDefaultRoutes`, empty `customRoutes`/`actions`/
 * `aggregations`) and naturally contributes zero paths when empty. A
 * combined early-return is dead weight that drops resources whenever a
 * new path-source is added without being threaded into the guard — see
 * the 2.13 aggregations regression that fix corrected.
 */

import type { RegistryEntry } from "../../types/index.js";
import { appendActionPaths } from "./action-paths.js";
import { appendAggregationPaths } from "./aggregation-paths.js";
import { appendCrudPaths } from "./crud-paths.js";
import { appendCustomRoutePaths } from "./custom-paths.js";
import type { PathItem } from "./types.js";

/**
 * Generate the OpenAPI `paths` entries for a single resource.
 */
export function generateResourcePaths(
  resource: RegistryEntry,
  apiPrefix = "",
  additionalSecurity: Array<Record<string, string[]>> = [],
): Record<string, PathItem> {
  const paths: Record<string, PathItem> = {};
  const basePath = `${apiPrefix}${resource.prefix}`;

  // 1. Default CRUD (respects disableDefaultRoutes + disabledRoutes + updateMethod)
  appendCrudPaths(paths, resource, basePath, additionalSecurity);

  // 2. Preset-injected / custom routes
  appendCustomRoutePaths(paths, resource, basePath, additionalSecurity);

  // 3. v2.8.1 — declarative actions → POST /:id/action dispatcher
  appendActionPaths(paths, resource, basePath, additionalSecurity);

  // 4. v2.13 — declarative aggregations → GET /aggregations/:name
  appendAggregationPaths(paths, resource, basePath, additionalSecurity);

  return paths;
}
