/**
 * Registry Module
 *
 * Resource registry and introspection.
 *
 * @example
 * import { ResourceRegistry, introspectionPlugin } from '@classytic/arc/registry';
 *
 * // Register introspection endpoints
 * await fastify.register(introspectionPlugin, {
 *   prefix: '/_resources',
 *   authRoles: ['superadmin'],
 * });
 *
 * // Access registry programmatically (instance-scoped via fastify.arc.registry)
 * const allResources = fastify.arc.registry.getAll();
 * const stats = fastify.arc.registry.getStats();
 */

// Activate `FastifyInstance.arc?` augmentation for /registry consumers.
import "../types/fastify-augmentation.js";

export {
  type AssertNoTenantDataOptions,
  type AssertNoTenantDataReport,
  assertNoTenantData,
  type TenantDataLeak,
} from "./assertNoTenantData.js";
// Cascade-on-org-delete — compliance-grade tenant cleanup. Multi-tenant
// hosts opt resources in via `onTenantDelete: { strategy: … }` (hard /
// soft / anonymize / skip) and wire the runner into their auth lifecycle
// (Better Auth's `afterDeleteOrganization`, a billing webhook, etc.).
// See `assertNoTenantData` for the smoke-test counterpart used in
// compliance suites.
export {
  type CascadeCheckpoint,
  type CascadeCheckpointState,
  type CascadeOptions,
  type CascadeReport,
  type CascadeResourceReport,
  cascadeDeleteForOrganization,
  getCascadingResources,
  getCascadingResourcesWithMetadata,
} from "./cascadeOrgDelete.js";
export type { IntrospectionPluginOptions } from "./introspectionPlugin.js";
export {
  default as introspectionPlugin,
  introspectionPlugin as introspectionPluginFn,
} from "./introspectionPlugin.js";
// 2.15.5 — resource manifest for FE codegen. BE-side helper that emits
// the JSON every host's hand-rolled `createCrudApi('foo')` needs to
// auto-generate action methods (mentora / fajr report).
export {
  type ActionManifestEntry,
  type ActionMount,
  type AggregationManifestEntry,
  buildResourceManifest,
  buildResourceManifestFromRegistry,
  type CustomRouteManifestEntry,
  type ResourceManifest,
} from "./manifest.js";
export type { RegisterOptions } from "./ResourceRegistry.js";
export { ResourceRegistry } from "./ResourceRegistry.js";
