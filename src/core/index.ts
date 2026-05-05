/**
 * Core Module
 *
 * Base components for the Arc resource-oriented framework.
 */

// Constants — single source of truth for defaults and magic values
export * from "../constants.js";
export type { AccessControlConfig } from "./AccessControl.js";

// Composable classes extracted from BaseController
export { AccessControl } from "./AccessControl.js";
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
} from "./aggregation/index.js";
// Aggregations (v2.13) — declarative GET /:resource/aggregations/:name
export { defineAggregation } from "./aggregation/index.js";
export { BaseController } from "./BaseController.js";
// v2.11.0 mixin split — BaseCrudController is the slim CRUD core; BaseController
// remains as the full-stack composition that extends it via the four preset
// mixins. `BaseControllerOptions` + `ListResult` live on the slim core.
export type { BaseControllerOptions, ListResult } from "./BaseCrudController.js";
export { BaseCrudController } from "./BaseCrudController.js";
export type { BodySanitizerConfig } from "./BodySanitizer.js";
export { BodySanitizer } from "./BodySanitizer.js";
// createActionRouter is the internal engine for the public `actions` API on
// defineResource. It is no longer exported — apps should declare actions via
// `defineResource({ actions: { ... } })`.
export {
  createCrudRouter,
  createPermissionMiddleware,
} from "./createCrudRouter.js";
export { defineResource, ResourceDefinition } from "./defineResource.js";
export { defineResourceVariants } from "./defineResourceVariants.js";
// Entity helpers — read `req.arc.idField` / `entityId` inside action and
// custom-route handlers without re-reading resource config. Use
// `getEntityQuery(req)` as the canonical `findOne` filter shape — fixes
// the historical footgun where `findById(id)` silently returned null
// for resources binding a non-`_id` `idField` (slug, reportId, etc.).
export {
  getEntityId,
  getEntityIdField,
  getEntityQuery,
} from "./entityHelpers.js";
// Fastify ↔ arc-controller seam (also consumed by MCP integration)
export {
  createCrudHandlers,
  createFastifyHandler,
  createRequestContext,
  getControllerContext,
  getControllerScope,
  sendControllerResponse,
} from "./fastifyAdapter.js";
// Field-rule predicates — single source of truth for read-side gates
// (`select=`, `_distinct`, response shaping). Mirrors the rule used by
// aggregation validation: only `hidden` blocks; `systemManaged` is a
// write rule and doesn't gate visibility.
export { collectReadBlockedFields, isFieldReadable } from "./fieldRulePredicates.js";
export type { BulkExt } from "./mixins/bulk.js";
export { BulkMixin } from "./mixins/bulk.js";
export type { SlugExt } from "./mixins/slug.js";
export { SlugMixin } from "./mixins/slug.js";
export type { SoftDeleteExt } from "./mixins/softDelete.js";
export { SoftDeleteMixin } from "./mixins/softDelete.js";
export type { TreeExt } from "./mixins/tree.js";
export { TreeMixin } from "./mixins/tree.js";
export type { QueryResolverConfig } from "./QueryResolver.js";
export { QueryResolver } from "./QueryResolver.js";
