/**
 * Distributed-correctness hardening — the guarantees added after external
 * review: exclusive worker leases, finalizing recovery WITHOUT re-execution,
 * fence tokens, per-domain failure handling (verify/finalize), admission-guarded
 * retry, enqueue-failure containment, audited cancellation evidence, item-blocker
 * union, failures-first check truncation, declared evidence strategy.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type CleanupLimits,
  type CleanupRecipe,
  type CleanupWriteFence,
  createCleanupRegistry,
  createCleanupService,
} from "../../src/cleanup/index.js";
import {
  actor,
  draftsRecipe,
  fixedNow,
  manualQueue,
  memEvidenceStore,
  memRunStore,
  must,
  seqId,
} from "./_harness.ts";

function makeService(
  recipe: CleanupRecipe,
  opts: {
    writeFence?: CleanupWriteFence;
    limits?: Partial<CleanupLimits>;
    leaseMs?: number;
  } = {},
) {
  const now = fixedNow();
  const runStore = memRunStore(now); // same clock as the service — lease liveness agrees
  const evidenceStore = memEvidenceStore();
  const queue = manualQueue();
  const service = createCleanupService({
    registry: createCleanupRegistry([recipe]),
    runStore,
    evidenceStore,
    jobQueue: queue,
    writeFence: opts.writeFence,
    limits: opts.limits,
    leaseMs: opts.leaseMs,
    generateId: seqId(),
    now,
  });
  return { service, runStore, evidenceStore, queue };
}

async function previewAndExecute(h: ReturnType<typeof makeService>) {
  const plan = await h.service.preview({ recipeId: "cleanup.drafts", actor });
  const run = await h.service.execute({
    recipeId: "cleanup.drafts",
    actor,
    planDigest: plan.digest,
    reason: "cleaning",
    confirmation: "REMOVE DRAFTS",
  });
  return { plan, run };
}

describe("cleanup hardening — exclusive leases + recovery", () => {
  it("claim is EXCLUSIVE: a duplicate job for a live running run executes the recipe once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const executed = vi.fn();
    const h = makeService(
      draftsRecipe({
        execute: async (_p, ctx) => {
          executed();
          await gate; // hold the run in running with a LIVE lease
          await ctx.onStep({ resource: "orders", processed: 3, ok: true });
          return { status: "completed", results: [{ resource: "orders", processed: 3, ok: true }] };
        },
      }),
    );
    const { run } = await previewAndExecute(h);
    const first = h.service.processRun(run.id);
    await Promise.resolve(); // let the first worker claim + start executing
    await h.service.processRun(run.id); // duplicate delivery — must refuse the claim
    release();
    await first;
    expect(executed).toHaveBeenCalledTimes(1);
    expect(must(h.runStore.runs.get(run.id)).status).toBe("completed");
    expect(h.evidenceStore.evidence).toHaveLength(1);
  });

  it("finalizing recovery replays ONLY finalization from the persisted payload — never re-executes", async () => {
    const executed = vi.fn();
    const h = makeService(
      draftsRecipe({
        execute: async () => {
          executed();
          return { status: "completed", results: [{ resource: "orders", processed: 9, ok: true }] };
        },
      }),
    );
    const { run } = await previewAndExecute(h);
    // Simulate a worker that crashed AFTER persisting the finalization payload
    // (entering finalizing) but BEFORE evidence + terminal CAS; lease expired.
    const cur = must(h.runStore.runs.get(run.id));
    h.runStore.runs.set(run.id, {
      ...cur,
      status: "finalizing",
      startedAt: new Date("2026-07-24T00:00:00.000Z"),
      leaseToken: "dead-worker",
      leaseExpiresAt: new Date("2026-07-23T23:00:00.000Z"), // expired
      finalization: {
        status: "completed",
        results: [{ resource: "orders", processed: 9, ok: true }],
        verification: { ok: true, checks: [{ name: "no drafts remain", ok: true }] },
      },
    });
    await h.service.processRun(run.id);
    expect(executed).not.toHaveBeenCalled(); // recovery NEVER re-runs the recipe
    expect(must(h.runStore.runs.get(run.id)).status).toBe("completed");
    expect(h.evidenceStore.evidence).toHaveLength(1);
    expect(must(h.evidenceStore.manifests[0]).results).toEqual([
      { resource: "orders", processed: 9, ok: true },
    ]);
  });

  it("a thrown evidenceStore.finalize leaves the run recoverable in finalizing and re-enqueues it", async () => {
    const h = makeService(draftsRecipe());
    let failFinalize = true;
    const realFinalize = h.evidenceStore.finalize.bind(h.evidenceStore);
    h.evidenceStore.finalize = async (input) => {
      if (failFinalize) throw new Error("evidence db down");
      return realFinalize(input);
    };
    const { run } = await previewAndExecute(h);
    await h.service.processRun(run.id);
    const stuck = must(h.runStore.runs.get(run.id));
    expect(stuck.status).toBe("finalizing"); // payload persisted, recoverable
    expect(stuck.finalization?.status).toBe("completed");
    expect(h.queue.jobs.filter((j) => j.runId === run.id).length).toBeGreaterThanOrEqual(2); // re-enqueued
    // Simulate lease expiry, then the redelivered job re-finalizes WITHOUT re-executing.
    h.runStore.runs.set(run.id, { ...stuck, leaseExpiresAt: new Date("2026-07-23T00:00:00.000Z") });
    failFinalize = false;
    await h.service.processRun(run.id);
    expect(must(h.runStore.runs.get(run.id)).status).toBe("completed");
    expect(h.evidenceStore.evidence).toHaveLength(1);
  });

  it("write fence tokens round-trip: release receives the token acquire returned", async () => {
    const releases: Array<{ operationId: string; token?: string | undefined }> = [];
    const fence: CleanupWriteFence = {
      acquire: async () => "fence-token-1",
      release: async (operationId, token) => {
        releases.push({ operationId, token });
      },
    };
    const h = makeService(draftsRecipe(), { writeFence: fence });
    const { run } = await previewAndExecute(h);
    await h.service.processRun(run.id);
    expect(releases).toHaveLength(1);
    expect(must(releases[0]).token).toBe("fence-token-1");
    expect(must(h.runStore.runs.get(run.id)).status).toBe("completed");
  });
});

describe("cleanup hardening — failure domains + admission", () => {
  it("a thrown verify() is its own failure domain: run fails with failure evidence, never stranded running", async () => {
    const h = makeService(
      draftsRecipe({
        verify: async () => {
          throw new Error("verify exploded");
        },
      }),
    );
    const { run } = await previewAndExecute(h);
    await h.service.processRun(run.id);
    const finished = must(h.runStore.runs.get(run.id));
    expect(finished.status).toBe("failed");
    expect(finished.failureReason).toContain("verify threw");
    expect(h.evidenceStore.evidence).toHaveLength(1);
    expect(must(h.evidenceStore.evidence[0]).status).toBe("failed");
    // The executed step results are preserved in the failure evidence.
    expect(must(h.evidenceStore.manifests[0]).results).toEqual([
      { resource: "orders", processed: 3, ok: true },
    ]);
  });

  it("retry goes through the SAME admission guard — refused while another destructive run is active", async () => {
    let fail = true;
    const h = makeService(
      draftsRecipe({
        execute: async () => {
          if (fail) {
            fail = false;
            return {
              status: "failed",
              results: [{ resource: "orders", processed: 0, ok: false, error: "boom" }],
            };
          }
          return { status: "completed", results: [{ resource: "orders", processed: 3, ok: true }] };
        },
      }),
    );
    const { run: runA } = await previewAndExecute(h);
    await h.service.processRun(runA.id); // fails
    expect(must(h.runStore.runs.get(runA.id)).status).toBe("failed");
    // A second destructive run is admitted (A is terminal) and stays queued.
    const { run: runB } = await previewAndExecute(h);
    expect(runB.status).toBe("queued");
    // Retrying A must NOT slip past the global destructive guard while B is active.
    await expect(h.service.retry(runA.id)).rejects.toMatchObject({
      code: "CLEANUP_ALREADY_RUNNING",
    });
  });

  it("retry re-checks availability (recipe disabled after go-live is not retryable)", async () => {
    let available = true;
    const h = makeService(
      draftsRecipe({
        available: async () => ({ available, reason: "business is live" }),
        execute: async () => ({
          status: "failed",
          results: [{ resource: "orders", processed: 0, ok: false, error: "boom" }],
        }),
      }),
    );
    const { run } = await previewAndExecute(h);
    await h.service.processRun(run.id);
    available = false;
    await expect(h.service.retry(run.id)).rejects.toMatchObject({
      code: "CLEANUP_RECIPE_UNAVAILABLE",
    });
  });

  it("enqueue failure marks the run failed instead of leaving an orphaned queued run", async () => {
    const h = makeService(draftsRecipe());
    h.queue.enqueue = async () => {
      throw new Error("queue unreachable");
    };
    const plan = await h.service.preview({ recipeId: "cleanup.drafts", actor });
    await expect(
      h.service.execute({
        recipeId: "cleanup.drafts",
        actor,
        planDigest: plan.digest,
        reason: "cleaning",
        confirmation: "REMOVE DRAFTS",
      }),
    ).rejects.toThrow("queue unreachable");
    const runs = [...h.runStore.runs.values()];
    expect(runs).toHaveLength(1);
    expect(must(runs[0]).status).toBe("failed");
    expect(must(runs[0]).failureReason).toContain("enqueue failed");
  });

  it("stamps destructive + concurrencyKey; non-destructive runs are not serialized", async () => {
    const h = makeService(draftsRecipe());
    const { run } = await previewAndExecute(h);
    expect(run.destructive).toBe(true);
    expect(run.concurrencyKey).toBe("global-destructive");

    const rebuild = draftsRecipe({
      id: "cleanup.rebuild",
      destructive: false,
      plan: async () => ({ items: [{ resource: "facts", estimated: 1 }] }),
    });
    const h2 = makeService(rebuild);
    const plan = await h2.service.preview({ recipeId: "cleanup.rebuild", actor });
    const r1 = await h2.service.execute({
      recipeId: "cleanup.rebuild",
      actor,
      planDigest: plan.digest,
      reason: "rebuild",
    });
    // Second concurrent non-destructive run is ADMITTED (no concurrency key).
    const r2 = await h2.service.execute({
      recipeId: "cleanup.rebuild",
      actor,
      planDigest: plan.digest,
      reason: "rebuild again",
    });
    expect(r1.concurrencyKey).toBeUndefined();
    expect(r2.status).toBe("queued");
  });
});

describe("cleanup hardening — audit fidelity", () => {
  it("cancel persists the cancelling actor + reason and leaves evidence for a never-started run", async () => {
    const h = makeService(draftsRecipe());
    const { run } = await previewAndExecute(h);
    const canceller = { ref: "user:auditor", kind: "user" as const };
    await h.service.cancel(run.id, { actor: canceller, reason: "wrong branch selected" });
    const cancelled = must(h.runStore.runs.get(run.id));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelRequestedBy).toEqual(canceller);
    expect(cancelled.cancelReason).toBe("wrong branch selected");
    // Evidence exists even though nothing executed (processed 0, partial).
    expect(h.evidenceStore.evidence).toHaveLength(1);
    expect(must(h.evidenceStore.evidence[0]).processed).toBe(0);
    expect(must(h.evidenceStore.manifests[0]).status).toBe("cancelled");
  });

  it("item-level blockers are unioned into the sealed plan and hard-stop execution", async () => {
    const h = makeService(
      draftsRecipe({
        plan: async () => ({
          items: [
            { resource: "orders", estimated: 2, blockers: ["OPEN_TRANSFER"] },
            { resource: "journal entries", estimated: 1 },
          ],
          confirmationPhrase: "REMOVE DRAFTS",
          // NOTE: recipe "forgot" to duplicate the blocker at the top level.
        }),
      }),
    );
    const plan = await h.service.preview({ recipeId: "cleanup.drafts", actor });
    expect(plan.blockers).toEqual(["OPEN_TRANSFER"]);
    await expect(
      h.service.execute({
        recipeId: "cleanup.drafts",
        actor,
        planDigest: plan.digest,
        reason: "cleaning",
        confirmation: "REMOVE DRAFTS",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_BLOCKED" });
  });

  it("check truncation keeps failures first and records checksTruncated", async () => {
    const h = makeService(
      draftsRecipe({
        verify: async () => ({
          ok: false,
          checks: [
            { name: "a", ok: true },
            { name: "b", ok: true },
            { name: "c-failed", ok: false, detail: "drift" },
            { name: "d", ok: true },
          ],
        }),
      }),
      { limits: { maxChecks: 2 } },
    );
    const { run } = await previewAndExecute(h);
    await h.service.processRun(run.id);
    const manifest = must(h.evidenceStore.manifests[0]);
    expect(manifest.checksTruncated).toBe(2);
    expect(manifest.verification.checks.map((c) => c.name)).toContain("c-failed"); // failure survives the cap
    expect(must(h.evidenceStore.evidence[0]).verification?.note).toContain("truncated");
  });

  it("evidence records the recipe's declared strategy, not a hard-coded 'hard'", async () => {
    const h = makeService(draftsRecipe({ evidenceStrategy: "anonymize" }));
    const { run } = await previewAndExecute(h);
    await h.service.processRun(run.id);
    expect(must(h.evidenceStore.evidence[0]).strategy).toBe("anonymize");
  });
});
