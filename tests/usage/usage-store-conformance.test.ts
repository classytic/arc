/**
 * Every `UsageStore` arc ships, against the CANONICAL contract suite.
 *
 * `runUsageStoreContract` lives in `@classytic/repo-core/testing` and is the
 * same suite `@classytic/mongokit/usage` runs. That is the point: "swap the
 * memory store for Redis, or for a kit's" has to be a provable claim, not a
 * hopeful one, because the swap is exactly what `runtime: 'distributed'`
 * demands of every host that hits the `usage.store` violation. Hand-writing
 * per-store assertions here would let arc's stores drift from the ecosystem's
 * definition of the contract while every local test stayed green.
 *
 * The memory store had no conformance run at all before this.
 */

import { runUsageStoreContract } from "@classytic/repo-core/testing";
import { describe, expect, it, vi } from "vitest";
import { MemoryUsageStore } from "../../src/usage/stores/memory.js";
import { RedisUsageStore, type UsageRedisLike } from "../../src/usage/stores/redis.js";

// ---------------------------------------------------------------------------
// Mock Redis — hashes in a Map. `hincrby` has no await before it mutates, so
// it is atomic under the contract's concurrency case for the same reason the
// real server's is: nothing interleaves.
// ---------------------------------------------------------------------------

interface MockRedis extends UsageRedisLike {
  _hashes: Map<string, Map<string, number>>;
  _expires: Array<{ key: string; seconds: number }>;
}

function createMockRedis(opts: { withPipeline?: boolean } = {}): MockRedis {
  const hashes = new Map<string, Map<string, number>>();
  const expires: Array<{ key: string; seconds: number }> = [];

  const hincrby = (key: string, field: string, increment: number): number => {
    const hash = hashes.get(key) ?? new Map<string, number>();
    const next = (hash.get(field) ?? 0) + increment;
    hash.set(field, next);
    hashes.set(key, hash);
    return next;
  };
  const expire = (key: string, seconds: number): number => {
    expires.push({ key, seconds });
    return 1;
  };

  const redis: MockRedis = {
    _hashes: hashes,
    _expires: expires,
    async hincrby(key, field, increment) {
      return hincrby(key, field, increment);
    },
    async hgetall(key) {
      const hash = hashes.get(key);
      if (!hash) return {};
      return Object.fromEntries([...hash].map(([f, v]) => [f, String(v)]));
    },
    async expire(key, seconds) {
      return expire(key, seconds);
    },
  };

  if (opts.withPipeline) {
    redis.pipeline = () => {
      const queued: Array<() => void> = [];
      const chain = {
        hincrby(key: string, field: string, increment: number) {
          queued.push(() => void hincrby(key, field, increment));
          return chain;
        },
        expire(key: string, seconds: number) {
          queued.push(() => void expire(key, seconds));
          return chain;
        },
        async exec() {
          for (const run of queued) run();
          return [];
        },
      };
      return chain;
    };
  }

  return redis;
}

// ---------------------------------------------------------------------------
// The contract, once per store shape arc can hand a host.
// ---------------------------------------------------------------------------

describe("MemoryUsageStore", () => {
  const store = new MemoryUsageStore();
  runUsageStoreContract({
    createStore: () => store,
    beforeEach: () => store.clear(),
  });
});

describe("RedisUsageStore — no retention", () => {
  let redis = createMockRedis();
  runUsageStoreContract({
    createStore: () => {
      redis = createMockRedis();
      return new RedisUsageStore({ redis });
    },
  });
});

describe("RedisUsageStore — retention via pipeline", () => {
  runUsageStoreContract({
    createStore: () =>
      new RedisUsageStore({
        redis: createMockRedis({ withPipeline: true }),
        retentionSeconds: 3600,
      }),
  });
});

describe("RedisUsageStore — retention without pipeline support", () => {
  // A minimal wrapper that never implements `pipeline()` must still satisfy
  // the contract; only the round-trip count differs.
  runUsageStoreContract({
    createStore: () =>
      new RedisUsageStore({ redis: createMockRedis(), retentionSeconds: 3600 }),
  });
});

// ---------------------------------------------------------------------------
// Behaviour the shared contract cannot express — it is Redis-specific.
// ---------------------------------------------------------------------------

describe("RedisUsageStore — Redis specifics", () => {
  it("uses one hash per (actor, period), one field per kind", async () => {
    const redis = createMockRedis();
    const store = new RedisUsageStore({ redis });

    await store.increment({ actor: "org-42", period: "2026-07", kind: "api.requests" }, 3);
    await store.increment({ actor: "org-42", period: "2026-07", kind: "ai.tokens.input" }, 9);

    expect([...redis._hashes.keys()]).toEqual(["arc:usage:org-42:2026-07"]);
    expect(Object.fromEntries(redis._hashes.get("arc:usage:org-42:2026-07") ?? [])).toEqual({
      "api.requests": 3,
      "ai.tokens.input": 9,
    });
  });

  it("honours a custom prefix", async () => {
    const redis = createMockRedis();
    const store = new RedisUsageStore({ redis, prefix: "acme:meter:" });
    await store.increment({ actor: "a", period: "2026-07", kind: "k" }, 1);
    expect([...redis._hashes.keys()]).toEqual(["acme:meter:a:2026-07"]);
  });

  it("writes NO expiry when retention is omitted — counters are billing history", async () => {
    const redis = createMockRedis();
    const store = new RedisUsageStore({ redis });
    await store.increment({ actor: "a", period: "2026-07", kind: "k" }, 1);
    expect(redis._expires).toEqual([]);
  });

  it("REFRESHES the TTL on every write, not just the first", async () => {
    // A monthly bucket is written all month. A TTL set once at creation would
    // expire the bucket while it is still being counted into — the failure
    // mode is a quota that silently resets mid-period.
    const redis = createMockRedis();
    const store = new RedisUsageStore({ redis, retentionSeconds: 600 });

    await store.increment({ actor: "a", period: "2026-07", kind: "k" }, 1);
    await store.increment({ actor: "a", period: "2026-07", kind: "k" }, 1);
    await store.increment({ actor: "a", period: "2026-07", kind: "k" }, 1);

    expect(redis._expires).toEqual([
      { key: "arc:usage:a:2026-07", seconds: 600 },
      { key: "arc:usage:a:2026-07", seconds: 600 },
      { key: "arc:usage:a:2026-07", seconds: 600 },
    ]);
  });

  it("uses ONE round trip for a retention write when pipeline() exists", async () => {
    const redis = createMockRedis({ withPipeline: true });
    const hincrby = vi.spyOn(redis, "hincrby");
    const expire = vi.spyOn(redis, "expire");
    const store = new RedisUsageStore({ redis, retentionSeconds: 600 });

    await store.increment({ actor: "a", period: "2026-07", kind: "k" }, 1);

    // Both commands went through the pipeline, so neither direct method ran.
    expect(hincrby).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    expect(redis._expires).toHaveLength(1);
    expect(await store.summary("a", "2026-07")).toEqual({ k: 1 });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "REFUSES retentionSeconds: %s at construction",
    (retentionSeconds) => {
      // Redis treats a non-positive TTL as "delete now". Constructing happily
      // and discarding every counter written is the worst available outcome,
      // because `summary()` answers `{}` for an expired bucket and a
      // never-written one alike — the loss reads as "no usage yet".
      expect(
        () => new RedisUsageStore({ redis: createMockRedis(), retentionSeconds }),
      ).toThrow(/positive number/);
    },
  );

  it("skips a non-numeric field rather than reporting NaN into a quota", async () => {
    const redis = createMockRedis();
    redis._hashes.set(
      "arc:usage:a:2026-07",
      new Map([["k", 5]]) as unknown as Map<string, number>,
    );
    // Something else wrote a string into this hash.
    (redis._hashes.get("arc:usage:a:2026-07") as Map<string, unknown>).set("junk", "not-a-number");

    const store = new RedisUsageStore({ redis });
    const summary = await store.summary("a", "2026-07");

    // `NaN > limit` is `false`, so a NaN here would silently stop the quota
    // from ever tripping — strictly worse than the counter being absent.
    expect(summary).toEqual({ k: 5 });
    expect(Object.values(summary).every(Number.isFinite)).toBe(true);
  });
});
