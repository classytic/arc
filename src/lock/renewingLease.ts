/**
 * Renewable lease over the ecosystem `LockAdapter` contract.
 *
 * One canonical implementation of "hold a distributed lease while long work
 * runs" — used by the schedules plugin and the migration runner (previously
 * two hand-rolled copies). Candidate for promotion into
 * `@classytic/repo-core/lock` once the API settles; arc keeps it internal
 * until then.
 *
 * Guarantees:
 *  - **Serialized renewals** — the next renewal is scheduled only after the
 *    previous one settles, so a lock backend slower than the cadence never
 *    sees overlapping `tryAcquire` calls.
 *  - **Awaited teardown** — `stop()` cancels the pending timer AND awaits
 *    an in-flight renewal, so a late renewal cannot extend the lease after
 *    the work already settled.
 *  - **Loss is observable** — a renewal returning `false` (another holder
 *    took the lock) sets `lost` and fires `onLost` exactly once. Callers
 *    decide the response: schedules log and let the idempotent handler
 *    finish; migrations refuse to start further steps and fail the run.
 *
 * Deliberately NOT in the helper (policy stays with the caller):
 *  - Acquisition — skip-on-contention (schedules) vs throw (migrations).
 *  - Release vs let-lapse after the work — holding the lease to natural
 *    expiry is what makes schedule tick-windows exclusive.
 *  - Enforcement on loss — renewal alone cannot stop a stale holder from
 *    writing; true fencing needs a token from the lock contract.
 */

import type { LockAdapter } from "@classytic/repo-core/lock";

export interface RenewingLeaseOptions {
  lock: LockAdapter;
  /** Lock name — the same value passed to the caller's own `tryAcquire`. */
  name: string;
  holderId: string;
  /** Lease duration re-asserted on every renewal. */
  leaseMs: number;
  /** Renewal cadence (default: `max(10, leaseMs / 2)`). */
  renewEveryMs?: number;
  /** Fired ONCE when a renewal returns `false` — ownership lost. */
  onLost?: () => void;
  /** Fired per renewal transport error (the lease may lapse mid-run). */
  onError?: (error: unknown) => void;
}

export interface RenewingLease {
  /** True once a renewal observed another holder owning the lock. */
  readonly lost: boolean;
  /** Stop scheduling and await the in-flight renewal. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Start renewing an ALREADY-ACQUIRED lease. The caller performed the
 * initial `tryAcquire` (its contention policy differs per consumer); this
 * keeps the lease alive until `stop()`.
 */
export function startRenewingLease(options: RenewingLeaseOptions): RenewingLease {
  const { lock, name, holderId, leaseMs, onLost, onError } = options;
  const renewEveryMs = options.renewEveryMs ?? Math.max(10, Math.floor(leaseMs / 2));

  let stopped = false;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = Promise.resolve(lock.tryAcquire(name, holderId, leaseMs))
        .then((renewed) => {
          if (!renewed && !lost) {
            lost = true;
            onLost?.();
          }
        })
        .catch((error) => {
          onError?.(error);
        })
        .finally(() => {
          inFlight = undefined;
          scheduleNext();
        });
    }, renewEveryMs);
    timer.unref?.();
  };
  scheduleNext();

  return {
    get lost() {
      return lost;
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
