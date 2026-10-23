/**
 * Daily gate — "once per LOCAL calendar day, at/after a wall-clock time in an IANA zone".
 *
 * The decision is a civil date (`civilDateOf`, from `@classytic/primitives/timezone`), never a
 * UTC timestamp, so DST and zone offsets cannot skip or double a day. The claim lives in a
 * host-implemented {@link DailyLedger}: a restart or a second replica finds the day already
 * claimed. `schedulesPlugin` drives it through `ScheduleDefinition.daily`; it is exported for
 * hosts that tick from somewhere else.
 */

import {
  type CivilDate,
  civilDateOf,
  civilDateToInstant,
  isValidTimeZone,
  localTimeParts,
} from "@classytic/primitives/timezone";

/** What a claim carries so a ledger can implement stale-claim recovery. */
export interface DailyClaimInfo {
  /** The gate's clock reading when the claim was attempted. */
  readonly now: Date;
  /** Set when the gate was given `staleAfterMs`: an uncompleted claim older than this may be re-granted. */
  readonly staleAfterMs?: number;
}

/**
 * Idempotency ledger the HOST implements (one row per `(key, civilDate)`).
 *
 * `claimDay` MUST be atomic across replicas (unique key / `INSERT ... ON CONFLICT DO NOTHING`):
 * exactly one concurrent caller gets `true`. Reclaiming is the only exception, and only for a claim
 * that was never completed and is older than `info.staleAfterMs`.
 */
export interface DailyLedger {
  claimDay(key: string, civilDate: string, info: DailyClaimInfo): Promise<boolean>;
  /** The run finished: keep the claim permanently (stale recovery never applies) and store `result`. */
  completeDay?(key: string, civilDate: string, result?: Record<string, unknown>): Promise<void>;
  /** The run failed: drop the claim so the next tick retries. */
  releaseDay(key: string, civilDate: string): Promise<void>;
}

export type DailyClock = (() => Date) | { now(): Date };

export interface DailyGateOptions {
  /** Ledger key: one per job (the schedule name under `schedulesPlugin`). */
  key: string;
  ledger: DailyLedger;
  /** IANA zone the day and the time are read in. */
  zone: string;
  /** Local hour 0-23. */
  hour: number;
  /** Local minute 0-59 (default 0). */
  minute?: number;
  /**
   * Latest lateness (ms after the scheduled time) at which a missed run still fires. Default:
   * unlimited, i.e. until the local day rolls over. Set it to skip a day the process slept through.
   */
  catchUpWindowMs?: number;
  /** Re-grant an uncompleted claim older than this (crash mid-run). Default: never. */
  staleAfterMs?: number;
  /** Injectable clock (tests). Default: `new Date()`. */
  clock?: DailyClock;
}

export type DailyRunOutcome<T> =
  | { readonly ran: true; readonly day: string; readonly result: T }
  | { readonly ran: false; readonly reason: "too-early" | "outside-window" | "already-claimed" };

export interface DailyGate {
  /** Run `task(civilDate)` if today's slot is open and claimable. A throwing task releases the claim and rethrows. */
  run<T>(task: (day: string) => Promise<T> | T): Promise<DailyRunOutcome<T>>;
}

/** Boot-time validation of the time-of-day fields; throws a `TypeError` naming `label`. */
export function assertDailyTime(
  label: string,
  o: { hour: number; minute?: number; zone: string },
): void {
  if (!Number.isInteger(o.hour) || o.hour < 0 || o.hour > 23) {
    throw new TypeError(`${label}: \`hour\` must be an integer 0-23`);
  }
  if (o.minute !== undefined && (!Number.isInteger(o.minute) || o.minute < 0 || o.minute > 59)) {
    throw new TypeError(`${label}: \`minute\` must be an integer 0-59`);
  }
  if (typeof o.zone !== "string" || !isValidTimeZone(o.zone)) {
    throw new TypeError(
      `${label}: \`zone\` must be a valid IANA time zone (got "${String(o.zone)}")`,
    );
  }
}

/**
 * The first instant on `day` at which the zone's wall clock reads at/after `target` minutes.
 * A repeated wall time (fall back) resolves to its first occurrence. A time inside a
 * spring-forward gap resolves to the instant the clock jumps past it: primitives'
 * `civilDateToInstant` returns an instant an hour EARLY there, so it is verified, not trusted.
 */
function scheduledInstant(day: CivilDate, zone: string, target: number): Date {
  let at = civilDateToInstant(day, zone, { hour: Math.floor(target / 60), minute: target % 60 });
  if (civilDateOf(at, zone) === day && localTimeParts(at, zone).minutesOfDay >= target) return at;
  for (let step = 0; step < 24 * 60; step++) {
    at = new Date(at.getTime() + 60_000);
    if (civilDateOf(at, zone) !== day) break;
    if (localTimeParts(at, zone).minutesOfDay >= target) return at;
  }
  return at;
}

export function createDailyGate(opts: DailyGateOptions): DailyGate {
  assertDailyTime(`[arc-daily] "${opts.key}"`, opts);
  const { key, ledger, zone, hour, minute = 0, catchUpWindowMs, staleAfterMs } = opts;
  const read = (): Date =>
    typeof opts.clock === "function" ? opts.clock() : (opts.clock?.now() ?? new Date());

  return {
    async run(task) {
      const now = read();
      const day = civilDateOf(now, zone);
      const scheduledAt = scheduledInstant(day, zone, hour * 60 + minute);
      const lateness = now.getTime() - scheduledAt.getTime();
      if (lateness < 0) return { ran: false, reason: "too-early" };
      if (catchUpWindowMs !== undefined && lateness > catchUpWindowMs) {
        return { ran: false, reason: "outside-window" };
      }
      const won = await ledger.claimDay(key, day, {
        now,
        ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
      });
      if (!won) return { ran: false, reason: "already-claimed" };
      let result: Awaited<ReturnType<typeof task>>;
      try {
        result = await task(day);
      } catch (err) {
        // The original failure wins; a ledger that cannot release leaves the claim to staleAfterMs.
        await ledger.releaseDay(key, day).catch(() => undefined);
        throw err;
      }
      if (ledger.completeDay) {
        await ledger.completeDay(
          key,
          day,
          typeof result === "object" && result !== null
            ? Object.fromEntries(Object.entries(result))
            : undefined,
        );
      }
      return { ran: true, day, result };
    },
  };
}

/** In-memory ledger for tests and single-process dev. Not shared across processes. */
export interface MemoryDailyLedger extends DailyLedger {
  /** Snapshot of every claim, for assertions. */
  claims(): ReadonlyArray<{
    key: string;
    civilDate: string;
    claimedAt: Date;
    completed: boolean;
    result?: Record<string, unknown>;
  }>;
}

export function createMemoryDailyLedger(): MemoryDailyLedger {
  const rows = new Map<
    string,
    {
      key: string;
      civilDate: string;
      claimedAt: Date;
      completed: boolean;
      result?: Record<string, unknown>;
    }
  >();
  const id = (key: string, civilDate: string): string => `${key}\u0000${civilDate}`;
  return {
    async claimDay(key, civilDate, info) {
      const existing = rows.get(id(key, civilDate));
      if (existing) {
        const stale =
          !existing.completed &&
          info.staleAfterMs !== undefined &&
          info.now.getTime() - existing.claimedAt.getTime() > info.staleAfterMs;
        if (!stale) return false;
      }
      rows.set(id(key, civilDate), { key, civilDate, claimedAt: info.now, completed: false });
      return true;
    },
    async completeDay(key, civilDate, result) {
      const row = rows.get(id(key, civilDate));
      if (!row) return;
      row.completed = true;
      if (result) row.result = result;
    },
    async releaseDay(key, civilDate) {
      rows.delete(id(key, civilDate));
    },
    claims: () => [...rows.values()].map((r) => ({ ...r })),
  };
}
