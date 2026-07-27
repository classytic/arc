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
import { CleanupCancelled } from "./errors.js";
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
      const items: CleanupPlanItem[] = [];
      const blockers = new Set<string>();
      const retains = new Set<string>(input.retains ?? []);
      const rebuildActions = new Set<string>();
      const warnings = new Set<string>(input.warnings ?? []);

      for (const step of steps) {
        const est = await step.estimate(stepCtx);
        items.push({
          resource: est.resource,
          estimated: est.estimated,
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

      for (const step of steps) {
        await ctx.throwIfCancelled();

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
