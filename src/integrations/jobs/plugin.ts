/**
 * Jobs plugin — BullMQ wiring: queues, workers, DLQ routing, the
 * `fastify.jobs` dispatcher, management endpoints, and graceful shutdown.
 *
 * Requires: bullmq (optional peer, imported dynamically at registration).
 * Job processing needs a persistent process and Redis — NOT serverless.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { executeTimedHandler } from "./execution.js";
import { type RepeatSpec, removeStaleRepeatSchedulers } from "./repeat.js";
import type {
  JobDefinition,
  JobDispatcher,
  JobMeta,
  JobStatus,
  JobsPluginOptions,
  QueueStats,
} from "./types.js";

// ============================================================================
// Semaphore — arc-level concurrency cap per job type
// ============================================================================

class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  get isFull(): boolean {
    return this.available === 0;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

// ============================================================================
// Plugin Implementation
// ============================================================================

const jobsPluginImpl: FastifyPluginAsync<JobsPluginOptions> = async (
  fastify: FastifyInstance,
  options: JobsPluginOptions,
) => {
  const { connection, jobs, prefix = "/jobs", bridgeEvents = true, defaults = {} } = options;

  // Dynamic import of BullMQ (only when plugin is actually registered).
  // `bullmq` is a peer-optional dep; the ambient declaration in
  // `src/optional-peers.d.ts` ships the minimal class shapes arc uses.
  let Queue: typeof import("bullmq").Queue;
  let Worker: typeof import("bullmq").Worker;

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
  // Tracks which job IDs are currently held by a maxConcurrent semaphore (active but not yet executing).
  const throttledJobs = new Map<string, Set<string>>();

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
      const repeatOpts: RepeatSpec = {
        ...(job.repeat.pattern
          ? { pattern: job.repeat.pattern, tz: job.repeat.tz }
          : { every: job.repeat.every }),
        ...(job.repeat.endDate ? { endDate: job.repeat.endDate } : {}),
        ...(job.repeat.limit != null ? { limit: job.repeat.limit } : {}),
      };
      // Drop schedules from previous deploys whose repeat spec no longer
      // matches — without this, BullMQ keeps the OLD schedule (keyed by the
      // old spec hash) firing alongside the new one. Fail-open boot hygiene;
      // never touches schedulers arc didn't register.
      await removeStaleRepeatSchedulers(queue, queueName, repeatOpts, fastify.log);
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
    const semaphore = job.maxConcurrent != null ? new Semaphore(job.maxConcurrent) : null;
    const throttledSet: Set<string> = new Set();
    throttledJobs.set(queueName, throttledSet);

    const worker = new Worker(
      queueName,
      async (bullJob: { id?: string; attemptsMade?: number; data?: unknown }) => {
        // Acquire semaphore slot before running the handler.
        // Jobs that find all slots occupied wait here (state stays `active`
        // in BullMQ but `throttled: true` in the status endpoint).
        if (semaphore) {
          if (semaphore.isFull) throttledSet.add(bullJob.id ?? "");
          try {
            await semaphore.acquire();
          } finally {
            throttledSet.delete(bullJob.id ?? "");
          }
        }

        // Timeout + bulkhead semantics live in `executeTimedHandler`
        // (execution.ts) — signal-based cancellation, settle-based
        // slot release, grace-bounded hold. See that module's contract.
        const result: unknown = await executeTimedHandler({
          label: queueName,
          ...(bullJob.id !== undefined ? { jobId: bullJob.id } : {}),
          ...(jobTimeout !== undefined ? { timeoutMs: jobTimeout } : {}),
          ...(job.cancelGraceMs !== undefined ? { cancelGraceMs: job.cancelGraceMs } : {}),
          ...(semaphore ? { releaseSlot: () => semaphore.release() } : {}),
          logger: fastify.log,
          run: (signal) => {
            const meta: JobMeta = {
              jobId: bullJob.id ?? "",
              attemptsMade: bullJob.attemptsMade ?? 0,
              timestamp: Date.now(),
              signal,
            };
            return job.handler(bullJob.data, meta);
          },
        });

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
    worker.on(
      "failed",
      async (
        bullJob: { id?: string; attemptsMade?: number; data?: unknown } | undefined,
        error: Error,
      ) => {
        // Move to dead-letter queue when all retries are exhausted
        const maxAttempts = job.retries ?? defaults.retries ?? 3;
        if (dlqQueue && bullJob && (bullJob.attemptsMade ?? 0) >= maxAttempts) {
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
      },
    );

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

  // Definition lookup for dispatch() — a Map replaces the previous O(n)
  // Array.find on every dispatch. First definition wins on duplicate names,
  // matching Array.find semantics exactly.
  const jobDefsByName = new Map<string, JobDefinition>();
  for (const job of jobs) {
    if (!jobDefsByName.has(job.name)) jobDefsByName.set(job.name, job);
  }

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

      const jobDef = jobDefsByName.get(name);
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

    async getStatus(jobId) {
      for (const [name, queue] of queues) {
        const job = await (
          queue as unknown as { getJob(id: string): Promise<Record<string, unknown> | undefined> }
        ).getJob(jobId);
        if (!job) continue;

        const state = (
          typeof (job as { getState?: () => Promise<string> }).getState === "function"
            ? await (job as { getState(): Promise<string> }).getState()
            : "unknown"
        ) as JobStatus["state"];

        const throttled = throttledJobs.get(name)?.has(jobId) || undefined;

        return {
          id: jobId,
          name,
          state,
          progress: (job.progress ?? 0) as number | Record<string, unknown>,
          throttled: throttled === true ? true : undefined,
          timestamp: (job.timestamp as number | undefined) ?? undefined,
          processedOn: (job.processedOn as number | null | undefined) ?? undefined,
          finishedOn: (job.finishedOn as number | null | undefined) ?? undefined,
          failedReason: (job.failedReason as string | undefined) ?? undefined,
          returnValue: (job.returnvalue as unknown) ?? undefined,
        };
      }
      return null;
    },

    async close() {
      // Pause workers first so they stop claiming new jobs before we tear
      // down connections. In-flight jobs get a chance to drain via the
      // subsequent worker.close() call. Without this, a SIGTERM during
      // dispatch can leave orphaned jobs mid-execution.
      await Promise.all(
        Array.from(workers.values()).map((w) =>
          (w as unknown as { pause: () => Promise<void> }).pause().catch(() => {
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

  fastify.get(`${prefix}/:id/status`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const status = await dispatcher.getStatus(id);
    if (!status) {
      return reply.status(404).send({ success: false, error: "Job not found" });
    }
    return { success: true, data: status };
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
