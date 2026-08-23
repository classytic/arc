/**
 * A renewing lease detects a holder CHANGE, not just a holder conflict.
 *
 * `LockAdapter.tryAcquire` means "free OR mine". That makes one loss invisible:
 * if another holder takes the lock and their lease EXPIRES before our next
 * renewal, our renewal finds the lock free, succeeds, and `lost` stays false —
 * we believe we held it continuously while someone else ran a tick or applied
 * a migration step. Serialized renewal narrows that window; it cannot close it,
 * because nothing in the boolean answer records that ownership moved.
 *
 * `tryAcquireFenced` closes it. The token changes on every CHANGE of holder
 * (an extension by the same holder keeps it), so a token we did not start with
 * means our epoch ended — whether or not the interloper still holds the lock.
 *
 * Fencing is feature-detected: adapters without the method keep the previous
 * behaviour exactly, which the last test pins.
 */

import { describe, expect, it, vi } from "vitest";
import { startRenewingLease } from "../../src/lock/renewingLease.js";
import { waitFor } from "../../src/testing/mocks.js";

/**
 * Wait for RENEWALS, never for a duration.
 *
 * A fixed sleep here encodes a guess about the timer firing under whatever
 * load the pool is carrying — it passed alone and failed inside the full
 * suite, which is the failure arc's own testing standard names: "a fixed delay
 * encodes a scheduling guess and fails on a different file each run."
 */
const renewals = (lock: { tryAcquireFenced?: { mock: { calls: unknown[] } } }) =>
  lock.tryAcquireFenced?.mock.calls.length ?? 0;

/**
 * A fenced adapter whose token we drive by hand — the point is the SEQUENCE of
 * tokens a renewal observes, not a real clock.
 */
function fencedLock(tokens: number[]) {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    lock: {
      tryAcquire: vi.fn(async () => {
        calls.push("tryAcquire");
        return true;
      }),
      tryAcquireFenced: vi.fn(async () => {
        calls.push("tryAcquireFenced");
        const token = tokens[Math.min(i, tokens.length - 1)];
        i++;
        return token === null || token === undefined ? null : { token };
      }),
      release: vi.fn(async () => true),
    } as never,
  };
}

describe("renewing lease — fencing", () => {
  it("a CHANGED token is treated as loss, even though the lock was re-acquired", async () => {
    // The invisible case. Renewal succeeds — the lock is ours again — but the
    // token moved, so someone else held it in between.
    const onLost = vi.fn();
    const { lock } = fencedLock([1, 2]);

    const lease = startRenewingLease({
      lock,
      name: "job",
      holderId: "h1",
      leaseMs: 100,
      renewEveryMs: 10,
      token: 1,
      onLost,
    });

    await waitFor(() => onLost.mock.calls.length > 0, { label: "lease loss on token change" });
    await lease.stop();

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(lease.lost).toBe(true);
  });

  it("an UNCHANGED token is an ordinary extension — no loss", async () => {
    // The inverse control. Same holder extending must not look like a change,
    // or every renewal would report a false loss.
    const onLost = vi.fn();
    const { lock } = fencedLock([7, 7, 7]);

    const lease = startRenewingLease({
      lock,
      name: "job",
      holderId: "h1",
      leaseMs: 100,
      renewEveryMs: 10,
      token: 7,
      onLost,
    });

    // Wait for renewals to actually HAPPEN, then assert none reported loss —
    // asserting a negative after a sleep proves only that time passed.
    await waitFor(() => renewals(lock as never) >= 2, { label: "2 fenced renewals" });
    await lease.stop();

    expect(onLost).not.toHaveBeenCalled();
    expect(lease.lost).toBe(false);
  });

  it("exposes the CURRENT token, so a stale one is never handed downstream", async () => {
    const { lock } = fencedLock([3, 9]);
    const lease = startRenewingLease({
      lock,
      name: "job",
      holderId: "h1",
      leaseMs: 100,
      renewEveryMs: 10,
      token: 3,
    });

    expect(lease.token).toBe(3);
    await waitFor(() => lease.token === 9, { label: "token advances to the new epoch" });
    await lease.stop();

    // Read per use, not captured at construction — a store handed `3` after
    // the epoch moved would accept writes the fence exists to reject.
    expect(lease.token).toBe(9);
  });

  it("a null token (lock genuinely taken) is loss, as before", async () => {
    const onLost = vi.fn();
    const { lock } = fencedLock([1, null as unknown as number]);

    const lease = startRenewingLease({
      lock,
      name: "job",
      holderId: "h1",
      leaseMs: 100,
      renewEveryMs: 10,
      token: 1,
      onLost,
    });

    await waitFor(() => onLost.mock.calls.length > 0, { label: "lease loss on null token" });
    await lease.stop();

    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("renews via tryAcquireFenced when fencing is active", async () => {
    const { lock, calls } = fencedLock([5, 5]);
    const lease = startRenewingLease({
      lock,
      name: "job",
      holderId: "h1",
      leaseMs: 100,
      renewEveryMs: 10,
      token: 5,
    });

    await waitFor(() => calls.length > 0, { label: "one renewal" });
    await lease.stop();

    expect(calls).toContain("tryAcquireFenced");
    expect(calls).not.toContain("tryAcquire");
  });
});

describe("renewing lease — unfenced adapters are unchanged", () => {
  /** No `tryAcquireFenced` at all — the pre-existing contract. */
  function plainLock(results: boolean[]) {
    let i = 0;
    return {
      tryAcquire: vi.fn(async () => results[Math.min(i++, results.length - 1)] ?? true),
      release: vi.fn(async () => true),
    } as never;
  }

  it("a false renewal is still loss", async () => {
    const onLost = vi.fn();
    const lease = startRenewingLease({
      lock: plainLock([false]),
      name: "job",
      holderId: "h1",
      leaseMs: 100,
      renewEveryMs: 10,
      onLost,
    });

    await waitFor(() => onLost.mock.calls.length > 0, { label: "unfenced lease loss" });
    await lease.stop();

    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("token stays undefined — nothing to hand downstream", async () => {
    const lease = startRenewingLease({
      lock: plainLock([true]),
      name: "job",
      holderId: "h1",
      leaseMs: 100,
      renewEveryMs: 10,
    });

    expect(lease.token).toBeUndefined();
    await lease.stop();
  });

  it("a token WITHOUT a fenced adapter does not enable fencing", async () => {
    // Guards the feature-detection: comparing a caller-supplied token against
    // an adapter that cannot mint one would compare against nothing.
    const lock = plainLock([true, true]);
    const lease = startRenewingLease({
      lock,
      name: "job",
      holderId: "h1",
      leaseMs: 100,
      renewEveryMs: 10,
      token: 42,
    });

    const plain = lock as unknown as { tryAcquire: { mock: { calls: unknown[] } } };
    await waitFor(() => plain.tryAcquire.mock.calls.length >= 1, { label: "one plain renewal" });
    await lease.stop();

    expect(lease.lost).toBe(false);
    expect(
      (lock as unknown as { tryAcquire: ReturnType<typeof vi.fn> }).tryAcquire,
    ).toHaveBeenCalled();
  });
});
