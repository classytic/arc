/**
 * @classytic/arc — Job Queue Integration
 *
 * Pluggable adapter for background job processing with BullMQ.
 * Provides a clean defineJob() API, auto-connects to Arc's event bus,
 * and supports retries, delays, priorities, and dead-letter queues.
 *
 * This is a SEPARATE subpath import — only loaded when explicitly used:
 *   import { jobsPlugin, defineJob } from '@classytic/arc/integrations/jobs';
 *
 * Requires: bullmq (peer dependency)
 *
 * NOTE: Job processing requires a persistent process and Redis.
 * This does NOT work on serverless platforms.
 *
 * @example
 * ```typescript
 * import { jobsPlugin, defineJob } from '@classytic/arc/integrations/jobs';
 *
 * const sendEmail = defineJob({
 *   name: 'send-email',
 *   handler: async (data) => {
 *     await emailService.send(data.to, data.subject, data.body);
 *   },
 *   retries: 3,
 *   backoff: { type: 'exponential', delay: 1000 },
 * });
 *
 * await fastify.register(jobsPlugin, {
 *   connection: { host: 'localhost', port: 6379 },
 *   jobs: [sendEmail],
 * });
 *
 * // Dispatch a job from anywhere
 * await fastify.jobs.dispatch('send-email', {
 *   to: 'user@example.com',
 *   subject: 'Hello',
 *   body: 'Welcome!',
 * });
 * ```
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

// ============================================================================
// Types (no BullMQ import at module level)
// ============================================================================

/** Repeat schedule — cron pattern or fixed interval. Explicit timezone is required. */
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
}

export interface JobMeta {
  jobId: string;
  attemptsMade: number;
  timestamp: number;
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

export interface JobsPluginOptions {
  /** Redis connection options (passed to BullMQ) */
  connection: { host: string; port: number; password?: string; db?: number } | unknown;
  /** Job definitions to register */
  jobs: JobDefinition[];
  /** URL prefix for job management endpoints (default: '/jobs') */
  prefix?: string;
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
  ): Promise<{ jobId: string }>;
  getQueue(name: string): unknown | null;
  getStats(): Promise<Record<string, QueueStats>>;
  close(): Promise<void>;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

// ============================================================================
// defineJob — declarative job definition
// ============================================================================

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

// ============================================================================
// Plugin Implementation
// ============================================================================

const jobsPluginImpl: FastifyPluginAsync<JobsPluginOptions> = async (
  fastify: FastifyInstance,
  options: JobsPluginOptions,
) => {
  const { connection, jobs, prefix = "/jobs", bridgeEvents = true, defaults = {} } = options;

  // Dynamic import of BullMQ (only when plugin is actually registered)
  let Queue: any;
  let Worker: any;

  try {
    const bullmq = await import("bullmq");
    Queue = bullmq.Queue;
    Worker = bullmq.Worker;
  } catch {
    throw new Error(
      '@classytic/arc/integrations/jobs requires "bullmq" package.\n' +
        "Install it: npm install bullmq",
    );
  }

  // BullMQ requires `maxRetriesPerRequest: null` on ioredis connections to
  // avoid workers stopping on connection blips. Detect the common naive
  // shape (`new Redis(url)`) and warn loudly — runtime still works, but the
  // user will hit stalls during first Redis hiccup without this.
  if (
    connection &&
    typeof connection === "object" &&
    "options" in (connection as Record<string, unknown>)
  ) {
    const ioredisOpts = (connection as { options: { maxRetriesPerRequest?: number | null } })
      .options;
    if (ioredisOpts?.maxRetriesPerRequest !== null) {
      fastify.log.warn(
        "[arc/jobs] BullMQ requires ioredis `maxRetriesPerRequest: null`. " +
          "Pass `new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false })` " +
          "or workers will stall on transient Redis errors.",
      );
    }
  }

  const queues = new Map<string, InstanceType<typeof Queue>>();
  const dlqQueues = new Map<string, InstanceType<typeof Queue>>();
  const workers = new Map<string, InstanceType<typeof Worker>>();

  // Validate repeat configuration up-front so misconfigured jobs fail fast
  // instead of silently running on server-local time (DST drift hazard).
  for (const job of jobs) {
    if (!job.repeat) continue;
    const { pattern, every, tz } = job.repeat;
    if (pattern && every) {
      throw new Error(
        `[arc/jobs] Job '${job.name}' sets both repeat.pattern and repeat.every — use one.`,
      );
    }
    if (!pattern && every == null) {
      throw new Error(`[arc/jobs] Job '${job.name}' has repeat config but no pattern or every.`);
    }
    if (pattern && !tz) {
      throw new Error(
        `[arc/jobs] Job '${job.name}' uses a cron pattern but no timezone. ` +
          "Set repeat.tz (e.g. 'UTC' or 'America/New_York') to avoid DST drift.",
      );
    }
  }

  // Register each job as a queue + worker pair
  for (const job of jobs) {
    const queueName = job.name;

    // Create queue
    const queue = new Queue(queueName, { connection });
    queues.set(queueName, queue);

    // Upsert the repeatable schedule up-front so it survives worker restart.
    if (job.repeat) {
      const repeatOpts = {
        ...(job.repeat.pattern
          ? { pattern: job.repeat.pattern, tz: job.repeat.tz }
          : { every: job.repeat.every }),
        ...(job.repeat.endDate ? { endDate: job.repeat.endDate } : {}),
        ...(job.repeat.limit != null ? { limit: job.repeat.limit } : {}),
      };
      await queue.add(
        queueName,
        {},
        {
          repeat: repeatOpts,
          removeOnComplete: defaults.removeOnComplete ?? 100,
          removeOnFail: defaults.removeOnFail ?? 500,
        },
      );
    }

    // DLQ queue — only created when explicitly configured
    let dlqQueue: InstanceType<typeof Queue> | null = null;
    if (job.deadLetterQueue != null) {
      // BullMQ rejects queue names containing ':' — use '-' as the DLQ suffix.
      const dlqName = job.deadLetterQueue || `${queueName}-dead`;
      dlqQueue = new Queue(dlqName, { connection });
      dlqQueues.set(dlqName, dlqQueue);
    }

    // Create worker with timeout support
    const jobTimeout = job.timeout ?? defaults.timeout;
    const worker = new Worker(
      queueName,
      async (bullJob: any) => {
        const meta: JobMeta = {
          jobId: bullJob.id,
          attemptsMade: bullJob.attemptsMade,
          timestamp: Date.now(),
        };

        // Apply job-level timeout if configured.
        // Clear the timer on success to avoid orphaned timers under load.
        let result: unknown;
        if (jobTimeout) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Job '${queueName}' timed out after ${jobTimeout}ms`)),
              jobTimeout,
            );
          });
          try {
            result = await Promise.race([job.handler(bullJob.data, meta), timeoutPromise]);
          } finally {
            clearTimeout(timer);
          }
        } else {
          result = await job.handler(bullJob.data, meta);
        }

        // Bridge completion event
        if (bridgeEvents && fastify.events?.publish) {
          try {
            await fastify.events.publish(`job.${queueName}.completed`, {
              jobId: bullJob.id,
              data: bullJob.data,
              result,
            });
          } catch (err) {
            fastify.log.warn(
              { err, jobId: bullJob.id },
              `Failed to publish job.${queueName}.completed event`,
            );
          }
        }

        return result;
      },
      {
        connection,
        concurrency: job.concurrency ?? 1,
        limiter: job.rateLimit
          ? { max: job.rateLimit.max, duration: job.rateLimit.duration }
          : undefined,
      },
    );

    // Bridge failure event + DLQ routing
    worker.on("failed", async (bullJob: any, error: Error) => {
      // Move to dead-letter queue when all retries are exhausted
      const maxAttempts = job.retries ?? defaults.retries ?? 3;
      if (dlqQueue && bullJob && bullJob.attemptsMade >= maxAttempts) {
        try {
          await dlqQueue.add(`${queueName}:dead`, bullJob.data, {
            jobId: `${bullJob.id}:dlq`,
            removeOnComplete: false,
          });
          fastify.log.warn(
            { jobId: bullJob.id, dlq: job.deadLetterQueue ?? `${queueName}:dead` },
            `Job moved to dead-letter queue`,
          );
        } catch (dlqErr) {
          fastify.log.error({ err: dlqErr, jobId: bullJob.id }, `Failed to move job to DLQ`);
        }
      }

      if (bridgeEvents && fastify.events?.publish) {
        try {
          await fastify.events.publish(`job.${queueName}.failed`, {
            jobId: bullJob?.id,
            data: bullJob?.data,
            error: error.message,
            attemptsMade: bullJob?.attemptsMade,
          });
        } catch (err) {
          fastify.log.warn(
            { err, jobId: bullJob?.id },
            `Failed to publish job.${queueName}.failed event`,
          );
        }
      }
    });

    // Stalled-job detection — BullMQ fires this when a worker's lock lapses
    // without a heartbeat, which usually means the worker process crashed.
    // Surface it as a first-class event so operators can alert on silent
    // failures (a failed handler is NOT always a stalled worker).
    worker.on("stalled", async (jobId: string) => {
      fastify.log.warn({ jobId, queue: queueName }, "Job stalled — worker may have crashed");
      if (bridgeEvents && fastify.events?.publish) {
        try {
          await fastify.events.publish(`job.${queueName}.stalled`, { jobId });
        } catch (err) {
          fastify.log.warn({ err, jobId }, `Failed to publish job.${queueName}.stalled event`);
        }
      }
    });

    workers.set(queueName, worker);
  }

  // Large payloads inflate Redis memory and slow every worker handoff.
  // BullMQ's rule of thumb is "pass IDs, not objects" — we warn above 100 KB
  // of serialized JSON so the dispatch call stays observable in logs.
  const JOB_PAYLOAD_WARN_BYTES = 100 * 1024;

  // Dispatcher interface
  const dispatcher: JobDispatcher = {
    async dispatch(name, data, opts = {}) {
      const queue = queues.get(name);
      if (!queue) {
        throw new Error(
          `Job queue '${name}' not registered. Available: ${Array.from(queues.keys()).join(", ")}`,
        );
      }

      try {
        const serializedBytes = Buffer.byteLength(JSON.stringify(data) ?? "", "utf8");
        if (serializedBytes > JOB_PAYLOAD_WARN_BYTES) {
          fastify.log.warn(
            { queue: name, bytes: serializedBytes, limit: JOB_PAYLOAD_WARN_BYTES },
            `[arc/jobs] Large job payload — prefer passing IDs and reloading in the handler`,
          );
        }
      } catch {
        // Non-serializable data is going to blow up further down anyway;
        // don't fail dispatch here, let BullMQ surface the real error.
      }

      const jobDef = jobs.find((j) => j.name === name);
      const bullJob = await queue.add(name, data, {
        delay: opts.delay,
        priority: opts.priority,
        jobId: opts.jobId,
        removeOnComplete: opts.removeOnComplete ?? defaults.removeOnComplete ?? 100,
        removeOnFail: opts.removeOnFail ?? defaults.removeOnFail ?? 500,
        attempts: jobDef?.retries ?? defaults.retries ?? 3,
        backoff: jobDef?.backoff ?? defaults.backoff ?? { type: "exponential", delay: 1000 },
        repeat: jobDef?.repeat ?? opts.repeat,
      });

      return { jobId: bullJob.id };
    },

    getQueue(name) {
      return queues.get(name) ?? null;
    },

    async getStats() {
      const stats: Record<string, QueueStats> = {};
      for (const [name, queue] of queues) {
        const counts = await queue.getJobCounts();
        stats[name] = {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
        };
      }
      return stats;
    },

    async close() {
      // Pause workers first so they stop claiming new jobs before we tear
      // down connections. In-flight jobs get a chance to drain via the
      // subsequent worker.close() call. Without this, a SIGTERM during
      // dispatch can leave orphaned jobs mid-execution.
      await Promise.all(
        Array.from(workers.values()).map((w) =>
          (w as { pause: () => Promise<void> }).pause().catch(() => {
            /* worker may already be stopped */
          }),
        ),
      );

      const closePromises: Promise<void>[] = [];
      for (const worker of workers.values()) {
        closePromises.push(worker.close());
      }
      for (const queue of queues.values()) {
        closePromises.push(queue.close());
      }
      for (const dlq of dlqQueues.values()) {
        closePromises.push(dlq.close());
      }
      await Promise.all(closePromises);
    },
  };

  // Decorate fastify
  if (!fastify.hasDecorator("jobs")) {
    fastify.decorate("jobs", dispatcher);
  }

  // Management endpoints
  fastify.get(`${prefix}/stats`, async () => {
    const stats = await dispatcher.getStats();
    return { success: true, data: stats };
  });

  // Graceful shutdown
  fastify.addHook("onClose", async () => {
    await dispatcher.close();
  });
};

/**
 * Pluggable BullMQ job queue integration for Arc.
 *
 * Wrapped with fastify-plugin so the `fastify.jobs` decorator is available
 * in the outer scope (the documented `fastify.jobs.dispatch(...)` usage).
 */
export const jobsPlugin: FastifyPluginAsync<JobsPluginOptions> = fp(jobsPluginImpl, {
  name: "arc-jobs",
  fastify: "5.x",
});
