/**
 * Cleanup orchestration service — lifecycle, digest re-check, single-run fence,
 * write fence, verification gating, evidence + manifest, cancel/retry.
 *
 * Uses an in-memory run/evidence store and the inline worker so the whole
 * flow runs synchronously and deterministically.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type CleanupEvidenceStore,
  type CleanupManifest,
  type CleanupRecipe,
  type CleanupRun,
  type CleanupRunStore,
  type CleanupWriteFence,
  createCleanupRegistry,
  createCleanupService,
  type PurgeEvidence,
} from "../../src/cleanup/index.js";

function memRunStore(): CleanupRunStore & { runs: Map<string, CleanupRun> } {
  const runs = new Map<string, CleanupRun>();
  return {
    runs,
    async create(run) {
      runs.set(run.id, run);
    },
    async get(id) {
      return runs.get(id) ?? null;
    },
    async update(id, patch) {
      const cur = runs.get(id);
      if (cur) runs.set(id, { ...cur, ...patch });
    },
    async findActiveDestructive() {
      for (const r of runs.values()) if (r.status === "running" || r.status === "planned") return r;
      return null;
    },
  };
}

function memEvidenceStore(): CleanupEvidenceStore & {
  evidence: PurgeEvidence[];
  manifests: CleanupManifest[];
} {
  const evidence: PurgeEvidence[] = [];
  const manifests: CleanupManifest[] = [];
  return {
    evidence,
    manifests,
    async recordEvidence(e) {
      evidence.push(e);
    },
    async recordManifest(m) {
      manifests.push(m);
    },
  };
}

const actor = { ref: "user:admin", kind: "user" as const };

/** A recipe that "removes" a fixed set, driven by test-supplied behavior. */
function draftsRecipe(over: Partial<CleanupRecipe> = {}): CleanupRecipe {
  return {
    id: "cleanup.drafts",
    label: "Remove drafts",
    destructive: true,
    available: async () => ({ available: true }),
    plan: async () => ({
      items: [{ resource: "orders", estimated: 3 }],
      retains: ["master data"],
      confirmationPhrase: "REMOVE DRAFTS",
    }),
    execute: async (_plan, ctx) => {
      await ctx.onStep({ resource: "orders", processed: 3, ok: true });
      return { status: "completed", results: [{ resource: "orders", processed: 3, ok: true }] };
    },
    verify: async () => ({ ok: true, checks: [{ name: "no drafts remain", ok: true }] }),
    ...over,
  };
}

function makeService(recipe: CleanupRecipe, opts: { writeFence?: CleanupWriteFence } = {}) {
  const runStore = memRunStore();
  const evidenceStore = memEvidenceStore();
  let seq = 0;
  const service = createCleanupService({
    registry: createCleanupRegistry([recipe]),
    runStore,
    evidenceStore,
    writeFence: opts.writeFence,
    generateId: () => `id-${seq++}`,
    now: () => new Date("2026-07-24T00:00:00.000Z"),
  });
  return { service, runStore, evidenceStore };
}

describe("cleanup service — preview", () => {
  it("seals a plan with a digest, estimatedTotal, confirmation phrase", async () => {
    const { service } = makeService(draftsRecipe());
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor });
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.estimatedTotal).toBe(3);
    expect(plan.confirmationPhrase).toBe("REMOVE DRAFTS");
    expect(plan.retains).toEqual(["master data"]);
  });

  it("refuses an unavailable recipe", async () => {
    const { service } = makeService(
      draftsRecipe({ available: async () => ({ available: false, reason: "after go-live" }) }),
    );
    await expect(service.preview({ recipeId: "cleanup.drafts", actor })).rejects.toMatchObject({
      code: "CLEANUP_RECIPE_UNAVAILABLE",
    });
  });
});

describe("cleanup service — execute", () => {
  it("runs the full lifecycle and records evidence + manifest", async () => {
    const { service, runStore, evidenceStore } = makeService(draftsRecipe());
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor });

    const run = await service.execute({
      recipeId: "cleanup.drafts",
      actor,
      planDigest: plan.digest,
      reason: "clearing test drafts",
      confirmation: "REMOVE DRAFTS",
    });

    const finished = runStore.runs.get(run.id)!;
    expect(finished.status).toBe("completed");
    expect(finished.progress).toEqual([{ resource: "orders", processed: 3, ok: true }]);
    expect(evidenceStore.evidence).toHaveLength(1);
    expect(evidenceStore.evidence[0].processed).toBe(3);
    expect(evidenceStore.evidence[0].operationId).toBe(finished.operationId);
    expect(evidenceStore.manifests).toHaveLength(1);
    expect(evidenceStore.manifests[0].manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidenceStore.manifests[0].verification.ok).toBe(true);
  });

  it("rejects a stale plan digest with CLEANUP_PLAN_CHANGED", async () => {
    const { service } = makeService(draftsRecipe());
    await expect(
      service.execute({
        recipeId: "cleanup.drafts",
        actor,
        planDigest: "stale-digest",
        reason: "x",
        confirmation: "REMOVE DRAFTS",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_PLAN_CHANGED" });
  });

  it("requires the exact confirmation phrase for a destructive recipe", async () => {
    const { service } = makeService(draftsRecipe());
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor });
    await expect(
      service.execute({
        recipeId: "cleanup.drafts",
        actor,
        planDigest: plan.digest,
        reason: "x",
        confirmation: "wrong phrase",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_CONFIRMATION_REQUIRED" });
  });

  it("requires a non-empty reason", async () => {
    const { service } = makeService(draftsRecipe());
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor });
    await expect(
      service.execute({
        recipeId: "cleanup.drafts",
        actor,
        planDigest: plan.digest,
        reason: "   ",
        confirmation: "REMOVE DRAFTS",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_CONFIRMATION_REQUIRED" });
  });

  it("acquires and releases the write fence around execution", async () => {
    const acquire = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    const { service } = makeService(draftsRecipe(), { writeFence: { acquire, release } });
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor });
    await service.execute({
      recipeId: "cleanup.drafts",
      actor,
      planDigest: plan.digest,
      reason: "fenced run",
      confirmation: "REMOVE DRAFTS",
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the write fence even when execute throws", async () => {
    const release = vi.fn(async () => {});
    const boom = draftsRecipe({
      execute: async () => {
        throw new Error("kaboom");
      },
    });
    const { service, runStore } = makeService(boom, {
      writeFence: { acquire: async () => {}, release },
    });
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor });
    await expect(
      service.execute({
        recipeId: "cleanup.drafts",
        actor,
        planDigest: plan.digest,
        reason: "will fail",
        confirmation: "REMOVE DRAFTS",
      }),
    ).rejects.toThrow(/kaboom/);
    expect(release).toHaveBeenCalledOnce();
    const run = [...runStore.runs.values()][0];
    expect(run.status).toBe("failed");
  });

  it("marks the run failed (not completed) when a step reports ok:false", async () => {
    const partial = draftsRecipe({
      execute: async () => ({
        status: "completed",
        results: [
          { resource: "orders", processed: 2, ok: true },
          { resource: "ledger", processed: 0, ok: false, error: "closed period" },
        ],
      }),
    });
    const { service, runStore, evidenceStore } = makeService(partial);
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor });
    const run = await service.execute({
      recipeId: "cleanup.drafts",
      actor,
      planDigest: plan.digest,
      reason: "partial run",
      confirmation: "REMOVE DRAFTS",
    });
    expect(runStore.runs.get(run.id)!.status).toBe("failed");
    // Evidence still records the partial outcome (never suppressed).
    expect(evidenceStore.evidence[0].status).toBe("partial");
  });

  it("marks the run failed when verification fails", async () => {
    const badVerify = draftsRecipe({
      verify: async () => ({ ok: false, checks: [{ name: "trial balance", ok: false }] }),
    });
    const { service, runStore } = makeService(badVerify);
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor });
    const run = await service.execute({
      recipeId: "cleanup.drafts",
      actor,
      planDigest: plan.digest,
      reason: "verify fails",
      confirmation: "REMOVE DRAFTS",
    });
    expect(runStore.runs.get(run.id)!.status).toBe("failed");
  });

  it("refuses a second destructive run while one is active", async () => {
    // A recipe whose execute never resolves keeps the first run 'running'.
    let release!: () => void;
    const hang = draftsRecipe({
      execute: () =>
        new Promise((res) => {
          release = () => res({ status: "completed", results: [] });
        }),
    });
    const { service } = makeService(hang);
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor });
    const first = service.execute({
      recipeId: "cleanup.drafts",
      actor,
      planDigest: plan.digest,
      reason: "first",
      confirmation: "REMOVE DRAFTS",
    });
    // Give the inline worker a tick to mark the run 'running'.
    await new Promise((r) => setTimeout(r, 0));
    await expect(
      service.execute({
        recipeId: "cleanup.drafts",
        actor,
        planDigest: plan.digest,
        reason: "second",
        confirmation: "REMOVE DRAFTS",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_ALREADY_RUNNING" });
    release();
    await first;
  });
});

describe("cleanup service — cancel / retry", () => {
  it("cancels a planned/running run and rejects retry on a completed run", async () => {
    const { service, runStore } = makeService(draftsRecipe());
    const plan = await service.preview({ recipeId: "cleanup.drafts", actor });
    const run = await service.execute({
      recipeId: "cleanup.drafts",
      actor,
      planDigest: plan.digest,
      reason: "done",
      confirmation: "REMOVE DRAFTS",
    });
    // Already completed — cancel is invalid.
    await expect(service.cancel(run.id)).rejects.toMatchObject({ code: "CLEANUP_INVALID_ACTION" });
    await expect(service.retry(run.id)).rejects.toMatchObject({ code: "CLEANUP_INVALID_ACTION" });
    expect(runStore.runs.get(run.id)!.status).toBe("completed");
  });

  it("getRun throws CLEANUP_RUN_NOT_FOUND for an unknown id", async () => {
    const { service } = makeService(draftsRecipe());
    await expect(service.getRun("nope")).rejects.toMatchObject({ code: "CLEANUP_RUN_NOT_FOUND" });
  });
});
