/**
 * Job queue integration — public contract (definitions, meta, dispatcher).
 *
 * Directory map (mechanical split of the former single file):
 *   types.ts     — this contract + `defineJob`
 *   execution.ts — `executeTimedHandler` (timeout / cancellation / bulkhead)
 *   repeat.ts    — repeatable-schedule reconciliation (boot hygiene)
 *   plugin.ts    — BullMQ wiring (queues, workers, DLQ, routes, shutdown)
 *   index.ts     — public barrel; `src/integrations/jobs.ts` re-exports it
 *                  so the package subpath is unchanged
 */

/** Repeat schedule — cron pattern or fixed interval. Explicit timezone is required. */
import type { PermissionCheck } from "../../permissions/types.js";

export interface JobRepeatOptions {
  /** Cron pattern (e.g. '0 9 * * *' = every day 09:00). Mutually exclusive with `every`. */
  pattern?: string;
  /** Fixed interval in ms. Mutually exclusive with `pattern`. */
  every?: number;
  /** IANA timezone (e.g. 'UTC', 'America/New_York'). Required for `pattern` — prevents DST drift. */
  tz?: string;
  /** Stop repeating after this date. */
  endDate?: Date | string | number;
  /** Max total runs. */
  limit?: number;
}

export interface JobDefinition<TData = unknown, TResult = unknown> {
  /** Unique job name */
  name: string;
  /** Job handler function */
  handler: (data: TData, meta: JobMeta) => Promise<TResult>;
  /** Number of retries on failure (default: 3) */
  retries?: number;
  /** Backoff strategy */
  backoff?: { type: "exponential" | "fixed"; delay: number };
  /** Job timeout in ms (default: 30000) */
  timeout?: number;
  /** Concurrency per worker (default: 1) */
  concurrency?: number;
  /** Rate limit: max jobs per duration */
  rateLimit?: { max: number; duration: number };
  /** Dead letter queue name (default: '{name}-dead') */
  deadLetterQueue?: string;
  /** Repeat schedule — cron or interval. Requires explicit timezone for cron. */
  repeat?: JobRepeatOptions;
  /**
   * Arc-level semaphore: max simultaneous handler executions for this job type.
   * Jobs that dequeue while all slots are full are held (state stays `active`)
   * and appear as `throttled: true` in `GET /jobs/:id/status`.
   * Distinct from BullMQ `concurrency` — use this when the constraint is a
   * downstream resource (AI model rate limit, DB connection pool, external API).
   *
   * The slot is held until the handler actually SETTLES — a timed-out
   * handler that keeps running (ignoring `meta.signal`) still counts
   * against `maxConcurrent`, so retries can't stack live executions past
   * the limit. `cancelGraceMs` bounds how long a stuck handler may hold
   * its slot after timeout.
   */
  maxConcurrent?: number;
  /**
   * How long after a TIMEOUT a still-running handler may keep its
   * `maxConcurrent` slot before the slot is force-released (default:
   * 30_000). The bulkhead limits LIVE handlers, not worker awaits — but a
   * handler that ignores `meta.signal` forever must not wedge the queue.
   * A force-release is logged loudly: past that point the bulkhead can be
   * exceeded by the abandoned execution.
   */
  cancelGraceMs?: number;
}

export interface JobMeta {
  jobId: string;
  attemptsMade: number;
  timestamp: number;
  /**
   * Aborted when the job's `timeout` elapses. Pass it to fetch/DB calls so
   * timed-out work actually STOPS — the timeout alone only rejects the
   * worker's await (releasing the concurrency slot) while the handler keeps
   * running; a BullMQ retry can then overlap the original execution.
   * Handlers that ignore the signal must be idempotent / compare-and-set
   * safe under that overlap.
   */
  signal: AbortSignal;
}

export interface JobDispatchOptions {
  /** Delay job execution by ms */
  delay?: number;
  /** Job priority (lower = higher priority) */
  priority?: number;
  /** Unique job ID (for deduplication) */
  jobId?: string;
  /** Remove job after completion */
  removeOnComplete?: boolean | number;
  /** Remove job after failure */
  removeOnFail?: boolean | number;
  /** One-shot repeat override at dispatch time. Usually prefer `JobDefinition.repeat`. */
  repeat?: JobRepeatOptions;
}

/** Point-in-time snapshot of a single job. */
export interface JobStatus {
  id: string;
  /** Registered job name (= queue name). */
  name: string;
  state: "waiting" | "active" | "completed" | "failed" | "delayed" | "unknown";
  /** Progress reported by the handler via BullMQ `job.updateProgress()`. */
  progress: number | Record<string, unknown>;
  /** True when the job is dequeued by a worker but blocked on a `maxConcurrent` semaphore slot. */
  throttled?: boolean;
  /** Unix ms when the job was enqueued. */
  timestamp?: number;
  /** Unix ms when processing started. */
  processedOn?: number;
  /** Unix ms when the job finished (completed or failed). */
  finishedOn?: number;
  /** Failure message when `state === 'failed'`. */
  failedReason?: string;
  /** Handler return value when `state === 'completed'` (only present if removeOnComplete hasn't cleared the job). */
  returnValue?: unknown;
}

export interface JobsPluginOptions {
  /** Redis connection options (passed to BullMQ) */
  connection: { host: string; port: number; password?: string; db?: number } | unknown;
  /** Job definitions to register */
  jobs: JobDefinition[];
  /**
   * Which HALF of the queue this process owns. Phase 2 of the topology plan:
   * an API replica that merely registered the plugin should not consume jobs.
   *
   * - `'both'` (default) — queues AND workers; the single-process case.
   * - `'producer'` — queues only: `dispatch()` works, NO worker is
   *   constructed, handlers never run here. For API fleets.
   * - `'worker'` — workers AND queues (a worker needs its queue for DLQ +
   *   dispatch-from-handler), HTTP dispatch still possible but the point is
   *   consumption. For dedicated worker fleets.
   *
   * Repeatable schedules are registered by whichever side constructs
   * WORKERS — a producer-only process must not own schedule reconciliation
   * it cannot execute.
   */
  mode?: "both" | "producer" | "worker";
  /** URL prefix for job management endpoints (default: '/jobs') */
  prefix?: string;
  /**
   * Job management HTTP endpoints (`GET <prefix>/stats`,
   * `GET <prefix>/:queue/:id/status`).
   *
   * **Disabled by default.** A job status carries `returnValue` and
   * `failedReason` — the handler's own output and error text, which routinely
   * hold export URLs, billing results, model output, recipient addresses, or
   * internal stack detail. Serving that unauthenticated turns a job id into a
   * read primitive over other tenants' work.
   *
   * Enable it deliberately, with a permission check:
   *
   * ```ts
   * managementRoutes: { operatorPermission: requireRoles(["platform-ops"]) }
   * ```
   *
   * Queue-level counts are also available through the metrics/health
   * integration, which does not expose individual jobs.
   */
  managementRoutes?:
    | false
    | {
        /**
         * REQUIRED — arc will not mount an unguarded management surface.
         *
         * **This is an OPERATOR surface, not a tenant-facing one.** A BullMQ job
         * carries no framework-level tenant identity, and `getStatus` fetches
         * straight by queue + id, so a row-level `policy` on the decision has
         * nothing to filter: `requireOrgRole("manager")` would let a manager in
         * org A read a known job handle from org B. `/stats` is inherently
         * global for the same reason.
         *
         * Gate it on an operator role — `requireRoles(["platform-ops"])` — and
         * keep tenant-facing job status in a resource that owns its own row
         * policy. Arc REFUSES a request whose decision carries a `policy`
         * rather than silently ignoring it.
         */
        operatorPermission: PermissionCheck;
        /**
         * Accept an `operatorPermission` that arc cannot prove is platform-only.
         *
         * By default the gate must carry `_platformOnly` (i.e. come from
         * `requirePlatformRole`), because that property is unprovable from
         * outside: `requireOrgRole("manager")` and the default
         * `requireRoles(["ops"])` both return a bare allow with no policy, so a
         * manager in org A passes and reads a known handle from org B. Boot fails
         * rather than serving a surface whose guard reads as tenant-scoped.
         *
         * Set this only for a custom check you have verified consults platform
         * identity alone.
         */
        allowUnverifiedOperatorPermission?: boolean;
        /** Include the handler's return value in a status response. Default `false`. */
        exposeResult?: boolean;
        /** Include `failedReason` in a status response. Default `false`. */
        exposeFailureReason?: boolean;
      };
  /** Bridge job events to Arc's event bus (default: true) */
  bridgeEvents?: boolean;
  /** Default job options applied to all jobs */
  defaults?: {
    retries?: number;
    backoff?: { type: "exponential" | "fixed"; delay: number };
    timeout?: number;
    removeOnComplete?: boolean | number;
    removeOnFail?: boolean | number;
  };
}

export interface JobDispatcher {
  dispatch<TData = unknown>(
    name: string,
    data: TData,
    options?: JobDispatchOptions,
  ): Promise<JobHandle>;
  getQueue(name: string): unknown | null;
  getStats(): Promise<Record<string, QueueStats>>;
  /**
   * Fetch a point-in-time status snapshot for a job by its ID.
   * QUEUE-QUALIFIED: BullMQ job ids are local to their queue, so an id alone
   * cannot identify a job. `dispatch()` returns the queue name alongside the id
   * for exactly this reason.
   *
   * Returns `null` if the queue is not registered, or the job doesn't exist /
   * has been removed by retention policy.
   */
  getStatus(queue: string, jobId: string): Promise<JobStatus | null>;
  close(): Promise<void>;
}

/**
 * A dispatched job's address. The queue is part of the identity because BullMQ
 * ids are queue-local — two queues can both hold `"123"`.
 */
export interface JobHandle {
  /** Registered job name (= queue name). */
  queue: string;
  jobId: string;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

/**
 * Define a background job with typed data and configuration.
 *
 * @example
 * const processImage = defineJob({
 *   name: 'process-image',
 *   handler: async (data: { url: string; width: number }) => {
 *     return await sharp(data.url).resize(data.width).toBuffer();
 *   },
 *   retries: 3,
 *   timeout: 60000,
 * });
 */
export function defineJob<TData = unknown, TResult = unknown>(
  definition: JobDefinition<TData, TResult>,
): JobDefinition<TData, TResult> {
  return definition;
}
