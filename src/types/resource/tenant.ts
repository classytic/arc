/**
 * Tenant-cleanup types — what happens to a resource's rows when the
 * owning organization is deleted. Consumed by the org-delete cascade
 * runner and registry introspection.
 */

import type { TenantPurgeStrategy } from "@classytic/repo-core/repository";

/**
 * Tenant-cleanup declaration on a resource — compliance-grade strategy
 * for what happens to this resource's rows when the owning organization
 * is deleted. Surfaces in arc's org-delete cascade runner and in
 * registry introspection (audit scripts ask "what happens to this
 * resource on org delete?").
 *
 * Strategy variants:
 *   - `hard` — permanent removal (GDPR right-to-be-forgotten).
 *   - `soft` — recoverable; pair with TTL for eventual hard-purge.
 *   - `anonymize` — keep the row (legal retention) but clear PII
 *     (HIPAA / PCI / SOX-compatible).
 *   - `skip` — explicit opt-out with mandatory `reason`.
 *
 * See {@link ResourceConfig.onTenantDelete} for the full decision tree.
 */
export interface OnTenantDeleteConfig {
  /**
   * What to do with rows whose `tenantField` matches the deleted org.
   * Discriminated union from `@classytic/repo-core/repository` — every
   * kit's `purgeByField` consumes the same shape.
   */
  strategy: TenantPurgeStrategy;
  /**
   * Resources are processed in ascending `priority` order. Use to land
   * leaf data (logs, events) before aggregate references. Default `100`.
   */
  priority?: number;
  /**
   * Rows per chunk for the underlying `purgeByField` call — bounds
   * lock contention + replication-log pressure on very large tenants.
   * Default kit-specific (~1000).
   */
  batchSize?: number;
}

/**
 * Resolved tenant-purge declaration — what arc actually runs when
 * `cascadeDeleteForOrganization` fires. Computed once at boot from the
 * resource's `onTenantDelete` declaration.
 *
 * Exposed via `ResourceDefinition.resolvedTenantPurge` and
 * `getCascadingResourcesWithMetadata(registry)` so audit tooling can
 * answer "is this resource really going to hard-delete?" without
 * reading the source.
 */
export interface ResolvedTenantPurge {
  readonly strategy: TenantPurgeStrategy;
  readonly priority: number;
  readonly batchSize?: number;
  /**
   * Where the strategy came from — `'declared'` (host wrote
   * `onTenantDelete` explicitly) or `'disabled'` (no declaration —
   * runner skips this resource).
   */
  readonly source: "declared" | "disabled";
}
