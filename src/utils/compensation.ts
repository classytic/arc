/**
 * Compensating Transaction — In-Process Rollback Primitive
 *
 * Runs steps in order. If any step fails, runs compensating actions
 * for already-completed steps in reverse. Zero dependencies.
 *
 * Type-safe: generic context type gives autocomplete across steps.
 * Discriminated union result: compiler enforces checking success before
 * accessing failedStep/error.
 *
 * For distributed sagas across services, use Temporal, Inngest, or Streamline.
 *
 * @example
 * ```typescript
 * interface CheckoutCtx {
 *   orderId: string;
 *   reservationId?: string;
 * }
 *
 * const result = await withCompensation<CheckoutCtx>('checkout', [
 *   {
 *     name: 'reserve',
 *     execute: async (ctx) => {
 *       const res = await inventoryService.reserve(ctx.orderId);
 *       ctx.reservationId = res.id;
 *       return res;
 *     },
 *     compensate: async (ctx) => {
 *       await inventoryService.release(ctx.reservationId!);
 *     },
 *   },
 *   { name: 'notify', execute: sendEmail, fireAndForget: true },
 * ], { orderId: 'ord-123' });
 *
 * if (result.success) {
 *   // result.results available, no failedStep
 * } else {
 *   // result.failedStep and result.error guaranteed
 * }
 * ```
 */

// ============================================================================
// Types
// ============================================================================

/** Step definition with typed context and typed result */
export interface CompensationStep<TCtx = Record<string, unknown>, TResult = unknown> {
  /** Step name — used in results, logs, and hooks */
  readonly name: string;
  /** Execute the step — return value stored in results[name] */
  readonly execute: (ctx: TCtx) => Promise<TResult>;
  /** Rollback on failure — receives context and this step's own result */
  readonly compensate?: (ctx: TCtx, stepResult: TResult) => Promise<void>;
  /**
   * Fire-and-forget — don't await, don't block, skip in rollback.
   *
   * OUTSIDE the transactional result by design: the step is NOT listed in
   * `completedSteps` (it hasn't completed when the result is returned — a
   * step that later fails must never have been reported as completed), its
   * value never appears in `results`, and it is not compensatable. Its
   * rejection is reported through `hooks.onStepFailed` (observability
   * only — the transaction outcome is unaffected).
   *
   * This is best-effort by construction — a crash loses it. Side effects
   * that must survive failure belong in the outbox or a job queue, not in
   * a fire-and-forget step.
   */
  readonly fireAndForget?: boolean;
}

/** Lifecycle hooks for observability — wire to Arc events, metrics, or logging */
export interface CompensationHooks {
  readonly onStepComplete?: (stepName: string, result: unknown) => void;
  readonly onStepFailed?: (stepName: string, error: Error) => void;
  readonly onCompensate?: (stepName: string) => void;
  /**
   * Reports a hook that THREW. Hook failures never alter the transaction
   * (contained by design), but silent containment makes a broken
   * metrics/audit sink invisible — wire this to a logger. Must not throw;
   * if it does, that too is contained.
   */
  readonly onHookError?: (hookName: string, error: Error) => void;
}

/** Error from a compensation action that failed during rollback */
export interface CompensationError {
  readonly step: string;
  readonly error: string;
}

/** Discriminated union — success and failure are mutually exclusive */
export type CompensationResult =
  | {
      readonly success: true;
      readonly completedSteps: readonly string[];
      readonly results: Readonly<Record<string, unknown>>;
    }
  | {
      readonly success: false;
      readonly completedSteps: readonly string[];
      readonly results: Readonly<Record<string, unknown>>;
      readonly failedStep: string;
      readonly error: string;
      readonly compensationErrors?: readonly CompensationError[];
    };

// ============================================================================
// Execute
// ============================================================================

/**
 * Observability hooks must never alter the transaction: a throwing metrics
 * sink must not fail a step that succeeded, trigger compensation, or become
 * an unhandled rejection from a detached fire-and-forget chain. Containment
 * is reported via `hooks.onHookError` so broken sinks stay visible.
 */
function safeHook(name: string, invoke: () => void, hooks?: CompensationHooks): void {
  try {
    invoke();
  } catch (err) {
    try {
      hooks?.onHookError?.(name, err instanceof Error ? err : new Error(String(err)));
    } catch {
      /* the reporter itself is contained too */
    }
  }
}

/**
 * Run steps in order with automatic compensation on failure.
 *
 * @typeParam TCtx - Context type shared across steps (defaults to Record<string, unknown>)
 */
export async function withCompensation<
  TCtx extends Record<string, unknown> = Record<string, unknown>,
>(
  _name: string,
  steps: readonly CompensationStep<TCtx>[],
  initialContext?: TCtx,
  hooks?: CompensationHooks,
): Promise<CompensationResult> {
  const ctx = { ...initialContext } as TCtx;
  const completedSteps: string[] = [];
  const results: Record<string, unknown> = {};
  const completed: Array<{ step: CompensationStep<TCtx>; result: unknown }> = [];

  for (const step of steps) {
    if (step.fireAndForget) {
      // NOT pushed to completedSteps — it hasn't completed when the result
      // is returned; a step that later fails must never have been reported
      // as completed. Rejections surface via onStepFailed. The chain ends
      // in a catch so nothing detached can become an unhandled rejection.
      void step
        .execute(ctx)
        .then(
          (result) =>
            safeHook("onStepComplete", () => hooks?.onStepComplete?.(step.name, result), hooks),
          (err) =>
            safeHook(
              "onStepFailed",
              () =>
                hooks?.onStepFailed?.(
                  step.name,
                  err instanceof Error ? err : new Error(String(err)),
                ),
              hooks,
            ),
        )
        .catch(() => {
          /* backstop */
        });
      continue;
    }

    try {
      const result = await step.execute(ctx);
      completedSteps.push(step.name);
      results[step.name] = result;
      completed.push({ step, result });
      safeHook("onStepComplete", () => hooks?.onStepComplete?.(step.name, result), hooks);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      safeHook("onStepFailed", () => hooks?.onStepFailed?.(step.name, error), hooks);

      const compensationErrors = await rollback(ctx, completed, hooks);

      return {
        success: false,
        completedSteps,
        results,
        failedStep: step.name,
        error: error.message,
        ...(compensationErrors.length > 0 ? { compensationErrors } : {}),
      };
    }
  }

  return { success: true, completedSteps, results };
}

// ============================================================================
// Rollback — reverse order, never throws
// ============================================================================

async function rollback<TCtx extends Record<string, unknown>>(
  ctx: TCtx,
  completed: readonly { step: CompensationStep<TCtx>; result: unknown }[],
  hooks?: CompensationHooks,
): Promise<CompensationError[]> {
  const errors: CompensationError[] = [];

  for (let i = completed.length - 1; i >= 0; i--) {
    const entry = completed[i];
    if (!entry?.step.compensate) continue;
    const compensateFn = entry.step.compensate;

    try {
      await compensateFn(ctx, entry.result);
      safeHook("onCompensate", () => hooks?.onCompensate?.(entry.step.name), hooks);
    } catch (err) {
      errors.push({
        step: entry.step.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return errors;
}

// ============================================================================
// defineCompensation — reusable definition
// ============================================================================

export interface CompensationDefinition<
  TCtx extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly name: string;
  readonly execute: (
    initialContext?: TCtx,
    hooks?: CompensationHooks,
  ) => Promise<CompensationResult>;
}

export function defineCompensation<TCtx extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
  steps: readonly CompensationStep<TCtx>[],
): CompensationDefinition<TCtx> {
  return {
    name,
    execute: (initialContext?: TCtx, hooks?: CompensationHooks) =>
      withCompensation(name, steps, initialContext, hooks),
  };
}
