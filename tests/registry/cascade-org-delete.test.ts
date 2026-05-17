/**
 * Tests for cascade-on-org-delete (v2.15.5).
 *
 * Locks in the fix for the OpenAI-team report: every multi-tenant host on
 * Arc used to hand-roll a per-resource `org-cleanup.ts` plus a smoke
 * probe to verify nothing leaks on org delete. Arc now owns the iterator
 * — opt resources in with `cascade: true`, and call
 * `cascadeDeleteForOrganization(registry, { organizationId })` from the
 * host's auth lifecycle.
 *
 * Contract this file locks in:
 *  - Flagged resources are deleted; unflagged stay intact.
 *  - `getCascadingResources(registry)` lists the flagged set — audit
 *    scripts get a one-line answer to "are we leaking on org delete?".
 *  - `skip` excludes flagged resources from the cascade; `only` narrows.
 *  - `tenantField: false` on a flagged resource throws at boot (a config
 *    bug — company-wide tables can't be cascaded).
 *  - Per-resource failures are captured in the report; the cascade
 *    continues across other resources (the helper doesn't abort on one
 *    failed adapter call).
 *  - The report carries timing + counts so audit tooling can verify.
 */

import { describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  cascadeDeleteForOrganization,
  getCascadingResources,
} from "../../src/registry/cascadeOrgDelete.js";
import { ResourceRegistry } from "../../src/registry/ResourceRegistry.js";

const ORG_A = "507f1f77bcf86cd799439011";

interface DeleteManyCall {
  filter: Record<string, unknown>;
}

/**
 * Stub adapter that records every `deleteMany` call so tests can assert
 * the filter the cascade sent. Returns a configurable deletedCount so we
 * can verify the report rolls them up.
 */
function stubAdapter(opts: {
  name: string;
  type?: string;
  deletedCount?: number;
  throws?: Error;
}) {
  const calls: DeleteManyCall[] = [];
  return {
    type: opts.type ?? "mongoose",
    name: opts.name,
    calls,
    repository: {
      deleteMany: vi.fn(async (filter: Record<string, unknown>) => {
        calls.push({ filter });
        if (opts.throws) throw opts.throws;
        return { deletedCount: opts.deletedCount ?? 1 };
      }),
    },
  };
}

function buildResource(opts: {
  name: string;
  adapter: ReturnType<typeof stubAdapter>;
  /** When true, declares `onTenantDelete: { strategy: { type: 'hard' } }`. */
  cascade?: boolean;
  tenantField?: string | false;
}) {
  return defineResource({
    name: opts.name,
    prefix: `/${opts.name}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: opts.adapter as any,
    permissions: { list: allowPublic(), get: allowPublic() },
    disableDefaultRoutes: true,
    ...(opts.cascade ? { onTenantDelete: { strategy: { type: "hard" as const } } } : {}),
    ...(opts.tenantField !== undefined ? { tenantField: opts.tenantField } : {}),
  });
}

describe("cascadeDeleteForOrganization", () => {
  it("deletes rows in every flagged resource, scoped to the org", async () => {
    const invoicesAdapter = stubAdapter({ name: "invoices", deletedCount: 5 });
    const timesheetsAdapter = stubAdapter({ name: "timesheets", deletedCount: 12 });
    const settingsAdapter = stubAdapter({ name: "settings" });

    const invoices = buildResource({
      name: "invoice",
      adapter: invoicesAdapter,
      cascade: true,
    });
    const timesheets = buildResource({
      name: "timesheet",
      adapter: timesheetsAdapter,
      cascade: true,
    });
    // NOT cascade-flagged — must stay intact.
    const settings = buildResource({ name: "setting", adapter: settingsAdapter });

    const registry = new ResourceRegistry();
    registry.register(invoices);
    registry.register(timesheets);
    registry.register(settings);

    const report = await cascadeDeleteForOrganization(registry, { organizationId: ORG_A });

    // Both flagged resources got the org-scoped delete; settings was untouched.
    expect(invoicesAdapter.calls).toEqual([{ filter: { organizationId: ORG_A } }]);
    expect(timesheetsAdapter.calls).toEqual([{ filter: { organizationId: ORG_A } }]);
    expect(settingsAdapter.calls).toEqual([]);

    // Report shape — counts + zero failures.
    expect(report.organizationId).toBe(ORG_A);
    expect(report.failures).toEqual([]);
    expect(report.successes.map((r) => r.resource).sort()).toEqual(["invoice", "timesheet"]);
    expect(report.totalDeleted).toBe(17);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("uses the resource's `tenantField` override (workspaceId, tenantId, etc.)", async () => {
    const projectsAdapter = stubAdapter({ name: "projects", deletedCount: 3 });
    const projects = buildResource({
      name: "project",
      adapter: projectsAdapter,
      cascade: true,
      tenantField: "workspaceId",
    });

    const registry = new ResourceRegistry();
    registry.register(projects);

    await cascadeDeleteForOrganization(registry, { organizationId: ORG_A });

    // Cascade filtered by the configured field name, not the default.
    expect(projectsAdapter.calls).toEqual([{ filter: { workspaceId: ORG_A } }]);
  });

  it("throws at boot when a flagged resource declares `tenantField: false`", async () => {
    // Company-wide resources can't be cascaded — that's a config bug
    // (the helper has no way to scope to a single org). Fail closed at
    // `defineResource()` time — the strategy resolver runs in the
    // ResourceDefinition constructor, so a misconfig surfaces at boot
    // rather than on the first cascade call.
    const lookupAdapter = stubAdapter({ name: "lookup" });
    expect(() =>
      buildResource({
        name: "lookup",
        adapter: lookupAdapter,
        cascade: true,
        tenantField: false,
      }),
    ).toThrow(/tenantField: false/);
    // No I/O happened — boot validation runs before any adapter call.
    expect(lookupAdapter.calls).toEqual([]);
  });

  it("captures per-resource failures and continues with the rest", async () => {
    // One adapter throws (network blip, permission error, schema mismatch),
    // the rest must still complete. Hosts get a structured report and
    // decide whether to re-throw or just alert.
    const okAdapter = stubAdapter({ name: "ok", deletedCount: 2 });
    const failingAdapter = stubAdapter({
      name: "failing",
      throws: new Error("network unreachable"),
    });

    const ok = buildResource({ name: "ok", adapter: okAdapter, cascade: true });
    const failing = buildResource({
      name: "failing",
      adapter: failingAdapter,
      cascade: true,
    });

    const registry = new ResourceRegistry();
    registry.register(ok);
    registry.register(failing);

    const report = await cascadeDeleteForOrganization(registry, { organizationId: ORG_A });

    expect(report.successes.map((r) => r.resource)).toContain("ok");
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].resource).toBe("failing");
    expect(report.failures[0].error?.message).toContain("network unreachable");
    // Both adapters were called — failures don't short-circuit later resources.
    expect(okAdapter.calls).toHaveLength(1);
    expect(failingAdapter.calls).toHaveLength(1);
  });

  it("honors the `skip` list — flagged resources can be excluded per call", async () => {
    const auditAdapter = stubAdapter({ name: "audit", deletedCount: 100 });
    const invoicesAdapter = stubAdapter({ name: "invoices", deletedCount: 3 });

    const audit = buildResource({
      name: "audit-log",
      adapter: auditAdapter,
      cascade: true,
    });
    const invoices = buildResource({
      name: "invoice",
      adapter: invoicesAdapter,
      cascade: true,
    });

    const registry = new ResourceRegistry();
    registry.register(audit);
    registry.register(invoices);

    // SOX retention scenario — keep audit log even on cascade.
    const report = await cascadeDeleteForOrganization(registry, {
      organizationId: ORG_A,
      skip: ["audit-log"],
    });

    expect(report.resources.map((r) => r.resource)).toEqual(["invoice"]);
    expect(auditAdapter.calls).toEqual([]);
    expect(invoicesAdapter.calls).toHaveLength(1);
  });

  it("honors the `only` list — cascade narrowed to specific resources", async () => {
    const aAdapter = stubAdapter({ name: "a" });
    const bAdapter = stubAdapter({ name: "b" });
    const cAdapter = stubAdapter({ name: "c" });
    const a = buildResource({ name: "a", adapter: aAdapter, cascade: true });
    const b = buildResource({ name: "b", adapter: bAdapter, cascade: true });
    const c = buildResource({ name: "c", adapter: cAdapter, cascade: true });

    const registry = new ResourceRegistry();
    registry.register(a);
    registry.register(b);
    registry.register(c);

    const report = await cascadeDeleteForOrganization(registry, {
      organizationId: ORG_A,
      only: ["b"],
    });

    expect(report.resources.map((r) => r.resource)).toEqual(["b"]);
    expect(aAdapter.calls).toEqual([]);
    expect(bAdapter.calls).toHaveLength(1);
    expect(cAdapter.calls).toEqual([]);
  });

  it("throws when `organizationId` is missing — fail closed", async () => {
    const registry = new ResourceRegistry();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cascadeDeleteForOrganization(registry, { organizationId: "" } as any),
    ).rejects.toThrow(/organizationId/);
  });
});

describe("getCascadingResources", () => {
  it("returns the names of flagged resources only", () => {
    const aAdapter = stubAdapter({ name: "a" });
    const bAdapter = stubAdapter({ name: "b" });
    const cAdapter = stubAdapter({ name: "c" });
    const a = buildResource({ name: "a", adapter: aAdapter, cascade: true });
    const b = buildResource({ name: "b", adapter: bAdapter }); // not flagged
    const c = buildResource({ name: "c", adapter: cAdapter, cascade: true });

    const registry = new ResourceRegistry();
    registry.register(a);
    registry.register(b);
    registry.register(c);

    // The one-liner answer to "what cascades on org delete?" — used by
    // audit scripts so the answer doesn't drift from the actual wiring.
    expect([...getCascadingResources(registry)].sort()).toEqual(["a", "c"]);
  });

  it("returns an empty array when no resource opts in (safe default)", () => {
    const aAdapter = stubAdapter({ name: "a" });
    const a = buildResource({ name: "a", adapter: aAdapter });
    const registry = new ResourceRegistry();
    registry.register(a);
    expect(getCascadingResources(registry)).toEqual([]);
  });
});
