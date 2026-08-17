/**
 * `recipeFromSteps` — fold an ordered array of framework-free
 * `CleanupStep`s (from `@classytic/repo-core/cleanup`, implemented by domain
 * kernels) into a single arc `CleanupRecipe` (data-cleanup design §5, §6.6).
 *
 * This is the seam that lets kernels own their cleanup WITHOUT depending on
 * arc: a kernel exports `CleanupStep`s typed against repo-core; the host
 * (`be-prod`) imports those steps and calls `recipeFromSteps` to produce the
 * recipe it registers with `createDataCleanupModule`. Arc owns composition +
 * durability; the kernel owns the domain work.
 *
 * Semantics:
 *   - **plan** unions every step's estimate into plan items; top-level
 *     `blockers` = the union of step blockers (a NON-EMPTY set is a hard stop
 *     the service refuses to execute); `rebuildActions` / `retains` / `warnings`
 *     likewise unioned. Side-effect-free.
 *   - **execute** runs steps IN ORDER. Between steps it calls
 *     `throwIfCancelled`. Each step's per-chunk progress is forwarded to arc's
 *     `onStep` as a DELTA (so the run's bounded `processed` total stays exact),
 *     and one result row per step is returned for the manifest. On the first
 *     `ok:false` (or a thrown non-cancel error) it STOPS — retention §8: never
 *     report success past a provider failure. `CleanupCancelled` propagates so
 *     the service records a cancel, not a failure.
 *   - **verify** unions every step's checks; the recipe is verified iff all are.
 */

import type { PurgeStrategyKind } from "@classytic/primitives/retention";
import type {
  CleanupStep,
  CleanupStepContext,
  CleanupStepExecuteContext,
  CleanupStepOutcome,
} from "@classytic/repo-core/cleanup";
import { CleanupCancelled, CleanupErrors } from "./errors.js";
import type {
  Availability,
  CleanupContext,
  CleanupExecutionContext,
  CleanupInput,
  CleanupPlan,
  CleanupPlanDraft,
  CleanupPlanItem,
  CleanupRecipe,
  CleanupResult,
  CleanupStepResult,
  VerificationCheck,
  VerificationResult,
} from "./types.js";

/** Metadata + steps for {@link recipeFromSteps}. */
export interface RecipeFromStepsInput {
  /** Stable machine id, unique in the registry (e.g. `'cleanup.rebuild-projections'`). */
  readonly id: string;
  /** Plain-language label for the UI. */
  readonly label: string;
  /**
   * Whether this recipe removes data. Defaults to `true` iff ANY step is
   * destructive (a pure-rebuild recipe is non-destructive).
   */
  readonly destructive?: boolean;
  /** Recipe/plan-schema version (persisted on the run). Defaults to `'1'`. */
  readonly version?: string;
  /**
   * Strategy the run's evidence records. Defaults to `'hard'` when any step is
   * destructive, `'soft'` otherwise (pure rebuilds remove no source data).
   */
  readonly evidenceStrategy?: PurgeStrategyKind;
  /** Exact confirmation phrase; defaults (in the service) to the recipe id. */
  readonly confirmationPhrase?: string;
  /** Extra top-level retains beyond per-step `retained` lines. */
  readonly retains?: readonly string[];
  /** Extra top-level warnings beyond per-step warnings. */
  readonly warnings?: readonly string[];
  /**
   * Recipe-level availability gate — go-live boundary, feature flag, etc.
   * STEPS never decide availability (that is host policy). Defaults to always
   * available.
   */
  available?(ctx: CleanupContext): Promise<Availability>;
  /** Provider steps in EXECUTION ORDER. */
  readonly steps: readonly CleanupStep[];
}

const ALWAYS_AVAILABLE: Availability = { available: true };

/** Build a step context from an arc cleanup context + the sealed parameters. */
function stepContextOf(
  ctx: CleanupContext,
  parameters: Readonly<Record<string, unknown>>,
): CleanupStepContext {
  return {
    now: ctx.now,
    signal: ctx.signal,
    ambient: ctx.ambient,
    parameters,
    logger: ctx.logger,
  };
}

/**
 * Resolve the operator's exclusion list against the recipe's real steps.
 *
 * REFUSES rather than filters. Two rejections, both of which a permissive
 * version would turn into a silent lie:
 *
 *   - **unknown id** — a typo, or a step that has since been removed. Dropping
 *     it leaves the operator believing they narrowed a destructive run when the
 *     excluded domain will in fact be purged. A free-text ignore-list that
 *     silently tolerates unknown entries carries exactly this hazard.
 *   - **a protective step** — the property an ignore-list alone cannot give. A
 *     guard deletes nothing; it stands between the run and records that must
 *     never be purged. If it can be switched off from the same screen that
 *     starts the run, it is advice, not a guard. `destructive: false` alone is
 *     not the test — a projection rebuild is also non-destructive and IS
 *     legitimately excludable — so the marker is the step's own
 *     `disposition: 'protect'`.
 *
 * Returns the validated set; throws `CleanupErrors.invalidInput` otherwise.
 */
export function resolveExclusions(
  steps: readonly CleanupStep[],
  requested: readonly string[] | undefined,
): ReadonlySet<string> {
  if (!requested || requested.length === 0) return new Set();
  const byId = new Map(steps.map((s) => [s.id, s]));
  const unknown: string[] = [];
  const protectedIds: string[] = [];
  for (const id of requested) {
    const step = byId.get(id);
    if (!step) {
      unknown.push(id);
      continue;
    }
    if (isProtective(step)) protectedIds.push(id);
  }
  if (unknown.length > 0) {
    throw CleanupErrors.invalidExclusion(
      `excludeSteps names step(s) this recipe does not have: ${unknown.join(", ")}. ` +
        "Refusing rather than ignoring — a dropped exclusion means the run touches " +
        "data the operator believed they had left out.",
      unknown,
    );
  }
  if (protectedIds.length > 0) {
    throw CleanupErrors.invalidExclusion(
      `excludeSteps names protective step(s): ${protectedIds.join(", ")}. ` +
        "A guard deletes nothing; it refuses the run when records that must never " +
        "be purged are present. It cannot be switched off from the same request " +
        "that starts the run.",
      protectedIds,
    );
  }
  return new Set(requested);
}

/**
 * Is this step a GUARD?
 *
 * Asked of the step's declared disposition rather than `destructive`, because
 * `destructive: false` covers guards AND projection rebuilds — and a rebuild is
 * perfectly reasonable to exclude.
 */
function isProtective(step: CleanupStep): boolean {
  return step.disposition === "protect";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Infrastructure failure inside the adapter's own progress plumbing (e.g. the
 * run store rejecting a progress write). Distinguished from a DOMAIN step
 * failure: it propagates out of `execute` so the service records an
 * infrastructure failure for the run, instead of blaming the domain step.
 */
class CleanupProgressInfraError extends Error {
  constructor(cause: unknown) {
    super(`progress persistence failed: ${errMessage(cause)}`);
    this.name = "CleanupProgressInfraError";
  }
}

export function recipeFromSteps(input: RecipeFromStepsInput): CleanupRecipe {
  const { id, label, version, confirmationPhrase, steps } = input;
  const destructive = input.destructive ?? steps.some((s) => s.destructive);
  const evidenceStrategy = input.evidenceStrategy ?? (destructive ? "hard" : "soft");

  return {
    id,
    label,
    destructive,
    evidenceStrategy,
    ...(version !== undefined ? { version } : {}),

    available(ctx: CleanupContext): Promise<Availability> {
      return input.available ? input.available(ctx) : Promise.resolve(ALWAYS_AVAILABLE);
    },

    async plan(cleanupInput: CleanupInput, ctx: CleanupContext): Promise<CleanupPlanDraft> {
      const parameters = cleanupInput.parameters ?? {};
      const stepCtx = stepContextOf(ctx, parameters);
      const excluded = resolveExclusions(steps, cleanupInput.excludeSteps);
      const items: CleanupPlanItem[] = [];
      const blockers = new Set<string>();
      const retains = new Set<string>(input.retains ?? []);
      const rebuildActions = new Set<string>();
      const warnings = new Set<string>(input.warnings ?? []);

      for (const step of steps) {
        /**
         * An excluded step is NOT estimated.
         *
         * Estimating it would run its counting queries for a line the operator
         * has already taken out — cost with no consequence — and, worse, would
         * surface its blockers, so leaving a domain out of a run could still be
         * refused because of that domain. A line the run will not touch must not
         * be able to stop the run.
         */
        if (excluded.has(step.id)) {
          items.push({
            stepId: step.id,
            resource: step.resource,
            estimated: 0,
            excluded: true,
            retained: "excluded from this run by the operator",
          });
          continue;
        }
        const est = await step.estimate(stepCtx);
        /**
         * Disposition comes from the STEP, not from `step.destructive`.
         *
         * (See the exclusion handling above for why `'protect'` also decides
         * whether a line may be left out of a run.)
         *
         * They are close but not the same, and conflating them is how the bug
         * this fixes arose. `destructive: false` covers BOTH a protective guard
         * (counts what it defends) and a projection rebuild (counts what it
         * recomputes) — opposite meanings for the headline. A step that says
         * nothing means `'remove'`, which is what every purge step is.
         */
        /**
         * A step may only PROTECT if it said so on the step itself.
         *
         * `resolveExclusions` runs before any estimate — it has to, since it
         * decides which steps to estimate at all — so it can read only
         * `step.disposition`. A guard that declared `'protect'` from its
         * ESTIMATE instead was therefore excludable: the plan line came back
         * marked protective, looked defended, and `excludeSteps: [thatId]`
         * still switched it off. That is precisely the property this feature
         * exists to make impossible, so the mismatch is an authoring error
         * rather than a silent downgrade.
         */
        if (est.disposition === "protect" && step.disposition !== "protect") {
          throw CleanupErrors.invalidExclusion(
            `step '${step.id}' returned disposition 'protect' from its estimate but does not ` +
              "declare `disposition: 'protect'` on the step. Exclusions are resolved before " +
              "estimates run, so a guard declared only at estimate time can be excluded — " +
              "switching off the check it exists to enforce. Declare it on the step.",
            [step.id],
          );
        }
        items.push({
          stepId: step.id,
          resource: est.resource,
          estimated: est.estimated,
          ...((est.disposition ?? step.disposition) !== undefined
            ? { disposition: est.disposition ?? step.disposition }
            : {}),
          ...(est.retained !== undefined ? { retained: est.retained } : {}),
          ...(est.blockers && est.blockers.length > 0 ? { blockers: est.blockers } : {}),
        });
        for (const b of est.blockers ?? []) blockers.add(b);
        for (const w of est.warnings ?? []) warnings.add(w);
        if (est.retained) retains.add(est.retained);
        for (const r of step.rebuildActions ?? []) rebuildActions.add(r);
      }

      return {
        items,
        blockers: [...blockers],
        retains: [...retains],
        rebuildActions: [...rebuildActions],
        warnings: [...warnings],
        ...(confirmationPhrase !== undefined ? { confirmationPhrase } : {}),
      };
    },

    async execute(plan: CleanupPlan, ctx: CleanupExecutionContext): Promise<CleanupResult> {
      const parameters = plan.parameters ?? {};
      const results: CleanupStepResult[] = [];
      /**
       * Re-resolved from the SEALED plan, never from a fresh caller input.
       *
       * The exclusion set is part of the digest the operator confirmed against,
       * so taking it from the plan is what makes consent binding: an execute
       * cannot widen the run beyond what was previewed. Re-validating here also
       * means a step that has since become protective refuses rather than being
       * quietly dropped.
       */
      const excluded = resolveExclusions(steps, plan.excludeSteps);

      /**
       * Lifecycle reporting is OPTIONAL on the context — a host service that
       * predates it simply gets no per-step view, rather than a crash. Resolved
       * once so the loop below reads as bookkeeping, not feature detection.
       */
      const reportState = ctx.onStepState?.bind(ctx) ?? (async () => {});

      for (const step of steps) {
        await ctx.throwIfCancelled();

        // Reported, not silently absent: an operator reading the run must see
        // that this phase was left out and why, exactly as they would see one
        // that had nothing in scope.
        if (excluded.has(step.id)) {
          await reportState({
            stepId: step.id,
            resource: step.resource,
            status: "skipped",
            processed: 0,
            startedAt: ctx.now,
            completedAt: ctx.now,
            detail: "excluded by the operator",
          });
          continue;
        }

        const startedAt = ctx.now;
        await reportState({
          stepId: step.id,
          resource: step.resource,
          status: "running",
          processed: 0,
          startedAt,
        });

        // Per-step delta bookkeeping: steps report CUMULATIVE progress; arc's
        // onStep sums DELTAS into the run's bounded total.
        let reported = 0;
        const execCtx: CleanupStepExecuteContext = {
          ...stepContextOf(ctx, parameters),
          throwIfCancelled: () => ctx.throwIfCancelled(),
          async onProgress(update) {
            const delta = update.processed - reported;
            if (delta > 0) {
              reported = update.processed;
              try {
                await ctx.onStep({
                  resource: update.resource,
                  processed: delta,
                  ok: true,
                  ...(update.cursor !== undefined ? { cursor: update.cursor } : {}),
                });
              } catch (err) {
                // Infra failure (progress store), NOT a domain step failure —
                // tag it so the catch below rethrows instead of blaming the step.
                throw new CleanupProgressInfraError(err);
              }
            }
          },
        };

        let outcome: CleanupStepOutcome;
        try {
          outcome = await step.execute(execCtx);
        } catch (err) {
          if (err instanceof CleanupCancelled || err instanceof CleanupProgressInfraError) {
            throw err;
          }
          outcome = {
            resource: step.resource,
            processed: reported,
            ok: false,
            error: errMessage(err),
          };
        }

        // Reconcile the tail delta (work the step didn't stream via onProgress),
        // and surface a failed step to the bounded progress even at delta 0.
        const tail = outcome.processed - reported;
        if (tail > 0 || !outcome.ok) {
          await ctx.onStep({
            resource: outcome.resource,
            processed: tail > 0 ? tail : 0,
            ok: outcome.ok,
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
            ...(outcome.cursor !== undefined ? { cursor: outcome.cursor } : {}),
          });
        }

        results.push({
          resource: outcome.resource,
          processed: outcome.processed,
          ok: outcome.ok,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(outcome.cursor !== undefined ? { cursor: outcome.cursor } : {}),
        });

        /**
         * `skipped` is a REAL outcome, not "completed with zero".
         *
         * A step that had nothing in scope and a step that removed 4,000 rows
         * both end `ok`, and reading a bare 0 as success is how an operator
         * concludes a phase ran when its scope was simply empty. Three states
         * alone only CATEGORISE the outcome; the `detail` is what makes it
         * answerable.
         */
        const isSkip = outcome.ok && outcome.processed === 0;
        await reportState({
          stepId: step.id,
          resource: outcome.resource,
          status: outcome.ok ? (isSkip ? "skipped" : "completed") : "failed",
          processed: outcome.processed,
          startedAt,
          completedAt: ctx.now,
          ...(outcome.ok
            ? isSkip
              ? { detail: "nothing in scope" }
              : {}
            : { detail: outcome.error ?? "step failed" }),
        });

        if (!outcome.ok) break; // stop-on-first-failure (retention §8)
      }

      const allOk = results.every((r) => r.ok);
      const anyOk = results.some((r) => r.ok);
      const status = allOk ? "completed" : anyOk ? "partial" : "failed";
      return { status, results };
    },

    async verify(plan: CleanupPlan, ctx: CleanupContext): Promise<VerificationResult> {
      const stepCtx = stepContextOf(ctx, plan.parameters ?? {});
      const checks: VerificationCheck[] = [];
      for (const step of steps) {
        if (!step.verify) continue;
        const stepChecks = await step.verify(stepCtx);
        for (const c of stepChecks) {
          checks.push({
            name: c.name,
            ok: c.ok,
            ...(c.detail !== undefined ? { detail: c.detail } : {}),
          });
        }
      }
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}
