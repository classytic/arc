/**
 * In-memory `LockAdapter` double with real lease semantics: same-holder
 * tryAcquire extends (the contract's renewal capability), other-holder
 * acquisition fails until the lease lapses, and every call is recorded for
 * cadence/serialization assertions.
 */

export class FakeLockAdapter {
  readonly calls: Array<{ op: "tryAcquire" | "release"; name: string; holderId: string }> = [];
  private readonly leases = new Map<string, { holderId: string; expiresAt: number }>();
  /** Artificial per-call latency — exercise slow-backend serialization. */
  latencyMs = 0;
  /** Force the next tryAcquire to return false (simulated ownership loss). */
  failNextAcquire = false;

  async tryAcquire(name: string, holderId: string, leaseMs: number): Promise<boolean> {
    this.calls.push({ op: "tryAcquire", name, holderId });
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.failNextAcquire) {
      this.failNextAcquire = false;
      return false;
    }
    const now = Date.now();
    const lease = this.leases.get(name);
    if (lease && lease.holderId !== holderId && lease.expiresAt > now) return false;
    this.leases.set(name, { holderId, expiresAt: now + leaseMs });
    return true;
  }

  async release(name: string, holderId: string): Promise<boolean> {
    this.calls.push({ op: "release", name, holderId });
    const lease = this.leases.get(name);
    if (!lease || lease.holderId !== holderId) return false;
    this.leases.delete(name);
    return true;
  }

  holder(name: string): string | undefined {
    const lease = this.leases.get(name);
    return lease && lease.expiresAt > Date.now() ? lease.holderId : undefined;
  }

  acquireCount(name?: string): number {
    return this.calls.filter((c) => c.op === "tryAcquire" && (!name || c.name === name)).length;
  }
}
