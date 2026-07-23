/**
 * Repeatable-schedule reconciliation — boot-time hygiene.
 *
 * BullMQ keys repeatable schedules by a hash of their repeat options, so
 * re-adding a job with a CHANGED pattern/every/tz/endDate creates a NEW
 * schedule while the old one keeps firing. This module reconciles at
 * plugin registration.
 */

import type { FastifyInstance } from "fastify";

/**
 * One repeatable schedule as reported by BullMQ. Covers both the modern
 * `getJobSchedulers()` shape (`JobSchedulerJson` — `every` is a number) and
 * the deprecated `getRepeatableJobs()` shape (`RepeatableJob` — `every` is a
 * string, fields nullable). Normalisation happens in {@link repeatSpecMatches}.
 */
interface RepeatScheduleRecord {
  key: string;
  name: string;
  pattern?: string | null;
  every?: number | string | null;
  tz?: string | null;
  endDate?: number | null;
}

/**
 * Feature-detected slice of a BullMQ Queue. The ambient `bullmq` declaration
 * in `src/optional-peers.d.ts` stays minimal on purpose — these methods are
 * probed at runtime so older BullMQ versions (and test mocks) degrade to a
 * no-op instead of crashing boot.
 */
interface RepeatScheduleQueue {
  getJobSchedulers?(): Promise<RepeatScheduleRecord[]>;
  getRepeatableJobs?(): Promise<RepeatScheduleRecord[]>;
  removeJobScheduler?(id: string): Promise<boolean>;
  removeRepeatableByKey?(key: string): Promise<boolean>;
}

/** The repeat options arc sends to `queue.add` — the comparison baseline. */
export interface RepeatSpec {
  pattern?: string;
  every?: number;
  tz?: string;
  endDate?: Date | string | number;
  limit?: number;
}

/**
 * Whether an existing schedule matches the currently configured repeat spec.
 *
 * BullMQ keys repeatable schedules by `name:jobId:endDate:tz:(pattern|every)`
 * — exactly these fields determine schedule identity, so they are exactly
 * what we compare. `limit` is intentionally NOT compared: it isn't part of
 * the key, so a changed limit upserts in place and never strands a stale
 * schedule.
 */
function repeatSpecMatches(record: RepeatScheduleRecord, spec: RepeatSpec): boolean {
  if ((record.pattern ?? undefined) !== spec.pattern) return false;
  // Legacy getRepeatableJobs() reports `every` as a string — normalise.
  const recordEvery = record.every == null ? undefined : Number(record.every);
  if (recordEvery !== spec.every) return false;
  if ((record.tz ?? undefined) !== spec.tz) return false;
  const recordEnd = record.endDate == null ? undefined : record.endDate;
  const specEnd = spec.endDate == null ? undefined : new Date(spec.endDate).getTime();
  if (recordEnd !== specEnd) return false;
  return true;
}

/**
 * Remove repeatable schedules left behind by a previous deploy whose repeat
 * spec no longer matches the current `JobDefinition.repeat`.
 *
 *   - Only schedulers whose `name` equals the registered job's name are
 *     candidates — foreign/unknown schedulers are never touched.
 *   - A scheduler matching the current spec is kept (the subsequent
 *     `queue.add` upserts it in place, preserving its timing state).
 *   - Fail-open: any error logs a warning and never blocks boot — this is
 *     boot-time hygiene, not a correctness gate.
 *
 * Uses the modern `getJobSchedulers()` / `removeJobScheduler()` API (BullMQ
 * 5.x job schedulers) and falls back to the deprecated `getRepeatableJobs()`
 * / `removeRepeatableByKey()` pair on older clients. When neither API exists
 * the step is skipped entirely.
 */
export async function removeStaleRepeatSchedulers(
  queue: unknown,
  jobName: string,
  spec: RepeatSpec,
  log: FastifyInstance["log"],
): Promise<void> {
  const q = queue as RepeatScheduleQueue;
  const list =
    typeof q.getJobSchedulers === "function"
      ? q.getJobSchedulers.bind(q)
      : typeof q.getRepeatableJobs === "function"
        ? q.getRepeatableJobs.bind(q)
        : null;
  const remove =
    typeof q.removeJobScheduler === "function"
      ? q.removeJobScheduler.bind(q)
      : typeof q.removeRepeatableByKey === "function"
        ? q.removeRepeatableByKey.bind(q)
        : null;
  if (!list || !remove) return;

  try {
    const existing = await list();
    for (const record of existing) {
      if (!record || record.name !== jobName) continue;
      if (repeatSpecMatches(record, spec)) continue;
      await remove(record.key);
      log.warn(
        {
          job: jobName,
          schedulerKey: record.key,
          stalePattern: record.pattern ?? undefined,
          staleEvery: record.every ?? undefined,
        },
        `[arc/jobs] Removed stale repeatable schedule for '${jobName}' — repeat config changed since last deploy`,
      );
    }
  } catch (err) {
    log.warn(
      { err, job: jobName },
      `[arc/jobs] Failed to reconcile repeatable schedules for '${jobName}' — continuing (boot-time hygiene only)`,
    );
  }
}
