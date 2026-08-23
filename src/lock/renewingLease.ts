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
 *  - Enforcement on loss — a fence TOKEN is surfaced (`lease.token`) for
 *    downstream stores to reject a stale ex-holder's writes, but arc does not
 *    reject on its behalf: only the store holding the data can do that.
 *
 * ## Fencing (`tryAcquireFenced`)
 *
 * When the adapter implements it, renewal goes through `tryAcquireFenced` and
 * the lease watches the TOKEN, which closes a hole plain renewal cannot see.
 * `tryAcquire` means "free OR mine": if another holder takes the lock and their
 * lease EXPIRES before our next renewal, our renewal succeeds and `lost` stays
 * false — we believe we held it continuously while someone else ran. The token
 * changes on every change of holder (an extension by the same holder keeps
 * it), so a token we did not start with means our epoch ended, whether or not
 * the interloper still holds the lock.
 *
 * Adapters without the method are unchanged: `lost` still means "another holder
 * owns it right now", and `token` stays undefined. Feature-detected, never
 * required — the delivery-guarantees matrix documents which stores fence.
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
  /**
   * Fence token from the caller's own fenced acquire, when it made one.
   *
   * Acquisition policy stays with the caller (skip-on-contention for
   * schedules, throw for migrations), so the token has to come in rather than
   * be minted here. Omit it and the lease renews unfenced.
   */
  token?: number;
  /**
   * Fired ONCE when ownership is lost — a renewal returning `false`, or (when
   * fenced) a renewal whose token differs from the one we started with.
   */
  onLost?: () => void;
  /** Fired per renewal transport error (the lease may lapse mid-run). */
  onError?: (error: unknown) => void;
}

export interface RenewingLease {
  /** True once ownership was observed to be lost — see `onLost`. */
  readonly lost: boolean;
  /**
   * Current fence token, or `undefined` when the adapter does not fence.
   *
   * Hand it to stores that accept one so they can reject writes from a stale
   * ex-holder. It is read per use, not captured: a token read once and reused
   * is the stale value this exists to detect.
   */
  readonly token: number | undefined;
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
  // Fence only when the adapter can AND the caller acquired fenced. A token
  // here with an unfenced acquire would compare against nothing meaningful.
  const fenced = typeof lock.tryAcquireFenced === "function" && options.token !== undefined;

  let stopped = false;
  let lost = false;
  let token: number | undefined = options.token;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      const renew = fenced
        ? Promise.resolve(lock.tryAcquireFenced?.(name, holderId, leaseMs)).then((result) => {
            if (result === null || result === undefined) return false;
            // A DIFFERENT token means the holder changed and we re-took it:
            // our original epoch ended, and anything written under it is
            // stale even though we hold the lock again now.
            if (result.token !== token) {
              token = result.token;
              return false;
            }
            return true;
          })
        : Promise.resolve(lock.tryAcquire(name, holderId, leaseMs));

      inFlight = renew
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
    get token() {
      return token;
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
