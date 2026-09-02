/**
 * Public barrel for the resource-aggregation module — exactly what
 * `core/index.ts` forwards to hosts: `defineAggregation` + the config types.
 *
 * The router, `validate.js` and the repo-core IR types were re-exported here
 * and are not, as of 2.37.1. Nothing imported them through the barrel:
 * `defineResource/plugin.ts` reaches `createAggregationRouter` by LAZY dynamic
 * `import("../aggregation/createAggregationRouter.js")` so a resource with no
 * aggregations never pays the module load, and the internal callers of
 * `validateAggregations` / `adapterSupportsAggregate` import `./validate.js`
 * directly. Re-listing the router here was therefore not a convenience — it
 * would defeat the laziness the boot path is written for.
 *
 * The `AggDateBucket*` / `AggTopN*` re-exports claimed to spare hosts a
 * parallel `@classytic/repo-core` import, but `core/index.ts` never forwarded
 * them, so no host could reach them; declaring `topN` / `dateBuckets` inline
 * types structurally through `AggregationConfig` and needs no named import.
 */

export { defineAggregation } from "./defineAggregation.js";
export type {
  AggMeasureInput,
  AggMeasureShorthand,
  AggregationCacheConfig,
  AggregationConfig,
  AggregationDateRangeRequirement,
  AggregationIndexHint,
  AggregationMaterializedContext,
  AggregationMaterializedResult,
  AggregationRateLimit,
  AggregationsMap,
} from "./types.js";
