/**
 * `purgeResource` — per-resource strategy dispatch, incl. the authoritative
 * cleanup guard (`requireChunked`) that refuses the legacy unbounded
 * `deleteMany` fallback (data-cleanup design §6.5).
 */

import type { TenantPurgeStrategy } from "@classytic/repo-core/repository";
import { describe, expect, it, vi } from "vitest";
import { purgeResource } from "../../src/registry/purgeResource.js";
import type { ResolvedTenantPurge } from "../../src/types/resource/index.js";

function resolved(strategy: TenantPurgeStrategy, batchSize = 500): ResolvedTenantPurge {
  return { strategy, batchSize, priority: 0, source: "declared" } as ResolvedTenantPurge;
}

const HARD: TenantPurgeStrategy = { type: "hard" };
const SOFT: TenantPurgeStrategy = { type: "soft" };

describe("purgeResource", () => {
  it("prefers the chunked purgeByField primitive when present", async () => {
    const purgeByField = vi.fn(async () => ({
      strategy: "hard" as const,
      processed: 42,
      ok: true,
      durationMs: 3,
    }));
    const out = await purgeResource("orders", "organizationId", "org-1", resolved(HARD), {
      purgeByField,
    });
    expect(out.path).toBe("purgeByField");
    expect(out.processed).toBe(42);
    expect(purgeByField).toHaveBeenCalledWith("organizationId", "org-1", HARD, expect.any(Object));
  });

  it("falls back to legacy deleteMany for hard strategy on a legacy adapter", async () => {
    const deleteMany = vi.fn(async () => ({ deletedCount: 7 }));
    const out = await purgeResource("orders", "organizationId", "org-1", resolved(HARD), {
      deleteMany,
    });
    expect(out.path).toBe("legacy-deleteMany");
    expect(out.processed).toBe(7);
    expect(deleteMany).toHaveBeenCalledWith({ organizationId: "org-1" });
  });

  it("refuses the unbounded fallback when requireChunked is set (authoritative cleanup)", async () => {
    const deleteMany = vi.fn(async () => ({ deletedCount: 7 }));
    const out = await purgeResource(
      "orders",
      "organizationId",
      "org-1",
      resolved(HARD),
      { deleteMany },
      { requireChunked: true },
    );
    expect(out.ok).toBe(false);
    expect(out.path).toBe("unsupported");
    expect(out.error?.code).toBe("arc.purge.chunked_required");
    // The unbounded delete must NEVER run.
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("requireChunked still routes through purgeByField when the adapter has it", async () => {
    const purgeByField = vi.fn(async () => ({
      strategy: "hard" as const,
      processed: 5,
      ok: true,
      durationMs: 1,
    }));
    const out = await purgeResource(
      "orders",
      "organizationId",
      "org-1",
      resolved(HARD),
      { purgeByField },
      { requireChunked: true },
    );
    expect(out.path).toBe("purgeByField");
    expect(purgeByField).toHaveBeenCalledOnce();
  });

  it("returns unsupported for a non-hard strategy on a legacy adapter (even without requireChunked)", async () => {
    const deleteMany = vi.fn(async () => ({ deletedCount: 7 }));
    const out = await purgeResource("orders", "organizationId", "org-1", resolved(SOFT), {
      deleteMany,
    });
    expect(out.ok).toBe(false);
    expect(out.path).toBe("unsupported");
    expect(out.error?.code).toBe("arc.purge.unsupported_strategy");
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("skips a skip strategy with no I/O", async () => {
    const deleteMany = vi.fn();
    const out = await purgeResource(
      "orders",
      "organizationId",
      "org-1",
      resolved({ type: "skip", reason: "retention-owned" }),
      { deleteMany },
    );
    expect(out.path).toBe("skipped");
    expect(out.skipReason).toBe("retention-owned");
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
