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
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

// ============================================================================
// Types (no BullMQ import at module level)
// ============================================================================

export interface JobDefinition<TData = unknown, TResult = unknown> {
  /** Unique job name */
  name: string;
  /** Job handler function */
  handler: (data: TData, meta: JobMeta) => Promise<TResult>;
  /** Number of retries on failure (default: 3) */
  retries?: number;
  /** Backoff strategy */
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
  /** Job timeout in ms (default: 30000) */
  timeout?: number;
  /** Concurrency per worker (default: 1) */
  concurrency?: number;
  /** Rate limit: max jobs per duration */
  rateLimit?: { max: number; duration: number };
  /** Dead letter queue name (default: '{name}:dead') */
  deadLetterQueue?: string;
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
    backoff?: { type: 'exponential' | 'fixed'; delay: number };
    timeout?: number;
    removeOnComplete?: boolean | number;
    removeOnFail?: boolean | number;
  };
}

export interface JobDispatcher {
  dispatch<TData = unknown>(
    name: string,
    data: TData,
    options?: JobDispatchOptions
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
  definition: JobDefinition<TData, TResult>
): JobDefinition<TData, TResult> {
  return definition;
}

// ============================================================================
// Plugin Implementation
// ============================================================================

const jobsPluginImpl: FastifyPluginAsync<JobsPluginOptions> = async (
  fastify: FastifyInstance,
  options: JobsPluginOptions
) => {
  const {
    connection,
    jobs,
    prefix = '/jobs',
    bridgeEvents = true,
    defaults = {},
  } = options;

  // Dynamic import of BullMQ (only when plugin is actually registered)
  let Queue: any;
  let Worker: any;

  try {
    const bullmq = await import('bullmq');
    Queue = bullmq.Queue;
    Worker = bullmq.Worker;
  } catch {
    throw new Error(
      '@classytic/arc/integrations/jobs requires "bullmq" package.\n' +
      'Install it: npm install bullmq'
    );
  }

  const queues = new Map<string, InstanceType<typeof Queue>>();
  const workers = new Map<string, InstanceType<typeof Worker>>();

  // Register each job as a queue + worker pair
  for (const job of jobs) {
    const queueName = job.name;

    // Create queue
    const queue = new Queue(queueName, { connection });
    queues.set(queueName, queue);

    // Create worker
    const worker = new Worker(
      queueName,
      async (bullJob: any) => {
        const meta: JobMeta = {
          jobId: bullJob.id,
          attemptsMade: bullJob.attemptsMade,
          timestamp: Date.now(),
        };

        const result = await job.handler(bullJob.data, meta);

        // Bridge completion event
        if (bridgeEvents && fastify.events?.publish) {
          await fastify.events.publish(`job.${queueName}.completed`, {
            jobId: bullJob.id,
            data: bullJob.data,
            result,
          });
        }

        return result;
      },
      {
        connection,
        concurrency: job.concurrency ?? 1,
        limiter: job.rateLimit
          ? { max: job.rateLimit.max, duration: job.rateLimit.duration }
          : undefined,
      }
    );

    // Bridge failure event
    worker.on('failed', async (bullJob: any, error: Error) => {
      if (bridgeEvents && fastify.events?.publish) {
        await fastify.events.publish(`job.${queueName}.failed`, {
          jobId: bullJob?.id,
          data: bullJob?.data,
          error: error.message,
          attemptsMade: bullJob?.attemptsMade,
        });
      }
    });

    workers.set(queueName, worker);
  }

  // Dispatcher interface
  const dispatcher: JobDispatcher = {
    async dispatch(name, data, opts = {}) {
      const queue = queues.get(name);
      if (!queue) {
        throw new Error(`Job queue '${name}' not registered. Available: ${Array.from(queues.keys()).join(', ')}`);
      }

      const jobDef = jobs.find((j) => j.name === name);
      const bullJob = await queue.add(name, data, {
        delay: opts.delay,
        priority: opts.priority,
        jobId: opts.jobId,
        removeOnComplete: opts.removeOnComplete ?? defaults.removeOnComplete ?? 100,
        removeOnFail: opts.removeOnFail ?? defaults.removeOnFail ?? 500,
        attempts: jobDef?.retries ?? defaults.retries ?? 3,
        backoff: jobDef?.backoff ?? defaults.backoff ?? { type: 'exponential', delay: 1000 },
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
      const closePromises: Promise<void>[] = [];
      for (const worker of workers.values()) {
        closePromises.push(worker.close());
      }
      for (const queue of queues.values()) {
        closePromises.push(queue.close());
      }
      await Promise.all(closePromises);
    },
  };

  // Decorate fastify
  if (!fastify.hasDecorator('jobs')) {
    fastify.decorate('jobs', dispatcher);
  }

  // Management endpoints
  fastify.get(`${prefix}/stats`, async () => {
    const stats = await dispatcher.getStats();
    return { success: true, data: stats };
  });

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    await dispatcher.close();
  });
};

/** Pluggable BullMQ job queue integration for Arc */
export const jobsPlugin: FastifyPluginAsync<JobsPluginOptions> = jobsPluginImpl;
export default jobsPlugin;
