/**
 * Resolve the tenant-cleanup strategy for a resource — pure function.
 *
 * Two outcomes:
 *   - Host declared `onTenantDelete: { strategy: … }` → source `'declared'`.
 *   - Otherwise → source `'disabled'` (cascade skips this resource).
 *
 * Throws when the configuration is internally inconsistent — e.g.
 * `onTenantDelete` set on a resource with `tenantField: false`. Boot-time
 * failure surfaces in CI / the auth-event path instead of leaking org
 * data on the next delete.
 *
 * Living in its own file so the rule is greppable + testable in
 * isolation; the `ResourceDefinition` constructor stays focused on
 * field assignment.
 */

import type { OnTenantDeleteConfig, ResolvedTenantPurge } from "../types/resource/index.js";

/**
 * Minimal config slice the resolver reads. Typed structurally rather than
 * referencing `ResourceConfig` to avoid a circular dep with `types/resource.ts`.
 */
export interface TenantPurgeResolverInput {
  readonly resourceName: string;
  readonly tenantField: string | false | undefined;
  readonly onTenantDelete?: OnTenantDeleteConfig;
}

const DEFAULT_PRIORITY = 100;

export function resolveTenantPurge(input: TenantPurgeResolverInput): ResolvedTenantPurge {
  const { resourceName, tenantField, onTenantDelete } = input;

  if (onTenantDelete) {
    assertTenantFieldUsable(resourceName, tenantField, onTenantDelete.strategy.type);
    return {
      strategy: onTenantDelete.strategy,
      priority: onTenantDelete.priority ?? DEFAULT_PRIORITY,
      batchSize: onTenantDelete.batchSize,
      source: "declared",
    };
  }

  // Not opted in — runner skips this resource. Carries a reason so
  // introspection / audit shows WHY it was skipped vs. a bug.
  return {
    strategy: { type: "skip", reason: "no `onTenantDelete` declared" },
    priority: DEFAULT_PRIORITY,
    source: "disabled",
  };
}

/**
 * Boot-time invariant: any non-skip strategy requires a real
 * `tenantField`. Company-wide tables (`tenantField: false`) can't be
 * cascaded by org. Throw rather than silently skip so the misconfig
 * surfaces in CI / the auth-event path instead of leaking org data
 * on the next delete.
 */
function assertTenantFieldUsable(
  resourceName: string,
  tenantField: string | false | undefined,
  strategyType: string,
): void {
  if (tenantField === false) {
    throw new Error(
      `[Arc/Cascade] Resource '${resourceName}' declares onTenantDelete ` +
        `(strategy: ${strategyType}) but \`tenantField: false\`. Company-wide ` +
        "resources can't be cascaded by org — set a real `tenantField` or " +
        "remove the `onTenantDelete` declaration.",
    );
  }
}
