/**
 * Compliance-grade tenant-cleanup surface — the `onTenantDelete`
 * declaration, strategy resolution, and `assertNoTenantData` smoke
 * harness.
 *
 * Contract this file locks in:
 *  - `onTenantDelete: { strategy: { type: 'hard'|'soft'|'anonymize'|'skip' } }`
 *    flows through resolution + execution.
 *  - Resources without `onTenantDelete` resolve to `disabled` (skipped).
 *  - `skip` strategy is a no-op + echoes the declared reason.
 *  - Priority orders the cascade — lower runs first.
 *  - `assertNoTenantData` reports clean when cleanup ran; flags leaks
 *    when a resource isn't actually wired.
 */

import { describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import { assertNoTenantData } from "../../src/registry/assertNoTenantData.js";
import {
  cascadeDeleteForOrganization,
  getCascadingResourcesWithMetadata,
} from "../../src/registry/cascadeOrgDelete.js";
import { ResourceRegistry } from "../../src/registry/ResourceRegistry.js";
import type { OnTenantDeleteConfig } from "../../src/types/resource.js";

const ORG = "test-org";

/**
 * Spy adapter that captures `purgeByField` calls + a synthetic row store
 * so `assertNoTenantData` (which calls `count`) has real numbers to read.
 */
function makeAdapter(opts: { name: string; seedRows?: number; tenantField?: string }) {
  const tenantField = opts.tenantField ?? "organizationId";
  const purgeCalls: Array<{
    field: string;
    value: unknown;
    strategy: unknown;
    options: unknown;
  }> = [];
  // Synthetic row count — bumped down by hard/soft, reset by anonymize,
  // untouched by skip.
  let rows = opts.seedRows ?? 5;

  return {
    type: "mongoose",
    name: opts.name,
    purgeCalls,
    get rows() {
      return rows;
    },
    repository: {
      purgeByField: vi.fn(
        async (
          field: string,
          value: unknown,
          strategy: { type: string; reason?: string },
          options: unknown,
        ) => {
          purgeCalls.push({ field, value, strategy, options });
          let processed = 0;
          if (strategy.type === "hard" || strategy.type === "soft") {
            processed = rows;
            rows = 0;
          } else if (strategy.type === "anonymize") {
            processed = rows; // rows stay, just anonymized
          }
          return {
            strategy: strategy.type,
            processed,
            ok: true,
            durationMs: 1,
            ...(strategy.type === "skip" ? { skipReason: strategy.reason } : {}),
          };
        },
      ),
      count: vi.fn(async (_filter: Record<string, unknown>) => rows),
    },
  };
}

function buildResource(opts: {
  name: string;
  adapter: ReturnType<typeof makeAdapter>;
  onTenantDelete?: OnTenantDeleteConfig;
  tenantField?: string;
  presets?: string[];
}) {
  return defineResource({
    name: opts.name,
    prefix: `/${opts.name}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: opts.adapter as any,
    permissions: { list: allowPublic(), get: allowPublic() },
    disableDefaultRoutes: true,
    ...(opts.onTenantDelete ? { onTenantDelete: opts.onTenantDelete } : {}),
    ...(opts.tenantField !== undefined ? { tenantField: opts.tenantField } : {}),
    ...(opts.presets ? { presets: opts.presets } : {}),
  });
}

describe("onTenantDelete — strategy resolution", () => {
  it("rich declaration wins: source = 'declared'", () => {
    const adapter = makeAdapter({ name: "invoice" });
    const r = buildResource({
      name: "invoice",
      adapter,
      onTenantDelete: { strategy: { type: "anonymize", fields: { email: null } } },
    });

    expect(r.resolvedTenantPurge.strategy.type).toBe("anonymize");
    expect(r.resolvedTenantPurge.source).toBe("declared");
  });

  it("no `onTenantDelete` set → source = 'disabled' with skip-reason", () => {
    const adapter = makeAdapter({ name: "loose" });
    const r = buildResource({ name: "loose", adapter });

    expect(r.resolvedTenantPurge.strategy.type).toBe("skip");
    expect(r.resolvedTenantPurge.source).toBe("disabled");
    expect((r.resolvedTenantPurge.strategy as { reason: string }).reason).toMatch(/declared/i);
  });

  it("priority defaults to 100, honored when explicit", () => {
    const adapter = makeAdapter({ name: "x" });
    const r1 = buildResource({
      name: "r1",
      adapter,
      onTenantDelete: { strategy: { type: "hard" } },
    });
    const r2 = buildResource({
      name: "r2",
      adapter,
      onTenantDelete: { strategy: { type: "hard" }, priority: 10 },
    });

    expect(r1.resolvedTenantPurge.priority).toBe(100);
    expect(r2.resolvedTenantPurge.priority).toBe(10);
  });
});

describe("cascadeDeleteForOrganization — onTenantDelete path", () => {
  it("hard strategy: calls purgeByField with type:'hard'", async () => {
    const adapter = makeAdapter({ name: "log", seedRows: 3 });
    const r = buildResource({
      name: "log",
      adapter,
      onTenantDelete: { strategy: { type: "hard" } },
    });

    const registry = new ResourceRegistry();
    registry.register(r);

    const report = await cascadeDeleteForOrganization(registry, { organizationId: ORG });

    expect(report.failures).toEqual([]);
    expect(adapter.purgeCalls).toHaveLength(1);
    expect(adapter.purgeCalls[0].field).toBe("organizationId");
    expect(adapter.purgeCalls[0].value).toBe(ORG);
    expect(adapter.purgeCalls[0].strategy).toEqual({ type: "hard" });
    // 2.17 — `strategy` is now the full discriminated union (was just the
    // `.type` tag pre-2.17). Auditors need `reason` on skip / `fields`
    // on anonymize — exposing the whole shape is the forcing function.
    expect(report.resources[0].strategy).toEqual({ type: "hard" });
    expect(report.resources[0].path).toBe("purgeByField");
  });

  it("anonymize strategy: rows retained but flagged in report", async () => {
    const adapter = makeAdapter({ name: "invoice", seedRows: 4 });
    const r = buildResource({
      name: "invoice",
      adapter,
      onTenantDelete: {
        strategy: { type: "anonymize", fields: { customerEmail: null } },
      },
    });

    const registry = new ResourceRegistry();
    registry.register(r);

    const report = await cascadeDeleteForOrganization(registry, { organizationId: ORG });

    expect(adapter.purgeCalls[0].strategy).toMatchObject({ type: "anonymize" });
    // Full strategy surfaces in the report — `fields` map included so
    // GDPR audit can verify which columns got anonymized.
    expect(report.resources[0].strategy).toEqual({
      type: "anonymize",
      fields: { customerEmail: null },
    });
    expect(report.resources[0].deletedCount).toBe(4); // processed, not physically deleted
    expect(adapter.rows).toBe(4); // rows survived
  });

  it("skip strategy: no purge call, reason surfaces in report", async () => {
    const adapter = makeAdapter({ name: "ledger", seedRows: 7 });
    const r = buildResource({
      name: "ledger",
      adapter,
      onTenantDelete: {
        strategy: { type: "skip", reason: "audit-retained-per-SOX" },
      },
    });

    const registry = new ResourceRegistry();
    registry.register(r);

    const report = await cascadeDeleteForOrganization(registry, { organizationId: ORG });

    expect(adapter.purgeCalls).toHaveLength(0);
    // `reason` lands on both `.strategy.reason` (typed) and `.skipReason`
    // (legacy convenience field). Auditors who narrow on `.strategy.type
    // === 'skip'` get the typed access; the flat `skipReason` is the
    // back-compat path for code that already destructured it.
    expect(report.resources[0].strategy).toEqual({
      type: "skip",
      reason: "audit-retained-per-SOX",
    });
    expect(report.resources[0].skipReason).toBe("audit-retained-per-SOX");
    expect(adapter.rows).toBe(7); // untouched
  });

  it("priority ordering: lower runs first", async () => {
    const callOrder: string[] = [];
    const lateAdapter = makeAdapter({ name: "late" });
    const earlyAdapter = makeAdapter({ name: "early" });
    // Intercept to record order.
    lateAdapter.repository.purgeByField = vi.fn(async () => {
      callOrder.push("late");
      return { strategy: "hard", processed: 0, ok: true, durationMs: 0 };
    });
    earlyAdapter.repository.purgeByField = vi.fn(async () => {
      callOrder.push("early");
      return { strategy: "hard", processed: 0, ok: true, durationMs: 0 };
    });

    const late = buildResource({
      name: "late",
      adapter: lateAdapter,
      onTenantDelete: { strategy: { type: "hard" }, priority: 90 },
    });
    const early = buildResource({
      name: "early",
      adapter: earlyAdapter,
      onTenantDelete: { strategy: { type: "hard" }, priority: 10 },
    });

    const registry = new ResourceRegistry();
    // Register late FIRST to prove priority sorts, not insertion order.
    registry.register(late);
    registry.register(early);

    await cascadeDeleteForOrganization(registry, { organizationId: ORG });

    expect(callOrder).toEqual(["early", "late"]);
  });
});

describe("getCascadingResourcesWithMetadata", () => {
  it("returns resolved strategy + source per cascading resource", () => {
    const a = buildResource({
      name: "a",
      adapter: makeAdapter({ name: "a" }),
      onTenantDelete: { strategy: { type: "hard" }, priority: 20 },
    });
    const b = buildResource({
      name: "b",
      adapter: makeAdapter({ name: "b" }),
      onTenantDelete: { strategy: { type: "anonymize", fields: { email: null } } },
    });
    const c = buildResource({ name: "c", adapter: makeAdapter({ name: "c" }) }); // not flagged

    const registry = new ResourceRegistry();
    registry.register(a);
    registry.register(b);
    registry.register(c);

    const meta = getCascadingResourcesWithMetadata(registry);
    const byName = Object.fromEntries(meta.map((m) => [m.name, m]));

    expect(meta).toHaveLength(2);
    // 2.17 — `strategy` is the full discriminated union now, not just the tag.
    expect(byName.a.strategy).toEqual({ type: "hard" });
    expect(byName.a.source).toBe("declared");
    expect(byName.a.priority).toBe(20);
    expect(byName.b.strategy).toMatchObject({ type: "anonymize" });
    expect(byName.b.source).toBe("declared");
    expect(byName.c).toBeUndefined();
  });
});

describe("assertNoTenantData", () => {
  it("returns ok:true after a clean hard-cascade", async () => {
    const adapter = makeAdapter({ name: "log", seedRows: 6 });
    const r = buildResource({
      name: "log",
      adapter,
      onTenantDelete: { strategy: { type: "hard" } },
    });

    const registry = new ResourceRegistry();
    registry.register(r);

    await cascadeDeleteForOrganization(registry, { organizationId: ORG });
    const audit = await assertNoTenantData(registry, { organizationId: ORG });

    expect(audit.ok).toBe(true);
    expect(audit.checked).toBe(1);
    expect(audit.leaks).toEqual([]);
  });

  it("flags leaks when cascade was never run", async () => {
    const adapter = makeAdapter({ name: "log", seedRows: 4 });
    const r = buildResource({
      name: "log",
      adapter,
      onTenantDelete: { strategy: { type: "hard" } },
    });

    const registry = new ResourceRegistry();
    registry.register(r);

    // No cascade — rows still present.
    const audit = await assertNoTenantData(registry, { organizationId: ORG });

    expect(audit.ok).toBe(false);
    expect(audit.leaks).toHaveLength(1);
    // 2.17 — leak entries carry the full strategy union (was just `.type`
    // pre-2.17). Auditors who narrow on `.strategy.type === 'skip'` get
    // typed access to `reason` without re-resolving from the registry.
    expect(audit.leaks[0]).toMatchObject({
      resource: "log",
      strategy: { type: "hard" },
      expected: 0,
      actual: 4,
    });
  });

  it("skip strategy is reported as skipped with its reason", async () => {
    const adapter = makeAdapter({ name: "ledger", seedRows: 9 });
    const r = buildResource({
      name: "ledger",
      adapter,
      onTenantDelete: {
        strategy: { type: "skip", reason: "audit-retained-per-SOX" },
      },
    });

    const registry = new ResourceRegistry();
    registry.register(r);

    const audit = await assertNoTenantData(registry, { organizationId: ORG });

    expect(audit.ok).toBe(true);
    expect(audit.leaks).toEqual([]);
    expect(audit.skipped).toContainEqual({
      resource: "ledger",
      reason: "audit-retained-per-SOX",
    });
  });

  it("anonymize is skipped by default (rows legitimately retained)", async () => {
    const adapter = makeAdapter({ name: "invoice", seedRows: 12 });
    const r = buildResource({
      name: "invoice",
      adapter,
      onTenantDelete: {
        strategy: { type: "anonymize", fields: { customerName: "[REDACTED]" } },
      },
    });

    const registry = new ResourceRegistry();
    registry.register(r);

    await cascadeDeleteForOrganization(registry, { organizationId: ORG });
    const audit = await assertNoTenantData(registry, { organizationId: ORG });

    expect(audit.ok).toBe(true);
    expect(audit.checked).toBe(0); // anonymize skipped from the assertion set
    expect(audit.skipped.some((s) => s.resource === "invoice")).toBe(true);
  });
});
