/**
 * Timed handler execution — the concurrency core of the jobs worker,
 * extracted from the BullMQ registration so the algorithm is testable
 * without queue mocks.
 *
 * Contract:
 *  - The handler receives an `AbortSignal`, aborted when `timeoutMs`
 *    elapses. The timeout rejects THIS call; the handler itself is only
 *    signalled — cooperative cancellation.
 *  - `releaseSlot` (the bulkhead semaphore) fires when the handler
 *    promise SETTLES, not when the timeout rejects — a timed-out handler
 *    that keeps running still occupies its concurrency slot, so retries
 *    can't stack live executions past the limit.
 *  - `cancelGraceMs` bounds that hold: a handler ignoring its signal past
 *    timeout + grace has its slot force-released (logged loudly — beyond
 *    this point the bulkhead can be exceeded by the abandoned execution).
 *  - A timed-out handler's eventual settle is logged for observability;
 *    its result is discarded.
 *  - `releaseSlot` is invoked exactly once, on every path (success,
 *    failure, timeout-then-settle, grace expiry). Synchronous throws from
 *    the handler are converted to rejections so release always fires.
 */

export interface TimedHandlerLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ExecuteTimedHandlerOptions<T> {
  /** The work. Must treat the signal as its cancellation channel. */
  run: (signal: AbortSignal) => Promise<T>;
  /** Job/queue label for timeout errors and logs. */
  label: string;
  /** Correlation id for logs (e.g. the BullMQ job id). */
  jobId?: string;
  /** Reject after this many ms and abort the signal. Omit = no timeout. */
  timeoutMs?: number;
  /** Slot hold-bound after timeout (default: 30_000). */
  cancelGraceMs?: number;
  /** Bulkhead slot release — called exactly once. Omit when unguarded. */
  releaseSlot?: () => void;
  logger?: TimedHandlerLogger;
}

export async function executeTimedHandler<T>(options: ExecuteTimedHandlerOptions<T>): Promise<T> {
  const { run, label, jobId, timeoutMs, cancelGraceMs = 30_000, logger } = options;

  let released = false;
  const releaseSlot = (): void => {
    if (released) return;
    released = true;
    options.releaseSlot?.();
  };

  const abort = new AbortController();
  // async wrapper: a synchronous throw becomes a rejection, so the
  // settle-based release below always fires.
  const handlerPromise = (async () => run(abort.signal))();
  handlerPromise.then(releaseSlot, releaseSlot);

  if (!timeoutMs) {
    return handlerPromise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Job '${label}' timed out after ${timeoutMs}ms`);
      abort.abort(err);

      const timedOutAt = Date.now();
      const graceTimer = setTimeout(() => {
        logger?.warn(
          { job: label, jobId, graceMs: cancelGraceMs },
          "timed-out job handler still running after grace period — " +
            "force-releasing its maxConcurrent slot (bulkhead may now be exceeded); " +
            "make the handler honor its AbortSignal",
        );
        releaseSlot();
      }, cancelGraceMs);
      graceTimer.unref?.();
      handlerPromise
        .then(
          () =>
            logger?.warn(
              { job: label, jobId, afterMs: Date.now() - timedOutAt },
              "timed-out job handler eventually completed (result discarded)",
            ),
          (handlerErr) =>
            logger?.warn(
              { job: label, jobId, afterMs: Date.now() - timedOutAt, err: handlerErr },
              "timed-out job handler eventually failed",
            ),
        )
        .finally(() => clearTimeout(graceTimer));

      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([handlerPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
