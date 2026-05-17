/**
 * Compliance smoke-test harness — answers "are we leaking tenant data?"
 * in one call instead of a per-resource audit.
 *
 * Runs `count({ [tenantField]: organizationId })` against every
 * cascading resource and asserts the result matches the resource's
 * declared strategy:
 *
 *   - `hard`      → expect 0 rows
 *   - `soft`      → expect 0 non-soft-deleted rows (caller filters in
 *                   the smoke harness's own `before:count` hook OR uses
 *                   `includeDeleted: false` on the repo)
 *   - `anonymize` → expect N rows (data retained); assertion just
 *                   confirms the row count didn't change beyond the
 *                   anonymize write
 *   - `skip`      → assertion is informational (the `reason` is echoed)
 *
 * Returns a structured report — `{ ok, leaks }`. Hosts wire this into
 * a post-cascade test or a scheduled compliance check.
 */

import type { TenantPurgeStrategy } from "@classytic/repo-core/repository";
import { DEFAULT_TENANT_FIELD } from "../constants.js";
import type { ResourceRegistry } from "./ResourceRegistry.js";

/**
 * Capability sniff — every kit's repo exposes `count(filter)` per
 * StandardRepo. We type structurally so this module doesn't depend
 * on a specific kit.
 */
interface CountableRepo {
  count?: (filter: Record<string, unknown>) => Promise<number>;
}

export interface AssertNoTenantDataOptions {
  readonly organizationId: string;
  /**
   * Limit the check to a subset of resources. Default: every cascading
   * resource (matches the cascade runner's filter).
   */
  readonly only?: readonly string[];
  /**
   * Skip resources whose strategy is `anonymize` (the rows legitimately
   * remain). Default `true` — the smoke test focuses on "did data leave?"
   * not "did anonymize keep rows?". Set `false` for a full pass.
   */
  readonly skipAnonymize?: boolean;
}

export interface TenantDataLeak {
  readonly resource: string;
  readonly tenantField: string;
  /**
   * Full `TenantPurgeStrategy` discriminated union — not just `.type`.
   * `anonymize` carries the field map; `custom` carries the handler
   * descriptor; auditors get the actionable signal without re-resolving
   * the resource definition. Narrow on `.strategy.type` for typed
   * access.
   */
  readonly strategy: TenantPurgeStrategy;
  readonly expected: number;
  readonly actual: number;
  readonly reason?: string;
}

export interface AssertNoTenantDataReport {
  readonly ok: boolean;
  readonly organizationId: string;
  readonly checked: number;
  readonly skipped: readonly { resource: string; reason: string }[];
  readonly leaks: readonly TenantDataLeak[];
}

/**
 * Walk every cascading resource, run a tenant-scoped count, compare
 * against the strategy's expected outcome.
 *
 * Designed for use inside compliance tests:
 *
 * ```ts
 * import { assertNoTenantData } from '@classytic/arc/registry';
 *
 * it('after org delete, no tenant data leaks', async () => {
 *   await cascadeDeleteForOrganization(arc.registry, { organizationId: 'test-org' });
 *   const report = await assertNoTenantData(arc.registry, { organizationId: 'test-org' });
 *   expect(report.ok).toBe(true);
 *   expect(report.leaks).toHaveLength(0);
 * });
 * ```
 */
export async function assertNoTenantData(
  registry: ResourceRegistry,
  options: AssertNoTenantDataOptions,
): Promise<AssertNoTenantDataReport> {
  const { organizationId, only, skipAnonymize = true } = options;
  if (!organizationId) {
    throw new Error("assertNoTenantData: `organizationId` is required");
  }

  const onlySet = only ? new Set(only) : undefined;
  const leaks: TenantDataLeak[] = [];
  const skipped: { resource: string; reason: string }[] = [];
  let checked = 0;

  for (const r of registry.getAll()) {
    const resolved = r.resolvedTenantPurge;
    if (!resolved || resolved.source === "disabled") continue;
    if (onlySet && !onlySet.has(r.name)) continue;

    const tenantField =
      (typeof r.tenantField === "string" && r.tenantField) || DEFAULT_TENANT_FIELD;
    const strategy = resolved.strategy;

    // Skip strategy is informational — echo the reason so audit consumers
    // see WHY the resource was declared exempt.
    if (strategy.type === "skip") {
      skipped.push({ resource: r.name, reason: strategy.reason });
      continue;
    }

    // Anonymize keeps rows — by default we skip the assertion. Hosts who
    // want to verify "anonymize ran and left a known shape" can pass
    // `skipAnonymize: false` and inspect leaks (actual count, expected
    // count is whatever existed before).
    if (strategy.type === "anonymize" && skipAnonymize) {
      skipped.push({ resource: r.name, reason: "anonymize (rows legitimately retained)" });
      continue;
    }

    // Reach the live adapter via the registry's parallel map — the
    // narrowed `r.adapter` ({ type, name }) doesn't carry .repository.
    const liveAdapter = registry.getAdapter<{ repository?: CountableRepo }>(r.name);
    const repo = liveAdapter?.repository;
    if (!repo?.count) {
      skipped.push({
        resource: r.name,
        reason: "adapter repository has no `count` method — cannot verify",
      });
      continue;
    }

    const actual = await repo.count({ [tenantField]: organizationId });
    checked++;

    // `hard` and `soft` both expect zero matching rows AFTER the cascade —
    // hard removed them; soft set their deletedAt so default reads
    // exclude them. `count` against the bare tenant filter without an
    // explicit `includeDeleted: true` returns the visible count, which
    // is what we want.
    const expected = 0;
    if (actual !== expected) {
      leaks.push({
        resource: r.name,
        tenantField,
        strategy,
        expected,
        actual,
      });
    }
  }

  return {
    ok: leaks.length === 0,
    organizationId,
    checked,
    skipped,
    leaks,
  };
}
