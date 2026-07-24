/**
 * Cleanup orchestration service — the framework's use-case core.
 *
 * Drives the design's lifecycle over the host-provided ports:
 *
 *   preview()  → re-plan, seal a digest, surface blockers/retains/confirmation
 *   execute()  → re-plan + digest re-check (CLEANUP_PLAN_CHANGED), availability
 *                gate, single-destructive-run fence, write fence, run the recipe
 *                off the request path, verify, record evidence + manifest
 *   getRun()   → durable run lookup
 *   act()      → cancel / retry a run
 *
 * Framework-free (no Fastify/Mongo): the Arc resource factory wraps this.
 * Reliability rules (§8): persist the run before mutating; one destructive run
 * at a time; acquire the write fence; idempotent steps; abort between chunks;
 * never report success when a step reports `ok: false`; rebuild only after
 * authoritative cleanup succeeds; release the fence on every terminal path.
 */

import { createPurgeEvidence } from "@classytic/primitives/retention";
import { CleanupErrors } from "./errors.js";
import { computeManifestDigest, computePlanDigest } from "./plan-digest.js";
import type { CleanupRegistry } from "./registry.js";
import type {
  CleanupContext,
  CleanupEvidenceStore,
  CleanupExecutionContext,
  CleanupInput,
  CleanupManifest,
  CleanupPlan,
  CleanupRecipe,
  CleanupResult,
  CleanupRun,
  CleanupStepResult,
  CleanupWorker,
  CleanupWriteFence,
  PurgeActor,
  VerificationResult,
} from "./types.js";

/** Injected id/clock generators — kept as deps so the service stays testable. */
export interface CleanupServiceDeps {
  registry: CleanupRegistry;
  runStore: import("./types.js").CleanupRunStore;
  evidenceStore: CleanupEvidenceStore;
  /** Optional write fence (§8). No-op when absent. */
  writeFence?: CleanupWriteFence | undefined;
  /** Optional worker (§8). Defaults to an inline in-process runner. */
  worker?: CleanupWorker | undefined;
  /** Id generator — defaults to `crypto.randomUUID`. */
  generateId?: () => string;
  /** Clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface PreviewInput extends CleanupInput {
  recipeId: string;
  actor: PurgeActor;
  ambient?: Readonly<Record<string, unknown>> | undefined;
}

export interface ExecuteInput extends PreviewInput {
  /** The digest the operator confirmed against — must match the re-plan. */
  planDigest: string;
  /** Non-empty justification, persisted on the run + evidence. */
  reason: string;
  /** For a destructive recipe: the exact confirmation phrase. */
  confirmation?: string | undefined;
  signal?: AbortSignal | undefined;
}

const inlineWorker: CleanupWorker = { submit: (task) => task() };

export interface CleanupService {
  preview(input: PreviewInput): Promise<CleanupPlan>;
  execute(input: ExecuteInput): Promise<CleanupRun>;
  getRun(id: string): Promise<CleanupRun>;
  cancel(id: string): Promise<CleanupRun>;
  retry(id: string): Promise<CleanupRun>;
}

export function createCleanupService(deps: CleanupServiceDeps): CleanupService {
  const { registry, runStore, evidenceStore } = deps;
  const writeFence = deps.writeFence;
  const worker = deps.worker ?? inlineWorker;
  const generateId = deps.generateId ?? (() => globalThis.crypto.randomUUID());
  const now = deps.now ?? (() => new Date());

  /** Build the ambient context a recipe method receives. */
  function context(input: PreviewInput, signal?: AbortSignal): CleanupContext {
    return { actor: input.actor, now: now(), signal, ambient: input.ambient };
  }

  /** Re-plan the recipe and seal a digest — the single source for both preview + execute. */
  async function seal(recipe: CleanupRecipe, input: PreviewInput, ctx: CleanupContext): Promise<CleanupPlan> {
    const draft = await recipe.plan({ parameters: input.parameters }, ctx);
    const items = draft.items;
    const estimatedTotal = items.reduce((sum, i) => sum + i.estimated, 0);
    const unsealed: Omit<CleanupPlan, "digest"> = {
      recipeId: recipe.id,
      parameters: input.parameters ?? {},
      items,
      retains: [...(draft.retains ?? [])],
      blockers: [...(draft.blockers ?? [])],
      rebuildActions: [...(draft.rebuildActions ?? [])],
      warnings: [...(draft.warnings ?? [])],
      estimatedTotal,
      confirmationPhrase: draft.confirmationPhrase ?? recipe.id,
    };
    return { ...unsealed, digest: computePlanDigest(unsealed) };
  }

  async function ensureAvailable(recipe: CleanupRecipe, ctx: CleanupContext): Promise<void> {
    const availability = await recipe.available(ctx);
    if (!availability.available) {
      throw CleanupErrors.unavailable(recipe.id, availability.reason ?? "unavailable");
    }
  }

  async function preview(input: PreviewInput): Promise<CleanupPlan> {
    const recipe = registry.get(input.recipeId);
    const ctx = context(input);
    await ensureAvailable(recipe, ctx);
    return seal(recipe, input, ctx);
  }

  async function execute(input: ExecuteInput): Promise<CleanupRun> {
    const recipe = registry.get(input.recipeId);
    const ctx = context(input, input.signal);

    // 1. Availability + confirmation + digest re-check (fail before any write).
    await ensureAvailable(recipe, ctx);
    const sealed = await seal(recipe, input, ctx);
    if (sealed.digest !== input.planDigest) {
      throw CleanupErrors.planChanged(sealed.digest, input.planDigest);
    }
    if (recipe.destructive && input.confirmation !== sealed.confirmationPhrase) {
      throw CleanupErrors.confirmationRequired(sealed.confirmationPhrase);
    }
    if (!input.reason || input.reason.trim().length === 0) {
      throw CleanupErrors.confirmationRequired(sealed.confirmationPhrase);
    }

    // 2. Single-destructive-run fence (§8).
    if (recipe.destructive) {
      const active = await runStore.findActiveDestructive();
      if (active) throw CleanupErrors.alreadyRunning(active.id);
    }

    // 3. Persist the run BEFORE mutating anything (§8).
    const operationId = generateId();
    const run: CleanupRun = {
      id: generateId(),
      recipeId: recipe.id,
      status: "planned",
      planDigest: sealed.digest,
      requestedBy: input.actor.ref,
      reason: input.reason,
      operationId,
      progress: [],
      startedAt: now(),
    };
    await runStore.create(run);

    // 4. Run off the request path (§8). The worker owns whether this awaits.
    await worker.submit(() => runToCompletion(recipe, sealed, run, input));
    return (await runStore.get(run.id)) ?? run;
  }

  /** The execute → verify → evidence body, fenced + status-tracked. */
  async function runToCompletion(
    recipe: CleanupRecipe,
    plan: CleanupPlan,
    run: CleanupRun,
    input: ExecuteInput,
  ): Promise<void> {
    const progress: CleanupStepResult[] = [];
    await runStore.update(run.id, { status: "running" });
    if (writeFence) await writeFence.acquire(run.operationId);

    try {
      const execCtx: CleanupExecutionContext = {
        actor: input.actor,
        now: now(),
        signal: input.signal,
        ambient: input.ambient,
        runId: run.id,
        operationId: run.operationId,
        async onStep(step) {
          progress.push(step);
          await runStore.update(run.id, { progress: [...progress] });
        },
      };

      const result: CleanupResult = await recipe.execute(plan, execCtx);
      // Never report success when a step reports ok:false (§8).
      const anyFailed = result.results.some((r) => !r.ok);
      const effectiveStatus = anyFailed && result.status === "completed" ? "partial" : result.status;

      // Verify only after authoritative cleanup (§8) — but always record what happened.
      let verification: VerificationResult = { ok: !anyFailed, checks: [] };
      if (effectiveStatus !== "failed") {
        verification = await recipe.verify(plan, {
          actor: input.actor,
          now: now(),
          signal: input.signal,
          ambient: input.ambient,
        });
      }

      const completedAt = now();
      // A run is a clean success ONLY when every step succeeded AND verification
      // passed. Partial results or a failed verification ⇒ the run is `failed`
      // (visible + retryable), never a false success (§8).
      const finalStatus: CleanupRun["status"] =
        effectiveStatus === "completed" && verification.ok ? "completed" : "failed";

      await runStore.update(run.id, {
        status: finalStatus,
        progress: result.results.length ? [...result.results] : [...progress],
        completedAt,
      });

      // Record evidence + immutable manifest (§5, §8).
      await recordEvidenceAndManifest(
        recipe,
        plan,
        run,
        input,
        result,
        effectiveStatus,
        verification,
        completedAt,
      );
    } catch (err) {
      await runStore.update(run.id, {
        status: input.signal?.aborted ? "cancelled" : "failed",
        completedAt: now(),
        progress: [...progress],
      });
      throw err;
    } finally {
      if (writeFence) await writeFence.release(run.operationId);
    }
  }

  async function recordEvidenceAndManifest(
    recipe: CleanupRecipe,
    plan: CleanupPlan,
    run: CleanupRun,
    input: ExecuteInput,
    result: CleanupResult,
    effectiveStatus: CleanupResult["status"],
    verification: VerificationResult,
    completedAt: Date,
  ): Promise<void> {
    const processed = result.results.reduce((sum, r) => sum + r.processed, 0);
    const evidence = createPurgeEvidence({
      operationId: run.operationId,
      subject: { ref: `recipe:${recipe.id}`, model: "CleanupRun" },
      scope: `recipe:${recipe.id}`,
      strategy: "hard",
      status: effectiveStatus,
      measuresRetained: plan.retains.length > 0,
      processed,
      startedAt: run.startedAt,
      completedAt,
      occurredAt: completedAt,
      actor: input.actor,
      reason: input.reason,
      results: result.results.map((r) => ({
        resource: r.resource,
        processed: r.processed,
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
      })),
      verification: {
        ok: verification.ok,
        checks: verification.checks.length,
        ...(verification.checks.length ? { note: verification.checks.map((c) => `${c.name}:${c.ok ? "ok" : "fail"}`).join(", ") } : {}),
      },
    });
    await evidenceStore.recordEvidence(evidence);

    const manifestBase = {
      runId: run.id,
      recipeId: recipe.id,
      planDigest: plan.digest,
      actor: input.actor,
      reason: input.reason,
      results: result.results,
      verification,
      completedAt,
    };
    const manifest: CleanupManifest = { ...manifestBase, manifestDigest: computeManifestDigest(manifestBase) };
    await evidenceStore.recordManifest(manifest);
  }

  async function getRun(id: string): Promise<CleanupRun> {
    const run = await runStore.get(id);
    if (!run) throw CleanupErrors.runNotFound(id);
    return run;
  }

  async function cancel(id: string): Promise<CleanupRun> {
    const run = await getRun(id);
    if (run.status !== "running" && run.status !== "planned") {
      throw CleanupErrors.invalidAction("cancel", run.status);
    }
    // Cooperative: mark cancelled; committed chunks remain (§7 "Cancel").
    await runStore.update(id, { status: "cancelled", completedAt: now() });
    return getRun(id);
  }

  async function retry(id: string): Promise<CleanupRun> {
    const run = await getRun(id);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw CleanupErrors.invalidAction("retry", run.status);
    }
    // Re-run the idempotent recipe from its durable plan digest. The recipe
    // resumes by re-selection/keyset; already-processed rows are no-ops.
    const recipe = registry.get(run.recipeId);
    const input: ExecuteInput = {
      recipeId: run.recipeId,
      actor: { ref: run.requestedBy, kind: "user" },
      planDigest: run.planDigest,
      reason: run.reason,
      confirmation: recipe.destructive ? run.planDigest : undefined,
    };
    await runStore.update(id, { status: "running", completedAt: undefined });
    const sealed = await seal(recipe, input, context(input));
    // Retry keeps the SAME run row; re-run to completion.
    await worker.submit(() => runToCompletion(recipe, sealed, { ...run, status: "running" }, input));
    return getRun(id);
  }

  return { preview, execute, getRun, cancel, retry };
}
