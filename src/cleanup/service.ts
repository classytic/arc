/**
 * Cleanup orchestration service — the framework's use-case core.
 *
 * Split into a REQUEST path and a WORKER path so the durability guarantees the
 * ports promise actually hold:
 *
 *   preview()      → re-plan, seal a digest, surface blockers/retains/confirmation
 *   execute()      → validate (availability, digest, confirmation, reason,
 *                    blockers, limits), ATOMICALLY create the run (single-run
 *                    guard), persist the sealed operation, ENQUEUE `{ runId }`,
 *                    and RETURN. It does NOT run the recipe.
 *   processRun()   → the worker entrypoint. Loads the run + its sealed plan,
 *                    acquires the write fence (guarded), runs the recipe with
 *                    cooperative cancellation, verifies, and finalizes (terminal
 *                    status + evidence + manifest) idempotently. Recoverable
 *                    from a `finalizing` state after a restart.
 *   cancel()       → durable cancel request + CAS a not-yet-running run straight
 *                    to `cancelled`. A running run stops cooperatively.
 *   retry()        → reload the SAME sealed operation, re-validate its digest
 *                    against a fresh plan (refuse if the world changed), re-enqueue.
 *
 * Every status change goes through `compareAndTransition` (CAS) so a late
 * `completed` write can never clobber a `cancelled` one.
 */

import { createPurgeEvidence } from "@classytic/primitives/retention";
import { CleanupCancelled, CleanupErrors } from "./errors.js";
import { computeManifestDigest, computePlanDigest } from "./plan-digest.js";
import type { CleanupRegistry } from "./registry.js";
import {
  CLEANUP_TERMINAL_STATUSES,
  type CleanupContext,
  type CleanupEvidenceStore,
  type CleanupExecutionContext,
  type CleanupInput,
  type CleanupJobQueue,
  type CleanupLimits,
  type CleanupManifest,
  type CleanupPlan,
  type CleanupProgressSummary,
  type CleanupRecipe,
  type CleanupResult,
  type CleanupRun,
  type CleanupRunStore,
  type CleanupStepResult,
  type CleanupWriteFence,
  DEFAULT_CLEANUP_LIMITS,
  type PurgeActor,
  type VerificationResult,
} from "./types.js";

export interface CleanupServiceDeps {
  registry: CleanupRegistry;
  runStore: CleanupRunStore;
  evidenceStore: CleanupEvidenceStore;
  /** Optional write fence (§8). No-op when absent. */
  writeFence?: CleanupWriteFence | undefined;
  /**
   * Durable job queue (§8). Defaults to a microtask-deferred in-process queue
   * that calls `processRun` off the request path (single-process only). Inject
   * BullMQ / SQS / repo-backed for cross-process durability + restart recovery.
   */
  jobQueue?: CleanupJobQueue | undefined;
  /** Framework size caps. Defaults to {@link DEFAULT_CLEANUP_LIMITS}. */
  limits?: Partial<CleanupLimits> | undefined;
  /** Optional logger for release-failure / recovery diagnostics. */
  logger?: CleanupContext["logger"];
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
}

export interface CleanupService {
  preview(input: PreviewInput): Promise<CleanupPlan>;
  execute(input: ExecuteInput): Promise<CleanupRun>;
  /** Worker entrypoint — run the persisted, enqueued operation to completion. */
  processRun(runId: string): Promise<void>;
  getRun(id: string): Promise<CleanupRun>;
  cancel(id: string): Promise<CleanupRun>;
  retry(id: string): Promise<CleanupRun>;
}

const EMPTY_PROGRESS: CleanupProgressSummary = { processed: 0, steps: 0 };

function paramDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object" || value instanceof Date) return depth;
  let max = depth;
  for (const v of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, paramDepth(v, depth + 1));
  }
  return max;
}

export function createCleanupService(deps: CleanupServiceDeps): CleanupService {
  const { registry, runStore, evidenceStore } = deps;
  const writeFence = deps.writeFence;
  const logger = deps.logger;
  const generateId = deps.generateId ?? (() => globalThis.crypto.randomUUID());
  const now = deps.now ?? (() => new Date());
  const limits: CleanupLimits = { ...DEFAULT_CLEANUP_LIMITS, ...deps.limits };

  // Default queue: defer to a microtask so execute() returns BEFORE the recipe
  // runs (off the request path, single-process). A thrown processRun rejection
  // is swallowed here — the run's own status/evidence is the durable record.
  const jobQueue: CleanupJobQueue = deps.jobQueue ?? {
    enqueue: async (job) => {
      queueMicrotask(() => {
        void processRun(job.runId).catch(() => {
          /* durable failure is recorded on the run + evidence */
        });
      });
    },
  };

  function context(input: PreviewInput, signal?: AbortSignal): CleanupContext {
    return { actor: input.actor, now: now(), signal, ambient: input.ambient, logger };
  }

  async function seal(
    recipe: CleanupRecipe,
    input: PreviewInput,
    ctx: CleanupContext,
  ): Promise<CleanupPlan> {
    const draft = await recipe.plan({ parameters: input.parameters }, ctx);
    const items = draft.items;
    if (items.length > limits.maxPlanItems) {
      throw CleanupErrors.planTooLarge(
        `${items.length} items > maxPlanItems ${limits.maxPlanItems}`,
      );
    }
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

  // ── Request path: validate + persist + enqueue (NO recipe execution) ────────

  async function execute(input: ExecuteInput): Promise<CleanupRun> {
    const recipe = registry.get(input.recipeId);
    const ctx = context(input);

    // Input limits (bounded documents).
    if ((input.reason ?? "").length > limits.maxReasonLength) {
      throw CleanupErrors.planTooLarge(`reason length > ${limits.maxReasonLength}`);
    }
    if (input.parameters && paramDepth(input.parameters) > limits.maxParamDepth) {
      throw CleanupErrors.planTooLarge(`parameters nested deeper than ${limits.maxParamDepth}`);
    }

    // Availability + digest re-check + confirmation + reason (fail before write).
    await ensureAvailable(recipe, ctx);
    const sealed = await seal(recipe, input, ctx);
    if (sealed.digest !== input.planDigest) {
      throw CleanupErrors.planChanged(sealed.digest, input.planDigest);
    }
    if (recipe.destructive && input.confirmation !== sealed.confirmationPhrase) {
      throw CleanupErrors.confirmationRequired(sealed.confirmationPhrase);
    }
    if (!input.reason || input.reason.trim().length === 0) {
      throw CleanupErrors.reasonRequired();
    }
    // Blockers are a HARD STOP (§4.4) — never confirmable through the normal flow.
    if (sealed.blockers.length > 0) {
      throw CleanupErrors.blocked(sealed.blockers);
    }

    const run: CleanupRun = {
      id: generateId(),
      recipeId: recipe.id,
      recipeVersion: recipe.version ?? "1",
      status: "queued",
      planDigest: sealed.digest,
      sealedPlan: sealed,
      parameters: input.parameters ?? {},
      actor: input.actor,
      ambient: input.ambient,
      requestedBy: input.actor.ref,
      reason: input.reason,
      operationId: generateId(),
      progress: EMPTY_PROGRESS,
      cancelRequested: false,
      queuedAt: now(),
    };

    // ATOMIC single-destructive-run guard (§8) — conditional insert, not a race.
    const created = await runStore.createIfPermitted(run);
    if (!created.created) throw CleanupErrors.alreadyRunning(created.activeRunId);

    await jobQueue.enqueue({ runId: run.id });
    return (await runStore.get(run.id)) ?? run;
  }

  // ── Worker path: run the persisted operation to completion ──────────────────

  async function processRun(runId: string): Promise<void> {
    const run = await runStore.get(runId);
    if (!run) throw CleanupErrors.runNotFound(runId);
    // Idempotent: a terminal run (or one another worker already claimed) is left alone.
    if (CLEANUP_TERMINAL_STATUSES.includes(run.status)) return;

    const recipe = registry.get(run.recipeId);
    const plan = run.sealedPlan;

    // Claim: CAS queued|finalizing → running. Losing the CAS means another
    // worker owns it — return without touching state.
    const claimed = await runStore.compareAndTransition(
      run.id,
      ["queued", "running", "finalizing"],
      "running",
      {
        startedAt: run.startedAt ?? now(),
      },
    );
    if (!claimed) return;

    // If cancel was requested before we started, finish it here.
    if (claimed.cancelRequested) {
      await runStore.compareAndTransition(run.id, ["running"], "cancelled", { completedAt: now() });
      return;
    }

    // Guarded write-fence acquisition — its OWN transition. A failure to acquire
    // marks the run failed WITHOUT ever holding a fence (no leaked lock).
    if (writeFence) {
      try {
        await writeFence.acquire(run.operationId);
      } catch (err) {
        await failRun(claimed, recipe, `write fence acquire failed: ${errMsg(err)}`);
        return;
      }
    }

    try {
      await runOperation(claimed, recipe, plan);
    } finally {
      if (writeFence) {
        try {
          await writeFence.release(run.operationId);
        } catch (relErr) {
          // A release failure must NOT mask the primary outcome — log + record only.
          logger?.error?.("cleanup write fence release failed", {
            runId: run.id,
            operationId: run.operationId,
            error: errMsg(relErr),
          });
        }
      }
    }
  }

  /** Execute → verify → finalize, with cooperative cancellation. */
  async function runOperation(
    run: CleanupRun,
    recipe: CleanupRecipe,
    plan: CleanupPlan,
  ): Promise<void> {
    const controller = new AbortController();
    let processed = 0;
    let steps = 0;
    let failed = 0;
    let cancelled = false;
    let lastSummary: CleanupProgressSummary = run.progress ?? { processed: 0, steps: 0 };

    const refreshCancel = async (): Promise<boolean> => {
      const fresh = await runStore.get(run.id);
      if (fresh?.cancelRequested) {
        cancelled = true;
        controller.abort();
        return true;
      }
      return false;
    };

    const execCtx: CleanupExecutionContext = {
      actor: run.actor,
      now: now(),
      signal: controller.signal,
      ambient: run.ambient,
      logger,
      runId: run.id,
      operationId: run.operationId,
      async onStep(step: CleanupStepResult) {
        steps += 1;
        processed += step.processed;
        if (!step.ok) failed += 1;
        const summary: CleanupProgressSummary = {
          processed,
          steps,
          failed,
          currentResource: step.resource,
          ...(step.cursor !== undefined ? { lastCursor: step.cursor } : {}),
          heartbeatAt: now(),
        };
        lastSummary = summary;
        await runStore.saveProgress(run.id, summary);
        await refreshCancel();
      },
      async throwIfCancelled() {
        if (cancelled || controller.signal.aborted || (await refreshCancel())) {
          throw new CleanupCancelled(run.id);
        }
      },
    };

    let result: CleanupResult;
    try {
      result = await recipe.execute(plan, execCtx);
    } catch (err) {
      if (err instanceof CleanupCancelled || cancelled || controller.signal.aborted) {
        // Cooperative cancel: committed chunks remain; CAS running → cancelled.
        await runStore.compareAndTransition(run.id, ["running"], "cancelled", {
          completedAt: now(),
        });
        return;
      }
      await failRun(run, recipe, `execute threw: ${errMsg(err)}`);
      return;
    }

    // A cancel that landed exactly as execute resolved still wins.
    if (cancelled || (await refreshCancel())) {
      await runStore.compareAndTransition(run.id, ["running"], "cancelled", { completedAt: now() });
      return;
    }

    // Cap the results folded into the manifest (bounded document).
    const results =
      result.results.length > limits.maxResults
        ? result.results.slice(0, limits.maxResults)
        : result.results;
    const anyFailed = results.some((r) => !r.ok) || result.results.length > results.length;
    const effectiveStatus = anyFailed && result.status === "completed" ? "partial" : result.status;

    let verification: VerificationResult = { ok: !anyFailed, checks: [] };
    if (effectiveStatus !== "failed") {
      verification = await recipe.verify(plan, {
        actor: run.actor,
        now: now(),
        signal: controller.signal,
        ambient: run.ambient,
        logger,
      });
    }
    if (verification.checks.length > limits.maxChecks) {
      verification = {
        ok: verification.ok,
        checks: verification.checks.slice(0, limits.maxChecks),
      };
    }

    const success = effectiveStatus === "completed" && verification.ok;

    // Enter `finalizing` (CAS running → finalizing) — a crash after this is
    // recoverable: a restart re-runs processRun, re-claims, and re-finalizes
    // idempotently (evidenceStore.finalize is keyed by operationId).
    const finalizing = await runStore.compareAndTransition(run.id, ["running"], "finalizing");
    if (!finalizing) return; // lost to a concurrent cancel/transition

    await finalize(run, recipe, plan, effectiveStatus, results, verification);

    await runStore.compareAndTransition(run.id, ["finalizing"], success ? "completed" : "failed", {
      completedAt: now(),
      ...(success
        ? {}
        : {
            failureReason:
              effectiveStatus === "partial" ? "partial results" : "verification failed",
          }),
      progress: { ...lastSummary, processed, steps, failed, heartbeatAt: now() },
    });
  }

  /** Record a hard failure with failure evidence, CAS → failed. */
  async function failRun(run: CleanupRun, recipe: CleanupRecipe, reason: string): Promise<void> {
    const failing = await runStore.compareAndTransition(run.id, ["running"], "finalizing", {
      failureReason: reason,
    });
    if (!failing) return;
    await finalize(run, recipe, run.sealedPlan, "failed", [], { ok: false, checks: [] }, reason);
    await runStore.compareAndTransition(run.id, ["finalizing"], "failed", {
      completedAt: now(),
      failureReason: reason,
    });
  }

  /** Idempotently persist evidence + manifest for the run (keyed by operationId). */
  async function finalize(
    run: CleanupRun,
    recipe: CleanupRecipe,
    plan: CleanupPlan,
    status: CleanupResult["status"],
    results: readonly CleanupStepResult[],
    verification: VerificationResult,
    failureReason?: string,
  ): Promise<void> {
    const completedAt = now();
    const processed = results.reduce((sum, r) => sum + r.processed, 0);
    const evidence = createPurgeEvidence({
      operationId: run.operationId,
      subject: { ref: `recipe:${recipe.id}`, model: "CleanupRun" },
      scope: `recipe:${recipe.id}`,
      strategy: "hard",
      status,
      measuresRetained: plan.retains.length > 0,
      processed,
      startedAt: run.startedAt ?? run.queuedAt,
      completedAt,
      occurredAt: completedAt,
      actor: run.actor,
      reason: failureReason ? `${run.reason} (${failureReason})` : run.reason,
      results: results.map((r) => ({
        resource: r.resource,
        processed: r.processed,
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
      })),
      verification: {
        ok: verification.ok,
        checks: verification.checks.length,
        ...(verification.checks.length
          ? { note: verification.checks.map((c) => `${c.name}:${c.ok ? "ok" : "fail"}`).join(", ") }
          : {}),
      },
    });

    const manifestBase = {
      runId: run.id,
      recipeId: recipe.id,
      recipeVersion: run.recipeVersion,
      operationId: run.operationId,
      planDigest: plan.digest,
      status,
      actor: run.actor,
      reason: run.reason,
      results,
      verification,
      completedAt,
    };
    const manifest: CleanupManifest = {
      ...manifestBase,
      manifestDigest: computeManifestDigest(manifestBase),
    };
    await evidenceStore.finalize({ evidence, manifest });
  }

  // ── Observe + control ───────────────────────────────────────────────────────

  async function getRun(id: string): Promise<CleanupRun> {
    const run = await runStore.get(id);
    if (!run) throw CleanupErrors.runNotFound(id);
    return run;
  }

  async function cancel(id: string): Promise<CleanupRun> {
    const run = await getRun(id);
    if (CLEANUP_TERMINAL_STATUSES.includes(run.status)) {
      throw CleanupErrors.invalidAction("cancel", run.status);
    }
    // Durable request first (source of truth for a running executor).
    await runStore.requestCancel(id);
    // A not-yet-running run can be cancelled outright; a running one stops
    // cooperatively at its next step and CAS-transitions itself.
    await runStore.compareAndTransition(id, ["queued", "planned"], "cancelled", {
      completedAt: now(),
    });
    return getRun(id);
  }

  async function retry(id: string): Promise<CleanupRun> {
    const run = await getRun(id);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw CleanupErrors.invalidAction("retry", run.status);
    }
    const recipe = registry.get(run.recipeId);
    // Re-validate the SAME sealed operation against a fresh plan: if the world
    // changed (or the recipe version moved), refuse — a retry must replay the
    // authorized operation, never a materially different one under the old
    // confirmation.
    if ((recipe.version ?? "1") !== run.recipeVersion) {
      throw CleanupErrors.planChanged(recipe.version ?? "1", run.recipeVersion);
    }
    const ctx: CleanupContext = { actor: run.actor, now: now(), ambient: run.ambient, logger };
    const fresh = await seal(
      recipe,
      {
        recipeId: run.recipeId,
        actor: run.actor,
        parameters: run.parameters,
        ambient: run.ambient,
      },
      ctx,
    );
    if (fresh.digest !== run.planDigest) {
      throw CleanupErrors.planChanged(fresh.digest, run.planDigest);
    }

    // Re-arm the run: CAS terminal → queued, clearing the stale cancel flag so
    // the requeued worker doesn't immediately re-cancel.
    const requeued = await runStore.compareAndTransition(
      run.id,
      ["failed", "cancelled"],
      "queued",
      {
        queuedAt: now(),
        cancelRequested: false,
      },
    );
    if (!requeued) throw CleanupErrors.invalidAction("retry", (await getRun(id)).status);
    await jobQueue.enqueue({ runId: run.id });
    return getRun(id);
  }

  return { preview, execute, processRun, getRun, cancel, retry };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
