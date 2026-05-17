/**
 * Cascade concurrency + priority barriers + checkpoint resume.
 *
 * Locks in three orthogonal additions to `cascadeDeleteForOrganization`:
 *   1. Resources of identical priority can run in parallel under a
 *      `concurrency` cap.
 *   2. Priority groups are barriers — all priority-N resources finish
 *      before any priority-(N+M) starts, even under concurrency.
 *   3. A `checkpoint` plumbs to a host-owned store so cascades that
 *      crash mid-run resume from the last completed resource.
 */

import { describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  type CascadeCheckpoint,
  type CascadeCheckpointState,
  cascadeDeleteForOrganization,
} from "../../src/registry/cascadeOrgDelete.js";
import { ResourceRegistry } from "../../src/registry/ResourceRegistry.js";
import type { OnTenantDeleteConfig } from "../../src/types/resource.js";

const ORG = "test-org";

/**
 * Stub adapter — records start + finish timestamps so concurrency
 * tests can verify "ran in parallel" via overlapping intervals.
 */
function makeAdapter(opts: {
  name: string;
  delayMs?: number;
  seedRows?: number;
}) {
  const delayMs = opts.delayMs ?? 0;
  let rows = opts.seedRows ?? 3;
  const intervals: Array<{ name: string; start: number; finish: number }> = [];

  return {
    type: "mongoose",
    name: opts.name,
    intervals,
    get rows() {
      return rows;
    },
    repository: {
      purgeByField: vi.fn(
        async (
          _field: string,
          _value: unknown,
          strategy: { type: string; reason?: string },
        ) => {
          const start = Date.now();
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          const finish = Date.now();
          intervals.push({ name: opts.name, start, finish });
          const processed = strategy.type === "hard" || strategy.type === "soft" ? rows : 0;
          if (strategy.type === "hard" || strategy.type === "soft") rows = 0;
          return {
            strategy: strategy.type,
            processed,
            ok: true,
            durationMs: finish - start,
          };
        },
      ),
      count: vi.fn(async () => rows),
    },
  };
}

function buildResource(opts: {
  name: string;
  adapter: ReturnType<typeof makeAdapter>;
  onTenantDelete: OnTenantDeleteConfig;
}) {
  return defineResource({
    name: opts.name,
    prefix: `/${opts.name}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: opts.adapter as any,
    permissions: { list: allowPublic(), get: allowPublic() },
    disableDefaultRoutes: true,
    onTenantDelete: opts.onTenantDelete,
  });
}

/**
 * Tally overlap: returns true iff any two intervals overlap in time.
 * Used to assert "ran in parallel" — sequential intervals never overlap.
 */
function anyOverlap(intervals: Array<{ start: number; finish: number }>): boolean {
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i]!;
      const b = intervals[j]!;
      if (a.start < b.finish && b.start < a.finish) return true;
    }
  }
  return false;
}

describe("cascade concurrency", () => {
  it("default concurrency=1 runs resources sequentially (no overlap)", async () => {
    const a = makeAdapter({ name: "a", delayMs: 30 });
    const b = makeAdapter({ name: "b", delayMs: 30 });
    const c = makeAdapter({ name: "c", delayMs: 30 });
    const registry = new ResourceRegistry();
    registry.register(buildResource({ name: "a", adapter: a, onTenantDelete: { strategy: { type: "hard" } } }));
    registry.register(buildResource({ name: "b", adapter: b, onTenantDelete: { strategy: { type: "hard" } } }));
    registry.register(buildResource({ name: "c", adapter: c, onTenantDelete: { strategy: { type: "hard" } } }));

    await cascadeDeleteForOrganization(registry, { organizationId: ORG });

    const all = [...a.intervals, ...b.intervals, ...c.intervals];
    expect(all).toHaveLength(3);
    expect(anyOverlap(all)).toBe(false);
  });

  it("concurrency=3 runs same-priority resources in parallel (intervals overlap)", async () => {
    const a = makeAdapter({ name: "a", delayMs: 50 });
    const b = makeAdapter({ name: "b", delayMs: 50 });
    const c = makeAdapter({ name: "c", delayMs: 50 });
    const registry = new ResourceRegistry();
    registry.register(buildResource({ name: "a", adapter: a, onTenantDelete: { strategy: { type: "hard" } } }));
    registry.register(buildResource({ name: "b", adapter: b, onTenantDelete: { strategy: { type: "hard" } } }));
    registry.register(buildResource({ name: "c", adapter: c, onTenantDelete: { strategy: { type: "hard" } } }));

    const t0 = Date.now();
    await cascadeDeleteForOrganization(registry, { organizationId: ORG, concurrency: 3 });
    const elapsed = Date.now() - t0;

    const all = [...a.intervals, ...b.intervals, ...c.intervals];
    expect(all).toHaveLength(3);
    expect(anyOverlap(all)).toBe(true);
    // Wall time should be ~50ms (parallel) not ~150ms (sequential).
    // Generous threshold accommodates CI jitter.
    expect(elapsed).toBeLessThan(120);
  });

  it("priority barrier — all priority-10 finish before any priority-50 starts", async () => {
    const early1 = makeAdapter({ name: "early1", delayMs: 30 });
    const early2 = makeAdapter({ name: "early2", delayMs: 30 });
    const late1 = makeAdapter({ name: "late1", delayMs: 10 });
    const late2 = makeAdapter({ name: "late2", delayMs: 10 });

    const registry = new ResourceRegistry();
    // Register late ones FIRST to prove priority controls order, not registration.
    registry.register(buildResource({ name: "late1", adapter: late1, onTenantDelete: { strategy: { type: "hard" }, priority: 50 } }));
    registry.register(buildResource({ name: "late2", adapter: late2, onTenantDelete: { strategy: { type: "hard" }, priority: 50 } }));
    registry.register(buildResource({ name: "early1", adapter: early1, onTenantDelete: { strategy: { type: "hard" }, priority: 10 } }));
    registry.register(buildResource({ name: "early2", adapter: early2, onTenantDelete: { strategy: { type: "hard" }, priority: 10 } }));

    await cascadeDeleteForOrganization(registry, { organizationId: ORG, concurrency: 4 });

    const earlyFinish = Math.max(early1.intervals[0]!.finish, early2.intervals[0]!.finish);
    const lateStart = Math.min(late1.intervals[0]!.start, late2.intervals[0]!.start);
    // The barrier: every priority-10 resource finished before any
    // priority-50 resource started.
    expect(lateStart).toBeGreaterThanOrEqual(earlyFinish);
  });

  it("rejects concurrency < 1", async () => {
    const registry = new ResourceRegistry();
    await expect(
      cascadeDeleteForOrganization(registry, { organizationId: ORG, concurrency: 0 }),
    ).rejects.toThrow(/concurrency/);
  });
});

describe("cascade checkpoint resume", () => {
  function makeCheckpoint(initial?: CascadeCheckpointState) {
    let state: CascadeCheckpointState | undefined = initial;
    const writes: CascadeCheckpointState[] = [];
    const checkpoint: CascadeCheckpoint = {
      read: async () => state,
      write: async (next) => {
        state = next;
        writes.push({ ...next, completedResources: [...next.completedResources] });
      },
    };
    return { checkpoint, get state() { return state; }, writes };
  }

  it("writes state after each successful resource", async () => {
    const a = makeAdapter({ name: "a", seedRows: 2 });
    const b = makeAdapter({ name: "b", seedRows: 3 });
    const registry = new ResourceRegistry();
    registry.register(buildResource({ name: "a", adapter: a, onTenantDelete: { strategy: { type: "hard" } } }));
    registry.register(buildResource({ name: "b", adapter: b, onTenantDelete: { strategy: { type: "hard" } } }));

    const cp = makeCheckpoint();
    await cascadeDeleteForOrganization(registry, { organizationId: ORG, checkpoint: cp.checkpoint });

    expect(cp.state?.completedResources.sort()).toEqual(["a", "b"]);
    // One write per resource — the cascade persisted after each.
    expect(cp.writes).toHaveLength(2);
  });

  it("skips resources named in the resume state — no duplicate purge", async () => {
    const a = makeAdapter({ name: "a", seedRows: 2 });
    const b = makeAdapter({ name: "b", seedRows: 3 });
    const registry = new ResourceRegistry();
    registry.register(buildResource({ name: "a", adapter: a, onTenantDelete: { strategy: { type: "hard" } } }));
    registry.register(buildResource({ name: "b", adapter: b, onTenantDelete: { strategy: { type: "hard" } } }));

    // Prior run completed 'a'. Resume should skip it.
    const cp = makeCheckpoint({ completedResources: ["a"] });
    const report = await cascadeDeleteForOrganization(registry, {
      organizationId: ORG,
      checkpoint: cp.checkpoint,
    });

    expect(a.repository.purgeByField).not.toHaveBeenCalled();
    expect(b.repository.purgeByField).toHaveBeenCalledOnce();
    // Report shape: only 'b' (the resumed work) appears.
    expect(report.resources.map((r) => r.resource)).toEqual(["b"]);
    // Checkpoint now records both as completed.
    expect(cp.state?.completedResources.sort()).toEqual(["a", "b"]);
  });
});
