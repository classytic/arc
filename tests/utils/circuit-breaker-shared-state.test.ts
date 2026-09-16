/**
 * Cluster-wide failure counting for `CircuitBreaker`.
 *
 * The problem it solves: per-replica counting means a downstream outage costs
 * `failureThreshold × replicas` real requests before anything opens. At 5 and
 * 50 that is 250 errors a failing payment gateway absorbs while every pod
 * independently rediscovers the same outage.
 *
 * What it does NOT do is share the state machine — each replica still owns its
 * own OPEN/HALF_OPEN transitions. The tests below pin exactly that boundary,
 * because the value of the feature is in what it converges and the safety of it
 * is in what it leaves alone.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  type CircuitBreakerSharedState,
  CircuitState,
} from "../../src/utils/circuitBreaker.js";
import { RedisCircuitBreakerState } from "../../src/utils/circuitBreakerRedis.js";

const flush = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

/** One shared counter standing in for Redis, shared by every "replica". */
function sharedCounter(): CircuitBreakerSharedState & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    name: "test",
    counts,
    async recordFailure(circuit) {
      const next = (counts.get(circuit) ?? 0) + 1;
      counts.set(circuit, next);
      return next;
    },
    async reset(circuit) {
      counts.delete(circuit);
    },
  };
}

const failing = () => Promise.reject(new Error("downstream down"));

/** A replica of the same logical circuit. */
const replica = (shared: CircuitBreakerSharedState, threshold = 5) =>
  new CircuitBreaker(failing, {
    name: "payments",
    failureThreshold: threshold,
    sharedState: shared,
    timeout: 1000,
  });

describe("CircuitBreaker — sharedState", () => {
  it("requires an explicit name — the key every replica counts under", () => {
    // Without it each replica counts under its own generated id: the exact
    // per-replica counting this exists to end, plus a round trip.
    expect(() => new CircuitBreaker(failing, { sharedState: sharedCounter() })).toThrow(
      /requires an explicit `name`/,
    );
  });

  it("a fleet trips after ONE failure each once the cluster window is over the line", async () => {
    const shared = sharedCounter();
    const replicas = Array.from({ length: 6 }, () => replica(shared));

    // Replica 0 absorbs the whole threshold on its own, as it would alone.
    for (let i = 0; i < 5; i++) await replicas[0]?.call().catch(() => {});
    await flush();
    expect(replicas[0]?.getStats().state).toBe(CircuitState.OPEN);

    // Every other replica now trips on its FIRST failure — the shared window
    // already exceeds the threshold. Per-replica counting would have cost five
    // more real requests each, 25 in total, against a downstream already known
    // to be down.
    for (const r of replicas.slice(1)) await r.call().catch(() => {});
    await flush();

    for (const r of replicas) expect(r.getStats().state).toBe(CircuitState.OPEN);
    // 5 from replica 0 + 1 from each of the other five.
    expect(shared.counts.get("payments")).toBe(10);
  });

  it("without sharedState every replica pays the full threshold — the behaviour being fixed", async () => {
    const replicas = Array.from({ length: 3 }, () =>
      new CircuitBreaker(failing, { name: "payments", failureThreshold: 5, timeout: 1000 }),
    );
    for (const r of replicas) await r.call().catch(() => {});
    await flush();
    // One failure each leaves all three CLOSED — they will each absorb five.
    for (const r of replicas) expect(r.getStats().state).toBe(CircuitState.CLOSED);
  });

  it("publishes EVERY failure, including from a replica that already tripped", async () => {
    // A tripped replica still has to contribute, or a fleet where one pod
    // takes the traffic would stop informing the others.
    const shared = sharedCounter();
    const recordFailure = vi.spyOn(shared, "recordFailure");
    const r = replica(shared, 2);

    await r.call().catch(() => {});
    await r.call().catch(() => {});
    await flush();
    expect(r.getStats().state).toBe(CircuitState.OPEN);

    expect(recordFailure).toHaveBeenCalledTimes(2);
  });

  it("does NOT touch the network on the success path", async () => {
    const shared = sharedCounter();
    const recordFailure = vi.spyOn(shared, "recordFailure");
    const reset = vi.spyOn(shared, "reset");
    const ok = new CircuitBreaker(async () => "fine", {
      name: "payments",
      sharedState: shared,
    });

    for (let i = 0; i < 20; i++) await ok.call();
    await flush();

    // Success is the common case and this wraps things like a charge.
    expect(recordFailure).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("a store that throws degrades to local counting instead of failing the call", async () => {
    // A breaker that stops protecting because its bookkeeping store blinked is
    // worse than one that counts per replica — and those two outages tend to
    // arrive together.
    const broken: CircuitBreakerSharedState = {
      name: "broken",
      recordFailure: async () => {
        throw new Error("READONLY You can't write against a read only replica.");
      },
      reset: async () => {
        throw new Error("READONLY");
      },
    };
    const r = replica(broken, 3);

    // The caller still sees the downstream error, not a Redis one.
    await expect(r.call()).rejects.toThrow(/downstream down/);
    await r.call().catch(() => {});
    await r.call().catch(() => {});
    await flush();

    // Local counting still tripped it at the threshold.
    expect(r.getStats().state).toBe(CircuitState.OPEN);
  });

  it("the failure path does not WAIT on the store", async () => {
    // A hung counter store must not hang the error returning to the caller.
    let release = (): void => {};
    const hanging: CircuitBreakerSharedState = {
      name: "hanging",
      recordFailure: () => new Promise<number>((r) => (release = () => r(1))),
      reset: async () => {},
    };
    const r = replica(hanging, 5);

    await expect(r.call()).rejects.toThrow(/downstream down/);
    release();
  });
});

describe("RedisCircuitBreakerState", () => {
  function mockRedis() {
    const keys = new Map<string, number>();
    const expires: Array<{ key: string; ms: number }> = [];
    return {
      keys,
      expires,
      async incr(key: string) {
        const next = (keys.get(key) ?? 0) + 1;
        keys.set(key, next);
        return next;
      },
      async pexpire(key: string, ms: number) {
        expires.push({ key, ms });
        return 1;
      },
      async del(...k: string[]) {
        let n = 0;
        for (const key of k) if (keys.delete(key)) n++;
        return n;
      },
    };
  }

  it("counts per circuit under the prefix and returns the cluster count", async () => {
    const redis = mockRedis();
    const state = new RedisCircuitBreakerState({ redis });

    expect(await state.recordFailure("payments")).toBe(1);
    expect(await state.recordFailure("payments")).toBe(2);
    expect(await state.recordFailure("search")).toBe(1);

    expect([...redis.keys.keys()].sort()).toEqual(["arc:circuit:payments", "arc:circuit:search"]);
  });

  it("sets the expiry ONLY on the increment that created the key", async () => {
    // Refreshing it on every failure turns the fixed window into one that never
    // expires under sustained load — the count would keep climbing from an
    // outage that ended hours ago.
    const redis = mockRedis();
    const state = new RedisCircuitBreakerState({ redis, windowMs: 30_000 });

    await state.recordFailure("payments");
    await state.recordFailure("payments");
    await state.recordFailure("payments");

    expect(redis.expires).toEqual([{ key: "arc:circuit:payments", ms: 30_000 }]);
  });

  it("reset clears the window", async () => {
    const redis = mockRedis();
    const state = new RedisCircuitBreakerState({ redis });
    await state.recordFailure("payments");
    await state.reset("payments");
    expect(redis.keys.has("arc:circuit:payments")).toBe(false);
    expect(await state.recordFailure("payments")).toBe(1);
  });

  it.each([0, -1, Number.NaN])("REFUSES windowMs: %s at construction", (windowMs) => {
    // PEXPIRE with a non-positive TTL deletes the key immediately, so the count
    // would reset on every failure and the circuit could never trip
    // cluster-wide — protection silently disabled.
    expect(() => new RedisCircuitBreakerState({ redis: mockRedis(), windowMs })).toThrow(
      /positive number/,
    );
  });

  it("drives a real breaker end to end", async () => {
    const redis = mockRedis();
    const shared = new RedisCircuitBreakerState({ redis });
    const a = replica(shared, 3);
    const b = replica(shared, 3);

    await a.call().catch(() => {});
    await a.call().catch(() => {});
    await a.call().catch(() => {});
    await flush();
    expect(a.getStats().state).toBe(CircuitState.OPEN);

    await b.call().catch(() => {});
    await flush();
    expect(b.getStats().state).toBe(CircuitState.OPEN);
  });
});
