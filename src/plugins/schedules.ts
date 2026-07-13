/**
 * Schedules Plugin — in-process recurring jobs with optional multi-replica
 * leader safety. The framework answer to the hand-rolled cron layer every
 * production host grows (job registry + mongo lock + backoff + "did I
 * remember to stop timers on shutdown?").
 *
 * Design constraints (deliberate):
 *
 * - **Interval-based, not cron-expression-based.** `every` milliseconds
 *   covers the audited fleet of real host jobs (sweeps, reconciliations,
 *   retries, digests) without arc growing a cron parser dependency. Hosts
 *   that need calendar semantics ("02:00 on the 1st") should reach for the
 *   BullMQ jobs integration (`@classytic/arc/integrations/jobs`) — that's
 *   the durable, Redis-backed tier of the same concern.
 * - **No overlap by construction.** The next tick is scheduled only after
 *   the current run settles (timeout chain, not `setInterval`) — a slow
 *   run delays the next one instead of stacking.
 * - **Multi-replica safe via a lease, not an election.** Pass any `lock`
 *   implementing the ecosystem `LockAdapter` contract (mongokit:
 *   `@classytic/mongokit/lock`, sqlitekit, or repo-core's
 *   `createMemoryLockAdapter` for tests). Each tick tries
 *   `tryAcquire('arc:schedule:<name>', holderId, leaseMs)` — winners run,
 *   losers skip. The lease is deliberately NOT released after the run:
 *   holding it for ~the interval is what stops the other replicas from
 *   re-firing the same tick. Crashed leaders recover when the lease lapses.
 * - **Fail-open per tick.** A throwing handler is logged (with the job
 *   name) and the loop continues — one bad sweep must not kill the
 *   schedule. Failure counts surface on `getScheduleStats()`.
 *
 * @example
 * ```typescript
 * import { schedulesPlugin } from '@classytic/arc/plugins';
 * import { createMongoLockAdapter } from '@classytic/mongokit/lock';
 *
 * await app.register(schedulesPlugin, {
 *   lock: createMongoLockAdapter({ connection }),
 *   schedules: [
 *     { name: 'outbox-sweep', every: 30_000, handler: async (f) => f.arc?.modules && sweep() },
 *     { name: 'daily-digest', every: 86_400_000, runOnStart: false, handler: sendDigest },
 *   ],
 * });
 * ```
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

/**
 * Structural view of the ecosystem lock contract — matches
 * `LockAdapter` from `@classytic/repo-core/lock` (and every kit
 * implementation) WITHOUT importing the subpath, so arc's emitted
 * declarations carry no repo-core@>=0.8 subpath reference and the
 * peer floor stays honest. Any conforming adapter assigns.
 */
export interface ScheduleLockLike {
  tryAcquire(name: string, holderId: string, leaseMs: number): Promise<boolean> | boolean;
  release(name: string, holderId: string): Promise<boolean> | boolean;
}

export interface ScheduleDefinition {
  /** Unique name — also the lock key (`arc:schedule:<name>`). */
  name: string;
  /** Interval in milliseconds between the END of one run and the next tick. */
  every: number;
  /** The work. Receives the Fastify instance; errors are logged, never fatal. */
  handler: (fastify: FastifyInstance) => void | Promise<void>;
  /** Fire once immediately when the app becomes ready (default: false). */
  runOnStart?: boolean;
  /**
   * Random extra delay in `[0, jitterMs)` added to the FIRST tick only.
   * Spreads boot-aligned jobs so multiple same-cadence schedules don't all
   * fire at exactly `boot + every` after every restart (and, with a lock,
   * de-synchronizes replicas competing for the same lease). Ignored when
   * `runOnStart` is true.
   */
  jitterMs?: number;
  /**
   * Lease duration when a `lock` is configured. Default: `every * 0.9`
   * (capped at 5 minutes) — long enough that other replicas skip the same
   * tick, short enough that a crashed leader fails over within one cycle.
   */
  leaseMs?: number;
  /** Per-schedule kill switch (default: true). */
  enabled?: boolean;
}

export interface SchedulesPluginOptions {
  schedules: ScheduleDefinition[];
  /**
   * Ecosystem lock adapter for multi-replica deployments. Omit for
   * single-instance apps — every tick runs locally.
   */
  lock?: ScheduleLockLike;
  /**
   * Identity of this replica for lease ownership. Default: a random id per
   * process (repo-core's `getInstanceId()` is a good explicit value).
   */
  holderId?: string;
  /**
   * Master switch — `false` registers a typed no-op (config-gated
   * environments), same pattern as `idempotencyPlugin`.
   */
  enabled?: boolean;
}

/** Per-schedule runtime counters, readable via `fastify.getScheduleStats()`. */
export interface ScheduleStats {
  name: string;
  runs: number;
  failures: number;
  skippedByLock: number;
  lastRunAt: string | null;
  lastError: string | null;
}

declare module "fastify" {
  interface FastifyInstance {
    getScheduleStats?: () => ScheduleStats[];
  }
}

const MIN_SAFE_INTERVAL_MS = 1000;
const MAX_DEFAULT_LEASE_MS = 300_000;

const schedulesPlugin: FastifyPluginAsync<SchedulesPluginOptions> = async (fastify, opts) => {
  const { schedules, lock, enabled = true } = opts;
  const holderId = opts.holderId ?? `arc-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  const stats = new Map<string, ScheduleStats>();
  fastify.decorate("getScheduleStats", () => [...stats.values()].map((s) => ({ ...s })));

  if (!enabled) {
    fastify.log.debug("schedulesPlugin disabled — registered as no-op");
    return;
  }

  // Fail-fast validation — a bad schedule table is a boot bug, not a tick bug.
  const seen = new Set<string>();
  for (const s of schedules) {
    if (!s.name) throw new TypeError("[arc-schedules] every schedule needs a name");
    if (seen.has(s.name))
      throw new TypeError(`[arc-schedules] duplicate schedule name "${s.name}"`);
    seen.add(s.name);
    if (!Number.isFinite(s.every) || s.every <= 0) {
      throw new TypeError(`[arc-schedules] "${s.name}": \`every\` must be a positive number of ms`);
    }
    if (s.every < MIN_SAFE_INTERVAL_MS) {
      fastify.log.warn(
        `[arc-schedules] "${s.name}" runs every ${s.every}ms — sub-second schedules are almost ` +
          "always a bug in production (DB pressure, lock churn). Intended for tests only.",
      );
    }
  }

  const timers = new Map<string, NodeJS.Timeout>();
  const inFlight = new Map<string, Promise<void>>();
  let closing = false;

  async function tick(s: ScheduleDefinition): Promise<void> {
    const stat = stats.get(s.name);
    if (!stat) return;
    try {
      if (lock) {
        const leaseMs = s.leaseMs ?? Math.min(Math.floor(s.every * 0.9), MAX_DEFAULT_LEASE_MS);
        const won = await lock.tryAcquire(`arc:schedule:${s.name}`, holderId, leaseMs);
        if (!won) {
          stat.skippedByLock++;
          return;
        }
      }
      stat.runs++;
      stat.lastRunAt = new Date().toISOString();
      await s.handler(fastify);
      stat.lastError = null;
    } catch (err) {
      stat.failures++;
      stat.lastError = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err, schedule: s.name }, "[arc-schedules] schedule run failed");
    }
  }

  function scheduleNext(s: ScheduleDefinition, delay: number): void {
    if (closing) return;
    const timer = setTimeout(() => {
      const run = tick(s).finally(() => {
        inFlight.delete(s.name);
        scheduleNext(s, s.every);
      });
      inFlight.set(s.name, run);
    }, delay);
    // Never hold the process open just for a pending tick.
    timer.unref?.();
    timers.set(s.name, timer);
  }

  fastify.addHook("onReady", async () => {
    for (const s of schedules) {
      if (s.enabled === false) continue;
      stats.set(s.name, {
        name: s.name,
        runs: 0,
        failures: 0,
        skippedByLock: 0,
        lastRunAt: null,
        lastError: null,
      });
      const jitter = !s.runOnStart && s.jitterMs ? Math.floor(Math.random() * s.jitterMs) : 0;
      scheduleNext(s, s.runOnStart ? 0 : s.every + jitter);
    }
    if (stats.size > 0) {
      fastify.log.debug(
        `[arc-schedules] ${stats.size} schedule(s) armed${lock ? ` (leader-safe, holder ${holderId})` : ""}`,
      );
    }
  });

  fastify.addHook("onClose", async () => {
    closing = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    // Let in-flight runs settle so shutdown never truncates a sweep mid-write.
    await Promise.allSettled([...inFlight.values()]);
  });
};

export default fp(schedulesPlugin, {
  name: "arc-schedules",
  fastify: "5.x",
});

export { schedulesPlugin };
