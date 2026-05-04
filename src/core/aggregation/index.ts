/**
 * Public barrel for the resource-aggregation module.
 *
 * Hosts import the helper + types from `@classytic/arc`; the router
 * + boot-time validation are internal to defineResource and not
 * re-exported.
 */

// Aggregation IR types — re-exported from repo-core so hosts importing
// from `@classytic/arc` don't need a parallel `@classytic/repo-core`
// import for the types they touch declaring topN / dateBuckets.
export type {
  AggDateBucket,
  AggDateBucketInterval,
  AggDateBucketUnit,
  AggTopN,
  AggTopNTies,
} from "@classytic/repo-core/repository";
// Internal exports — used by defineResource boot wiring; not part of
// the public surface but kept on the barrel so the boot orchestrator
// has one import path.
export {
  type AggregationRouterConfig,
  createAggregationRouter,
} from "./createAggregationRouter.js";
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
export {
  ArcAggregationConfigError,
  adapterSupportsAggregate,
  type NormalizedAggregation,
  validateAggregations,
} from "./validate.js";
