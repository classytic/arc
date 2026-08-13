/**
 * Jobs plugin — BullMQ wiring: queues, workers, DLQ routing, the
 * `fastify.jobs` dispatcher, management endpoints, and graceful shutdown.
 *
 * Requires: bullmq (optional peer, imported dynamically at registration).
 * Job processing needs a persistent process and Redis — NOT serverless.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { evaluateAndApplyPermission } from "../../permissions/authorizationDecision.js";
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
  const {
    connection,
    jobs,
    prefix = "/jobs",
    bridgeEvents = true,
    defaults = {},
    mode = "both",
  } = options;

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

  // Validate the WHOLE definition set before constructing a single BullMQ
  // object. Every failure below is unrecoverable at runtime, and allocating
  // queues/workers first would leave live Redis connections behind when we throw.
  const seenNames = new Set<string>();
  for (const job of jobs) {
    if (typeof job.name !== "string" || job.name.trim() === "") {
      throw new Error("[arc/jobs] a job definition has an empty name — names are the queue key.");
    }
    // Duplicates are silently destructive: the loop below creates a queue AND a
    // worker per definition and overwrites the map entry, so BOTH workers stay
    // live while only the last is tracked. Shutdown then closes one of them, the
    // other keeps consuming, and dispatch resolves its config from the first
    // definition while the maps hold the last — jobs processed by whichever
    // worker wins the race.
    if (seenNames.has(job.name)) {
      throw new Error(
        `[arc/jobs] duplicate job name "${job.name}". A name is the queue key, so two ` +
          "definitions sharing one would leave an untracked worker consuming the same " +
          "queue after shutdown. Rename one, or register it in a single definition.",
      );
    }
    seenNames.add(job.name);

    // Numeric guards. Each of these reaches BullMQ or arc's semaphore and fails
    // as a hang or as unclear behaviour rather than an error.
    const positiveInt = (v: unknown, field: string): void => {
      if (v === undefined) return;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new Error(
          `[arc/jobs] Job '${job.name}' has ${field}=${String(v)} — must be a positive integer.`,
        );
      }
    };
    const nonNegativeInt = (v: unknown, field: string): void => {
      if (v === undefined) return;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new Error(
          `[arc/jobs] Job '${job.name}' has ${field}=${String(v)} — must be a non-negative integer.`,
        );
      }
    };
    // `maxConcurrent <= 0` never releases a semaphore slot: the job waits forever
    // with no error and no timeout.
    positiveInt(job.maxConcurrent, "maxConcurrent");
    positiveInt(job.concurrency, "concurrency");
    positiveInt(job.timeout, "timeout");
    nonNegativeInt(job.retries, "retries");
    nonNegativeInt(job.cancelGraceMs, "cancelGraceMs");
    if (job.rateLimit) {
      positiveInt(job.rateLimit.max, "rateLimit.max");
      positiveInt(job.rateLimit.duration, "rateLimit.duration");
    }
    // A negative backoff delay makes BullMQ's retry timing nonsensical.
    if (job.backoff) nonNegativeInt(job.backoff.delay, "backoff.delay");
    if (job.repeat) {
      // `every: 0` / negative is a busy-loop or a schedule that never fires;
      // `limit: 0` registers a repeatable that is dead on arrival; a blank
      // pattern reaches the cron parser as a runtime surprise.
      positiveInt(job.repeat.every, "repeat.every");
      positiveInt(job.repeat.limit, "repeat.limit");
      if (job.repeat.pattern !== undefined && job.repeat.pattern.trim() === "") {
        throw new Error(`[arc/jobs] Job '${job.name}' has an empty repeat.pattern.`);
      }
    }
  }

  // Defaults are INHERITED by every job that omits the field, so an invalid
  // default is the same failure multiplied across the registry — and it is not
  // covered by the per-job loop above, which only sees explicitly-set values.
  if (defaults) {
    const d = defaults as {
      retries?: unknown;
      timeout?: unknown;
      backoff?: { delay?: unknown };
    };
    const defaultPositiveInt = (v: unknown, field: string): void => {
      if (v === undefined) return;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new Error(`[arc/jobs] defaults.${field}=${String(v)} — must be a positive integer.`);
      }
    };
    const defaultNonNegativeInt = (v: unknown, field: string): void => {
      if (v === undefined) return;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new Error(
          `[arc/jobs] defaults.${field}=${String(v)} — must be a non-negative integer.`,
        );
      }
    };
    defaultNonNegativeInt(d.retries, "retries");
    defaultPositiveInt(d.timeout, "timeout");
    if (d.backoff) defaultNonNegativeInt(d.backoff.delay, "backoff.delay");
  }

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

  // Register each job as a queue (+ worker unless producer-only).
  // mode: 'producer' constructs NO Worker — an API replica that merely
  // registered the plugin must not consume jobs it cannot be scaled for;
  // dispatch() and stats still work through the queue.
  for (const job of jobs) {
    const queueName = job.name;

    // Create queue
    const queue = new Queue(queueName, { connection });
    queues.set(queueName, queue);

    // Upsert the repeatable schedule up-front so it survives worker restart.
    // WORKER-side ownership: a producer-only process must not own schedule
    // reconciliation it cannot execute — its stale-scheduler sweep would
    // fight the worker fleet's, and the enqueued repeats would sit
    // unconsumed if no worker exists yet.
    if (job.repeat && mode !== "producer") {
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

    if (mode !== "producer") {
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

      return { queue: name, jobId: bullJob.id };
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

    async getStatus(queueName, jobId) {
      // Queue-qualified by contract. BullMQ ids are queue-LOCAL, so scanning
      // every queue for an id both returned an arbitrary winner when two queues
      // held the same id and cost one Redis round trip per registered job type.
      const queue = queues.get(queueName);
      if (queue) {
        const name = queueName;
        const job = await (
          queue as unknown as { getJob(id: string): Promise<Record<string, unknown> | undefined> }
        ).getJob(jobId);
        if (!job) return null;

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

  // ── Management endpoints — OFF unless the host asks for them ──
  //
  // A status carries `returnValue` and `failedReason`: the handler's own output
  // and error text, which routinely hold export URLs, billing results, model
  // output, recipient addresses, or internal stack detail. Mounting that
  // unauthenticated turns a job id into a read primitive over other tenants'
  // work, so the surface is opt-in AND the permission is mandatory — there is no
  // shape of this option that yields an unguarded route.
  const management = options.managementRoutes;
  if (management) {
    const gate = management.operatorPermission;

    // These routes are GLOBAL by construction: `/stats` spans every queue, and a
    // job carries no tenant identity to filter by. A gate that grants per
    // organization therefore reads as scoped while serving everyone —
    // `requireOrgRole("manager")` lets org A's manager inspect org B's handle,
    // and `requireRoles(["platform-ops"])` is satisfied by an ORG role of that
    // name (its documented default). Neither returns a policy, so no
    // per-request check can tell them apart from a real operator gate.
    //
    // So arc requires the check to DECLARE itself platform-only, and fails at
    // boot when it cannot — a misconfigured operator surface should never reach
    // the first request.
    if (!gate._platformOnly && !management.allowUnverifiedOperatorPermission) {
      throw new Error(
        "[arc/jobs] managementRoutes.operatorPermission must be platform-only. These routes are " +
          "global (jobs carry no tenant identity), so an org-role gate would let a member of one " +
          "organization read another's jobs. Use requirePlatformRole('platform-ops') — or " +
          "requireRoles([...], { includeOrgRoles: false }) with " +
          "allowUnverifiedOperatorPermission: true if you have verified the check yourself.",
      );
    }
    const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
      const allowed = await evaluateAndApplyPermission(
        gate,
        {
          user: (req.user ?? null) as never,
          request: req as never,
          resource: "jobs",
          action: "read",
        },
        req,
        reply,
      );
      if (!allowed) return false;

      // A row-level policy has nothing to filter here: a BullMQ job carries no
      // tenant identity and `getStatus` fetches straight by queue + id. Accepting
      // one anyway would make `requireOrgRole("manager")` READ as tenant-scoped
      // while actually serving every org's jobs. Arc's semantics say a policy is
      // ENFORCED, so the honest choices are refuse or mislead.
      const policy = (req as { _policyFilters?: Record<string, unknown> })._policyFilters;
      if (policy && Object.keys(policy).length > 0) {
        fastify.log.error(
          "[arc/jobs] managementRoutes.operatorPermission returned a row-level policy, which this " +
            "surface cannot apply — jobs carry no tenant identity. Gate it on an operator role " +
            "(e.g. requireRoles(['platform-ops'])) and serve tenant-facing job status from a " +
            "resource that owns its own row policy.",
        );
        await reply.status(403).send({
          code: "arc.jobs.policy_unsupported",
          message:
            "Job management routes are an operator surface and cannot apply a row-level policy.",
          status: 403,
        });
        return false;
      }
      return true;
    };

    fastify.get(`${prefix}/stats`, async (req, reply) => {
      if (!(await guard(req, reply))) return reply;
      return { stats: await dispatcher.getStats() };
    });

    // Queue-qualified: BullMQ ids are queue-LOCAL, so `/jobs/:id/status` had to
    // scan every queue and returned whichever matched first — ambiguous when two
    // queues hold the same id, and N sequential Redis round trips per request.
    fastify.get(`${prefix}/:queue/:id/status`, async (req, reply) => {
      if (!(await guard(req, reply))) return reply;
      const { queue, id } = req.params as { queue: string; id: string };
      const status = await dispatcher.getStatus(queue, id);
      if (!status) {
        return reply
          .status(404)
          .send({ code: "arc.not_found", message: "Job not found", status: 404 });
      }
      // Redact by default — the host opts into each sensitive field knowing what
      // its own handlers return.
      const { returnValue, failedReason, ...safe } = status;
      return {
        ...safe,
        ...(management.exposeResult ? { returnValue } : {}),
        ...(management.exposeFailureReason ? { failedReason } : {}),
      };
    });
  }

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
