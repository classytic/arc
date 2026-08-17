/**
 * Cleanup orchestration service — the framework's use-case core.
 *
 * Split into a REQUEST path and a WORKER path so the durability guarantees the
 * ports promise actually hold:
 *
 *   preview()      → re-plan, seal a digest, surface blockers/retains/confirmation
 *   execute()      → validate (availability, digest, confirmation, reason,
 *                    blockers, limits), ATOMICALLY create the run (admission
 *                    guard by concurrencyKey), persist the sealed operation,
 *                    ENQUEUE `{ runId }`, and RETURN. It does NOT run the recipe.
 *   processRun()   → the worker entrypoint. Takes an EXCLUSIVE LEASE on the run
 *                    (`claim` — a live lease refuses duplicate workers), then
 *                    branches: a `finalizing` run RECOVERS finalization from the
 *                    persisted payload (never re-executes); a `queued` run (or a
 *                    crashed `running` run whose lease expired) executes the
 *                    recipe with cooperative cancellation, verifies, persists
 *                    the finalization payload, and finalizes idempotently.
 *   cancel()       → durable cancel request (+ actor/reason audit) + CAS a
 *                    not-yet-running run straight to `cancelled` WITH evidence.
 *                    A running run stops cooperatively and leaves evidence of
 *                    the committed chunks.
 *   retry()        → reload the SAME sealed operation, re-check availability +
 *                    recipe version + digest against a fresh plan (refuse if the
 *                    world changed), re-arm ATOMICALLY under the same admission
 *                    guard as creation, re-enqueue.
 *
 * Every status change goes through `compareAndTransition` (CAS) carrying the
 * worker's lease token, so a late `completed` write from a stalled ex-owner can
 * never clobber the new owner's `cancelled`/`running` state.
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
  type CleanupFinalizationPayload,
  type CleanupInput,
  type CleanupJobQueue,
  type CleanupLease,
  type CleanupLimits,
  type CleanupManifest,
  type CleanupOutcomeStatus,
  type CleanupPlan,
  type CleanupProgressSummary,
  type CleanupRecipe,
  type CleanupResult,
  type CleanupRun,
  type CleanupRunStore,
  type CleanupStepProgress,
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
  /**
   * Exclusive worker-lease duration. A crashed executor's run becomes
   * claimable again this long after its last heartbeat (each persisted
   * progress write renews the lease). Default 5 minutes.
   */
  leaseMs?: number | undefined;
  /**
   * Minimum interval between PERSISTED progress writes (and their piggybacked
   * cancellation reads). `0` (default) persists every chunk. Failed steps are
   * always persisted immediately. Keep well below `leaseMs` — persisted
   * progress is also the lease heartbeat.
   */
  progressThrottleMs?: number | undefined;
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

export interface CancelInput {
  /** Who requested the cancel (audit — persisted on the run + evidence). */
  actor?: PurgeActor | undefined;
  /** Why (audit). */
  reason?: string | undefined;
}

export interface CleanupService {
  preview(input: PreviewInput): Promise<CleanupPlan>;
  execute(input: ExecuteInput): Promise<CleanupRun>;
  /** Worker entrypoint — run the persisted, enqueued operation to completion. */
  processRun(runId: string): Promise<void>;
  getRun(id: string): Promise<CleanupRun>;
  cancel(id: string, input?: CancelInput): Promise<CleanupRun>;
  retry(id: string): Promise<CleanupRun>;
}

const EMPTY_PROGRESS: CleanupProgressSummary = { processed: 0, steps: 0 };
/** Admission key serializing every destructive run behind one slot. */
export const GLOBAL_DESTRUCTIVE_KEY = "global-destructive";

function paramDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object" || value instanceof Date) return depth;
  let max = depth;
  for (const v of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, paramDepth(v, depth + 1));
  }
  return max;
}

/** Failures first, so a `maxChecks` cap can never hide a failing check. */
function orderChecksFailuresFirst(
  verification: VerificationResult,
  maxChecks: number,
): { verification: VerificationResult; checksTruncated: number } {
  if (verification.checks.length <= maxChecks) {
    return { verification, checksTruncated: 0 };
  }
  const ordered = [...verification.checks].sort((a, b) => Number(a.ok) - Number(b.ok));
  return {
    verification: { ok: verification.ok, checks: ordered.slice(0, maxChecks) },
    checksTruncated: verification.checks.length - maxChecks,
  };
}

/** The terminal run status a finalization payload deterministically maps to. */
function terminalStatusOf(
  payload: CleanupFinalizationPayload,
): "completed" | "failed" | "cancelled" {
  if (payload.status === "cancelled") return "cancelled";
  if (payload.status === "completed" && payload.verification.ok && !payload.failureReason) {
    return "completed";
  }
  return "failed";
}

export function createCleanupService(deps: CleanupServiceDeps): CleanupService {
  const { registry, runStore, evidenceStore } = deps;
  const writeFence = deps.writeFence;
  const logger = deps.logger;
  const generateId = deps.generateId ?? (() => globalThis.crypto.randomUUID());
  const now = deps.now ?? (() => new Date());
  const limits: CleanupLimits = { ...DEFAULT_CLEANUP_LIMITS, ...deps.limits };
  const leaseMs = deps.leaseMs ?? 5 * 60 * 1000;
  const progressThrottleMs = deps.progressThrottleMs ?? 0;

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

  function freshLease(): CleanupLease {
    return { token: generateId(), expiresAt: new Date(now().getTime() + leaseMs) };
  }

  async function seal(
    recipe: CleanupRecipe,
    input: PreviewInput,
    ctx: CleanupContext,
  ): Promise<CleanupPlan> {
    const draft = await recipe.plan(
      { parameters: input.parameters, excludeSteps: input.excludeSteps },
      ctx,
    );
    const items = draft.items;
    if (items.length > limits.maxPlanItems) {
      throw CleanupErrors.planTooLarge(
        `${items.length} items > maxPlanItems ${limits.maxPlanItems}`,
      );
    }
    /**
     * Partition by DISPOSITION — a protective guard's count is not damage.
     *
     * This was one `reduce` over every item, so a guard reporting the 173 posted
     * journal entries it defends pushed the "records to remove" headline to 540
     * on a plan that removes 367. Absent disposition means `'remove'`, so every
     * pre-existing recipe is unchanged.
     */
    const estimatedTotal = items.reduce(
      (sum, i) => sum + ((i.disposition ?? "remove") === "remove" ? i.estimated : 0),
      0,
    );
    const protectedTotal = items.reduce(
      (sum, i) => sum + (i.disposition === "protect" ? i.estimated : 0),
      0,
    );
    // Item-level blockers are ALSO hard stops — union them into the top level
    // so a recipe that forgot to duplicate them cannot be executed past them.
    const blockers = new Set<string>(draft.blockers ?? []);
    for (const item of items) {
      for (const b of item.blockers ?? []) blockers.add(b);
    }
    const unsealed: Omit<CleanupPlan, "digest"> = {
      recipeId: recipe.id,
      parameters: input.parameters ?? {},
      items,
      retains: [...(draft.retains ?? [])],
      blockers: [...blockers],
      rebuildActions: [...(draft.rebuildActions ?? [])],
      warnings: [...(draft.warnings ?? [])],
      estimatedTotal,
      protectedTotal,
      excludeSteps: [...(input.excludeSteps ?? [])].sort(),
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

  async function enqueueOrFail(run: CleanupRun): Promise<void> {
    try {
      await jobQueue.enqueue({ runId: run.id });
    } catch (err) {
      // No orphaned `queued` runs: an enqueue failure is recorded as the run's
      // failure so the operator sees it and can retry (which re-enqueues).
      // If the message WAS actually delivered despite the throw, the worker's
      // claim refuses non-queued runs, so the failed mark stays authoritative.
      await runStore.compareAndTransition(run.id, ["queued"], "failed", {
        completedAt: now(),
        failureReason: `enqueue failed: ${errMsg(err)}`,
      });
      throw err;
    }
  }

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
      destructive: recipe.destructive,
      ...(recipe.destructive ? { concurrencyKey: GLOBAL_DESTRUCTIVE_KEY } : {}),
      attempt: 0,
      progress: EMPTY_PROGRESS,
      cancelRequested: false,
      queuedAt: now(),
    };

    // ATOMIC admission guard (§8) — conditional insert by concurrencyKey.
    const created = await runStore.createIfPermitted(run);
    if (!created.created) throw CleanupErrors.alreadyRunning(created.activeRunId);

    await enqueueOrFail(run);
    return (await runStore.get(run.id)) ?? run;
  }

  // ── Worker path: run the persisted operation to completion ──────────────────

  async function processRun(runId: string): Promise<void> {
    const existing = await runStore.get(runId);
    if (!existing) throw CleanupErrors.runNotFound(runId);
    if (CLEANUP_TERMINAL_STATUSES.includes(existing.status)) return; // idempotent

    // EXCLUSIVE claim: grants the lease only for `queued`, or for a
    // `running`/`finalizing` run whose previous owner's lease EXPIRED (crash
    // recovery). A live lease means another worker owns it — leave untouched.
    const lease = freshLease();
    const run = await runStore.claim(runId, lease);
    if (!run) return;

    const recipe = registry.get(run.recipeId);

    // A run that crashed AFTER its finalization payload was persisted needs
    // ONLY finalization replayed — never a second recipe.execute().
    if (run.status === "finalizing") {
      await recoverFinalization(run, recipe, lease);
      return;
    }

    const running = await runStore.compareAndTransition(
      run.id,
      ["queued", "running"],
      "running",
      { startedAt: run.startedAt ?? now() },
      lease.token,
    );
    if (!running) return;

    // If cancel was requested before we started, finish it here — WITH evidence.
    if (running.cancelRequested) {
      await settleCancelled(running, recipe, lease, []);
      return;
    }

    // Guarded write-fence acquisition — its OWN failure domain. A failure to
    // acquire marks the run failed WITHOUT ever holding a fence (no leaked lock).
    let fenceToken: string | undefined;
    let fenceHeld = false;
    if (writeFence) {
      try {
        const token = await writeFence.acquire(run.operationId);
        fenceToken = typeof token === "string" ? token : undefined;
        fenceHeld = true;
      } catch (err) {
        await failRun(running, recipe, lease, `write fence acquire failed: ${errMsg(err)}`);
        return;
      }
    }

    try {
      await runOperation(running, recipe, running.sealedPlan, lease);
    } finally {
      if (writeFence && fenceHeld) {
        try {
          await writeFence.release(run.operationId, fenceToken);
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

  /** Execute → verify → persist finalization payload → finalize, all leased. */
  async function runOperation(
    run: CleanupRun,
    recipe: CleanupRecipe,
    plan: CleanupPlan,
    lease: CleanupLease,
  ): Promise<void> {
    const controller = new AbortController();
    let processed = 0;
    let steps = 0;
    let failed = 0;
    /**
     * Per-step lifecycle, keyed by `stepId` and ordered by first sight.
     *
     * Seeded from the run's existing progress so a RESUMED run (crash recovery,
     * retry) keeps the states it already recorded instead of presenting an
     * operator with a blank pipeline for work that demonstrably happened.
     */
    const stepStates = new Map<string, CleanupStepProgress>(
      (run.progress?.stepProgress ?? []).map((s) => [s.stepId, s]),
    );
    let cancelled = false;
    let lastSummary: CleanupProgressSummary = run.progress ?? EMPTY_PROGRESS;
    let lastPersistMs = 0;

    const refreshCancel = async (): Promise<boolean> => {
      const fresh = await runStore.get(run.id);
      if (fresh?.cancelRequested) {
        cancelled = true;
        controller.abort();
        return true;
      }
      return false;
    };

    const renewedLease = (): CleanupLease => ({
      token: lease.token,
      expiresAt: new Date(now().getTime() + leaseMs),
    });

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
          ...(stepStates.size > 0 ? { stepProgress: [...stepStates.values()] } : {}),
          ...(step.cursor !== undefined ? { lastCursor: step.cursor } : {}),
          heartbeatAt: now(),
        };
        lastSummary = summary;
        // Throttled persistence: every persisted write ALSO renews the lease
        // (heartbeat) and re-reads the durable cancel flag. Failed steps are
        // never throttled.
        const nowMs = now().getTime();
        if (!step.ok || progressThrottleMs === 0 || nowMs - lastPersistMs >= progressThrottleMs) {
          lastPersistMs = nowMs;
          await runStore.saveProgress(run.id, summary, renewedLease());
          await refreshCancel();
        }
      },
      /**
       * Upsert one step's lifecycle state, preserving FIRST-SEEN order.
       *
       * A `Map` keyed by `stepId` is what keeps this bounded and idempotent: a
       * step transitioning running → completed updates its entry rather than
       * appending, so the array length is the step count and never the
       * transition count. Insertion order is the execution order, which is what
       * an operator reads down the list.
       *
       * Persisted on the NEXT `onStep` (or the terminal write) rather than
       * immediately — a lifecycle transition is not itself a committed chunk,
       * and writing on every one would defeat the progress throttle that exists
       * to keep a long run from hammering the store.
       */
      async onStepState(state: CleanupStepProgress) {
        stepStates.set(state.stepId, state);
        lastSummary = {
          ...(lastSummary ?? { processed, steps, failed }),
          stepProgress: [...stepStates.values()],
        };
      },
      async throwIfCancelled() {
        if (cancelled || controller.signal.aborted || (await refreshCancel())) {
          throw new CleanupCancelled(run.id);
        }
      },
    };

    // ── Failure domain 1: recipe execution ────────────────────────────────────
    let result: CleanupResult;
    try {
      result = await recipe.execute(plan, execCtx);
    } catch (err) {
      if (err instanceof CleanupCancelled || cancelled || controller.signal.aborted) {
        // Cooperative cancel: committed chunks remain; record evidence of them.
        await settleCancelled(run, recipe, lease, [], lastSummary);
        return;
      }
      await failRun(run, recipe, lease, `execute threw: ${errMsg(err)}`);
      return;
    }

    // A cancel that landed exactly as execute resolved still wins.
    if (cancelled || (await refreshCancel())) {
      await settleCancelled(run, recipe, lease, result.results, lastSummary);
      return;
    }

    // Cap the results folded into the manifest (bounded document).
    const results =
      result.results.length > limits.maxResults
        ? result.results.slice(0, limits.maxResults)
        : result.results;
    const anyFailed = results.some((r) => !r.ok) || result.results.length > results.length;
    const effectiveStatus = anyFailed && result.status === "completed" ? "partial" : result.status;

    // ── Failure domain 2: verification ────────────────────────────────────────
    let verification: VerificationResult = { ok: !anyFailed, checks: [] };
    if (effectiveStatus !== "failed") {
      try {
        verification = await recipe.verify(plan, {
          actor: run.actor,
          now: now(),
          signal: controller.signal,
          ambient: run.ambient,
          logger,
        });
      } catch (err) {
        await failRun(run, recipe, lease, `verify threw: ${errMsg(err)}`, results);
        return;
      }
    }
    const capped = orderChecksFailuresFirst(verification, limits.maxChecks);

    const success = effectiveStatus === "completed" && verification.ok;
    const payload: CleanupFinalizationPayload = {
      status: effectiveStatus,
      results,
      verification: capped.verification,
      ...(capped.checksTruncated > 0 ? { checksTruncated: capped.checksTruncated } : {}),
      ...(success
        ? {}
        : {
            failureReason:
              effectiveStatus === "partial"
                ? "partial results"
                : effectiveStatus === "failed"
                  ? "execution failed"
                  : "verification failed",
          }),
    };

    // Enter `finalizing` WITH the durable payload — a crash after this line is
    // recoverable by replaying ONLY evidence + terminal CAS from the payload.
    const finalizing = await runStore.compareAndTransition(
      run.id,
      ["running"],
      "finalizing",
      { finalization: payload },
      lease.token,
    );
    if (!finalizing) return; // lost to a concurrent cancel/transition

    await settleFromPayload(finalizing, recipe, lease, payload, {
      progress: { ...lastSummary, processed, steps, failed, heartbeatAt: now() },
    });
  }

  /** Record a hard failure with failure evidence, CAS → failed (leased). */
  async function failRun(
    run: CleanupRun,
    recipe: CleanupRecipe,
    lease: CleanupLease,
    reason: string,
    results: readonly CleanupStepResult[] = [],
  ): Promise<void> {
    const payload: CleanupFinalizationPayload = {
      status: "failed",
      results,
      verification: { ok: false, checks: [] },
      failureReason: reason,
    };
    const failing = await runStore.compareAndTransition(
      run.id,
      ["running"],
      "finalizing",
      { failureReason: reason, finalization: payload },
      lease.token,
    );
    if (!failing) return;
    await settleFromPayload(failing, recipe, lease, payload);
  }

  /**
   * Cancel settlement — cancellation is an AUDITED outcome, not a silent state
   * flip: committed chunks remain in the database, so the run leaves evidence
   * recording how much work had been committed, who cancelled, and that
   * verification never ran.
   */
  async function settleCancelled(
    run: CleanupRun,
    recipe: CleanupRecipe,
    lease: CleanupLease,
    results: readonly CleanupStepResult[],
    summary?: CleanupProgressSummary,
  ): Promise<void> {
    const fresh = (await runStore.get(run.id)) ?? run;
    const payload: CleanupFinalizationPayload = {
      status: "cancelled",
      results,
      verification: {
        ok: false,
        checks: [
          {
            name: "verification.skipped",
            ok: false,
            detail: `run cancelled${fresh.cancelRequestedBy ? ` by ${fresh.cancelRequestedBy.ref}` : ""}${fresh.cancelReason ? `: ${fresh.cancelReason}` : ""} — post-state not verified; committed chunks remain`,
          },
        ],
      },
      failureReason: "cancelled",
    };
    const finalizing = await runStore.compareAndTransition(
      run.id,
      ["running"],
      "finalizing",
      { finalization: payload, ...(summary ? { progress: summary } : {}) },
      lease.token,
    );
    if (!finalizing) return;
    await settleFromPayload(finalizing, recipe, lease, payload);
  }

  /**
   * ── Failure domain 3: finalization ──────────────────────────────────────────
   * Persist evidence + manifest from the DURABLE payload, then CAS to the
   * terminal status. On an evidence-store failure the run STAYS `finalizing`
   * (payload intact) and is re-enqueued so a worker replays finalization only.
   */
  async function settleFromPayload(
    run: CleanupRun,
    recipe: CleanupRecipe,
    lease: CleanupLease,
    payload: CleanupFinalizationPayload,
    extraPatch: { progress?: CleanupProgressSummary } = {},
  ): Promise<void> {
    try {
      await finalize(run, recipe, run.sealedPlan, payload);
    } catch (err) {
      logger?.error?.("cleanup finalization failed — run left recoverable in finalizing", {
        runId: run.id,
        operationId: run.operationId,
        error: errMsg(err),
      });
      // Best-effort redelivery: the finalizing-recovery branch of processRun
      // replays evidence + terminal CAS from the persisted payload.
      try {
        await jobQueue.enqueue({ runId: run.id });
      } catch {
        /* the run remains finalizing; a recovery sweep / manual processRun re-finalizes */
      }
      return;
    }

    const terminal = terminalStatusOf(payload);
    await runStore.compareAndTransition(
      run.id,
      ["finalizing"],
      terminal,
      {
        completedAt: now(),
        ...(payload.failureReason && terminal !== "completed"
          ? { failureReason: payload.failureReason }
          : {}),
        ...(extraPatch.progress ? { progress: extraPatch.progress } : {}),
      },
      lease.token,
    );
  }

  /** Recovery entry for a claimed `finalizing` run: NEVER re-executes. */
  async function recoverFinalization(
    run: CleanupRun,
    recipe: CleanupRecipe,
    lease: CleanupLease,
  ): Promise<void> {
    const payload = run.finalization;
    if (!payload) {
      // Defensive: `finalizing` is only ever entered WITH a payload in the same
      // CAS. A run here without one is corrupt — fail it explicitly.
      const reason = "finalizing run has no persisted finalization payload";
      const fallback: CleanupFinalizationPayload = {
        status: "failed",
        results: [],
        verification: { ok: false, checks: [] },
        failureReason: reason,
      };
      await settleFromPayload(run, recipe, lease, fallback);
      return;
    }
    await settleFromPayload(run, recipe, lease, payload);
    // The crashed owner may still hold the write fence for this operation —
    // release by operation id (recovery has no old fence token by definition).
    if (writeFence && run.destructive) {
      try {
        await writeFence.release(run.operationId);
      } catch (err) {
        logger?.error?.("cleanup fence release during finalization recovery failed", {
          runId: run.id,
          operationId: run.operationId,
          error: errMsg(err),
        });
      }
    }
  }

  /** Idempotently persist evidence + manifest for the run (keyed by operationId). */
  async function finalize(
    run: CleanupRun,
    recipe: CleanupRecipe,
    plan: CleanupPlan,
    payload: CleanupFinalizationPayload,
  ): Promise<void> {
    const completedAt = now();
    const { status, results, verification, checksTruncated, failureReason } = payload;
    const processed = results.reduce((sum, r) => sum + r.processed, 0);
    const evidence = createPurgeEvidence({
      operationId: run.operationId,
      subject: { ref: `recipe:${recipe.id}`, model: "CleanupRun" },
      scope: `recipe:${recipe.id}`,
      // The strategy is DECLARED by the recipe — evidence must not claim a hard
      // purge for an anonymization or rebuild recipe.
      strategy: recipe.evidenceStrategy ?? "hard",
      // The evidence primitive has no 'cancelled' status — a cancelled run with
      // committed chunks is honestly 'partial' (chunks remain, op incomplete).
      status: status === "cancelled" ? "partial" : status,
      measuresRetained: plan.retains.length > 0,
      processed,
      startedAt: run.startedAt ?? run.queuedAt,
      completedAt,
      occurredAt: completedAt,
      actor: run.actor,
      reason: buildEvidenceReason(run, status, failureReason),
      results: results.map((r) => ({
        resource: r.resource,
        processed: r.processed,
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
      })),
      verification: {
        ok: verification.ok,
        checks: verification.checks.length,
        ...(verification.checks.length || checksTruncated
          ? {
              note: [
                verification.checks.map((c) => `${c.name}:${c.ok ? "ok" : "fail"}`).join(", "),
                checksTruncated ? `(+${checksTruncated} checks truncated)` : "",
              ]
                .filter(Boolean)
                .join(" "),
            }
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
      ...(checksTruncated ? { checksTruncated } : {}),
      completedAt,
    };
    const manifest: CleanupManifest = {
      ...manifestBase,
      manifestDigest: computeManifestDigest(manifestBase),
    };
    await evidenceStore.finalize({ evidence, manifest });
  }

  function buildEvidenceReason(
    run: CleanupRun,
    status: CleanupOutcomeStatus,
    failureReason?: string,
  ): string {
    const parts = [run.reason];
    if (status === "cancelled") {
      const by = run.cancelRequestedBy ? ` by ${run.cancelRequestedBy.ref}` : "";
      const why = run.cancelReason ? `: ${run.cancelReason}` : "";
      parts.push(`(cancelled${by}${why})`);
    } else if (failureReason) {
      parts.push(`(${failureReason})`);
    }
    return parts.join(" ");
  }

  // ── Observe + control ───────────────────────────────────────────────────────

  async function getRun(id: string): Promise<CleanupRun> {
    const run = await runStore.get(id);
    if (!run) throw CleanupErrors.runNotFound(id);
    return run;
  }

  async function cancel(id: string, input?: CancelInput): Promise<CleanupRun> {
    const run = await getRun(id);
    if (CLEANUP_TERMINAL_STATUSES.includes(run.status)) {
      throw CleanupErrors.invalidAction("cancel", run.status);
    }
    // Durable request first (source of truth for a running executor) + audit.
    await runStore.requestCancel(id, {
      actor: input?.actor,
      reason: input?.reason,
      requestedAt: now(),
    });
    // A not-yet-running run can be cancelled outright; a running one stops
    // cooperatively at its next step and settles itself WITH evidence. For the
    // never-started case the request path records the (empty) evidence here.
    const immediate = await runStore.compareAndTransition(id, ["queued", "planned"], "cancelled", {
      completedAt: now(),
    });
    if (immediate) {
      const recipe = registry.get(immediate.recipeId);
      const payload: CleanupFinalizationPayload = {
        status: "cancelled",
        results: [],
        verification: {
          ok: false,
          checks: [
            {
              name: "verification.skipped",
              ok: false,
              detail: "run cancelled before execution — no data was changed",
            },
          ],
        },
        failureReason: "cancelled",
      };
      try {
        await finalize(immediate, recipe, immediate.sealedPlan, payload);
      } catch (err) {
        logger?.error?.("cleanup cancel evidence write failed", {
          runId: id,
          error: errMsg(err),
        });
      }
    }
    return getRun(id);
  }

  async function retry(id: string): Promise<CleanupRun> {
    const run = await getRun(id);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw CleanupErrors.invalidAction("retry", run.status);
    }
    const recipe = registry.get(run.recipeId);
    const ctx: CleanupContext = { actor: run.actor, now: now(), ambient: run.ambient, logger };
    // A recipe disabled since the original run (e.g. business went live) must
    // not be re-runnable through retry.
    await ensureAvailable(recipe, ctx);
    // Re-validate the SAME sealed operation against a fresh plan: if the world
    // changed (or the recipe version moved), refuse — a retry must replay the
    // authorized operation, never a materially different one under the old
    // confirmation.
    if ((recipe.version ?? "1") !== run.recipeVersion) {
      throw CleanupErrors.planChanged(recipe.version ?? "1", run.recipeVersion);
    }
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

    // Re-arm ATOMICALLY under the SAME admission policy as creation — a retry
    // must not slip a second destructive run past the global guard.
    const requeued = await runStore.reArmIfPermitted(run.id, {
      queuedAt: now(),
      cancelRequested: false,
    });
    if (!requeued) {
      const current = await getRun(id);
      if (current.status !== "failed" && current.status !== "cancelled") {
        throw CleanupErrors.invalidAction("retry", current.status);
      }
      throw CleanupErrors.alreadyRunning("another-active-run");
    }
    await enqueueOrFail(requeued);
    return getRun(id);
  }

  return { preview, execute, processRun, getRun, cancel, retry };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
