/**
 * `defineAggregation()` — typed identity helper for declaring an
 * aggregation outside of `defineResource({ aggregations: {...} })`.
 *
 * Same role as `defineResource()` for resources, just narrower in scope.
 * Pure type narrowing — zero runtime behavior. Boot-time validation
 * happens when the parent resource is registered.
 *
 * **Why a helper at all?** Two reasons:
 *
 *   1. **Multi-file ergonomics.** Hosts with 30+ aggregations split
 *      them into separate files. Without `defineAggregation`, each
 *      file has to manually annotate the export type:
 *
 *      ```ts
 *      // before
 *      export const revenueByStatus: AggregationConfig = { ... };
 *      ```
 *
 *      With the helper:
 *
 *      ```ts
 *      // after — type inferred + extra-property checking
 *      export const revenueByStatus = defineAggregation({ ... });
 *      ```
 *
 *   2. **Future-proofing.** If we ever add boot-time normalization
 *      (e.g. expanding measure shorthand strings into IR objects),
 *      `defineAggregation` becomes the natural anchor. Today it's a
 *      pass-through; the public API stays stable when behavior moves.
 */

import type { AggregationConfig } from "./types.js";

/**
 * Declare a single resource aggregation. Exported configs flow into
 * `defineResource({ aggregations: { ... } })` either as named keys or
 * via auto-discovery patterns (loadAggregations — future).
 *
 * @example Inline
 * ```ts
 * defineResource({
 *   name: 'order',
 *   aggregations: {
 *     revenueByStatus: defineAggregation({
 *       groupBy: 'status',
 *       measures: { count: 'count', revenue: 'sum:totalPrice' },
 *       permissions: requireRoles(['admin']),
 *     }),
 *   },
 * });
 * ```
 *
 * @example Multi-file
 * ```ts
 * // orders/aggregations/revenue-by-status.ts
 * import { defineAggregation } from '@classytic/arc';
 *
 * export const revenueByStatus = defineAggregation({
 *   groupBy: 'status',
 *   measures: { count: 'count', revenue: 'sum:totalPrice' },
 *   permissions: requireRoles(['admin']),
 *   timeout: 5000,
 *   cache: { staleTime: 60 },
 * });
 *
 * // orders/order.resource.ts
 * import * as aggregations from './aggregations/index.js';
 *
 * defineResource({
 *   name: 'order',
 *   aggregations,                                  // 30+ entries flow in
 * });
 * ```
 */
export function defineAggregation(config: AggregationConfig): AggregationConfig {
  return config;
}
