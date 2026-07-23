/**
 * Cache contract — arc's stores against the repo-core `CacheAdapter`
 * contract, and `QueryCache`'s version-bump semantics on top of it.
 *
 * Invariants pinned here:
 *  1. A bare repo-core adapter plugs into arc castless (`CacheStore extends
 *     CacheAdapter` — drift is a compile error) and behaves identically to
 *     arc's own stores.
 *  2. `increment(key, by?, ttlSeconds?)` applies TTL ON CREATE only — an
 *     existing counter keeps its original expiry (NX semantics). Redis
 *     delegates this atomically via `expireIfAbsent`; a client that can't
 *     honor the complete contract falls back to read-modify-write.
 *  3. QueryCache version bumps are strictly monotonic: atomic via
 *     `increment` where available; `max(now, current + 1)` fallback
 *     otherwise (same-ms bumps and clock regressions still advance).
 */

import { type CacheAdapter, createMemoryCacheAdapter } from "@classytic/repo-core/cache";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheStore } from "../../src/cache/interface.js";
import { MemoryCacheStore } from "../../src/cache/memory.js";
import { QueryCache } from "../../src/cache/QueryCache.js";
import { RedisCacheStore } from "../../src/cache/redis.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Plain store WITHOUT increment — exercises the fallback path. */
function plainStore(): CacheStore & { data: Map<string, unknown>; ttls: Map<string, number> } {
  const data = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    data,
    ttls,
    get: (key) => data.get(key),
    set: (key, value, ttlSeconds) => {
      data.set(key, value);
      if (ttlSeconds !== undefined) ttls.set(key, ttlSeconds);
    },
    delete: (key) => {
      data.delete(key);
    },
  };
}

// ============================================================================
// repo-core adapter conformance
// ============================================================================

describe("repo-core CacheAdapter conformance", () => {
  it("a bare repo-core CacheAdapter assigns to arc's CacheStore (type-level)", () => {
    const adapter = createMemoryCacheAdapter();
    const store: CacheStore = adapter; // compile-time assertion: no cast
    expect(store).toBe(adapter);
  });

  it("QueryCache version bumps increment by 1 on a repo-core adapter", async () => {
    const adapter: CacheAdapter = createMemoryCacheAdapter();
    const cache = new QueryCache(adapter); // no cast — assignability is the contract

    await cache.bumpResourceVersion("product");
    expect(await cache.getResourceVersion("product")).toBe(1);
    await cache.bumpResourceVersion("product");
    expect(await cache.getResourceVersion("product")).toBe(2);
    await cache.bumpTagVersion("catalog");
    expect(await cache.getTagVersion("catalog")).toBe(1);
  });

  it("QueryCache get/set round-trips through a repo-core adapter", async () => {
    const cache = new QueryCache(createMemoryCacheAdapter());

    await cache.set("k1", { hello: "world" }, { staleTime: 60, gcTime: 60 });
    const hit = await cache.get<{ hello: string }>("k1");
    expect(hit.status).toBe("fresh");
    expect(hit.data).toEqual({ hello: "world" });
  });
});

// ============================================================================
// increment TTL-on-create (NX) semantics
// ============================================================================

describe("MemoryCacheStore.increment — TTL on create only", () => {
  it("keeps the original expiry when incrementing an existing counter", async () => {
    vi.useFakeTimers();
    const store = new MemoryCacheStore();

    store.increment("k", 1, 10); // created with 10s TTL
    vi.advanceTimersByTime(8_000);
    store.increment("k", 1, 10); // must NOT reset the clock to +10s

    // 8s + 3s = 11s > original 10s TTL — the counter must be gone. Under
    // refresh-on-every-increment it would still be live.
    vi.advanceTimersByTime(3_000);
    expect(await store.get("k")).toBeUndefined();
    await store.close();
  });

  it("expired counters restart at `by` with a fresh TTL", async () => {
    vi.useFakeTimers();
    const store = new MemoryCacheStore();

    store.increment("k", 5, 10);
    vi.advanceTimersByTime(11_000);
    expect(store.increment("k", 5, 10)).toBe(5); // restarted, not 10
    await store.close();
  });

  it("matches repo-core's reference memory adapter behavior", async () => {
    vi.useFakeTimers();
    const reference = createMemoryCacheAdapter();
    const arc = new MemoryCacheStore();

    for (const store of [reference, arc]) {
      await store.increment?.("k", 1, 10);
      vi.advanceTimersByTime(8_000);
      await store.increment?.("k", 1, 10);
      vi.advanceTimersByTime(3_000);
    }
    expect(await arc.get("k")).toBe(await reference.get("k")); // both expired
    await arc.close();
  });
});

describe("RedisCacheStore.increment — atomic NX expiry via expireIfAbsent", () => {
  function fakeClient() {
    const counters = new Map<string, number>();
    const ttls = new Map<string, number>();
    const setCalls: string[] = [];
    return {
      counters,
      ttls,
      setCalls,
      get: async (key: string) => {
        const v = counters.get(key);
        return v === undefined ? null : String(v);
      },
      set: async (key: string) => {
        setCalls.push(key);
        return null;
      },
      del: async () => 0,
      incrBy: async (key: string, by: number) => {
        const next = (counters.get(key) ?? 0) + by;
        counters.set(key, next);
        return next;
      },
      // Models the server-side Lua/EXPIRE-NX: only stamps when no TTL exists.
      expireIfAbsent: async (key: string, seconds: number) => {
        if (!ttls.has(key)) ttls.set(key, seconds);
        return 1;
      },
    };
  }

  it("delegates NX semantics to the server — existing TTLs are never replaced", async () => {
    const client = fakeClient();
    const store = new RedisCacheStore({ client, prefix: "t:" });

    await store.increment("counter", 1, 60);
    await store.increment("counter", 1, 999); // must not overwrite the 60s TTL
    expect(client.ttls.get("t:counter")).toBe(60);
  });

  it("a counter sitting at 0 keeps its TTL (INCRBY-return inference is unsound)", async () => {
    const client = fakeClient();
    const store = new RedisCacheStore({ client, prefix: "t:" });

    await store.increment("n", 5, 60); // created, value 5, TTL 60
    client.counters.set("t:n", 0); // decayed back to 0 (e.g. decrement elsewhere)
    // Inferring "created" from `next === by` would REPLACE the TTL here.
    await store.increment("n", 5, 999);
    expect(client.ttls.get("t:n")).toBe(60);
  });

  it("without expireIfAbsent, a TTL'd increment refuses the half-atomic path (RMW fallback)", async () => {
    const client = fakeClient();
    const bare = {
      get: client.get,
      set: client.set,
      del: client.del,
      incrBy: client.incrBy,
    };
    const store = new RedisCacheStore({ client: bare, prefix: "t:" });

    await store.increment("n", 1, 60);
    // Fallback went through set() (read-modify-write), NOT incrBy-without-TTL.
    expect(client.setCalls).toEqual(["t:n"]);
  });

  it("increments by arbitrary amounts", async () => {
    const client = fakeClient();
    const store = new RedisCacheStore({ client, prefix: "t:" });
    expect(await store.increment("n", 5, 60)).toBe(5);
    expect(await store.increment("n", 2, 60)).toBe(7);
  });
});

// ============================================================================
// QueryCache version-bump monotonicity
// ============================================================================

describe("QueryCache version bump — fallback (no increment)", () => {
  it("same-millisecond double bump still produces distinct versions", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now); // freeze the clock
    const cache = new QueryCache(plainStore());

    await cache.bumpResourceVersion("product");
    const v1 = await cache.getResourceVersion("product");
    await cache.bumpResourceVersion("product");
    const v2 = await cache.getResourceVersion("product");

    expect(v2).toBeGreaterThan(v1);
  });

  it("clock regression cannot move the version backwards", async () => {
    const store = plainStore();
    const cache = new QueryCache(store);

    await cache.bumpResourceVersion("product");
    const v1 = await cache.getResourceVersion("product");

    vi.spyOn(Date, "now").mockReturnValue(1); // clock jumps to the past
    await cache.bumpResourceVersion("product");
    const v2 = await cache.getResourceVersion("product");

    expect(v2).toBeGreaterThan(v1);
  });

  it("stores version keys with an effectively-non-expiring TTL (1 year)", async () => {
    const store = plainStore();
    const cache = new QueryCache(store);
    await cache.bumpResourceVersion("product");
    await cache.bumpTagVersion("catalog");

    for (const ttl of store.ttls.values()) {
      expect(ttl).toBe(365 * 24 * 60 * 60);
    }
    expect(store.ttls.size).toBe(2);
  });
});

describe("QueryCache version bump — increment stores", () => {
  it("uses store.increment with the canonical (key, by, ttl) signature", async () => {
    const store = plainStore() as CacheStore & { increment: ReturnType<typeof vi.fn> };
    let counter = 0;
    store.increment = vi.fn(() => ++counter);
    const cache = new QueryCache(store);

    await cache.bumpResourceVersion("product");
    await cache.bumpResourceVersion("product");

    expect(store.increment).toHaveBeenCalledTimes(2);
    // (key, by, ttlSeconds) — repo-core CacheAdapter argument order.
    expect(store.increment).toHaveBeenCalledWith("arc:ver:product", 1, 365 * 24 * 60 * 60);
  });

  it("MemoryCacheStore.increment is strictly monotonic and synchronous", async () => {
    const store = new MemoryCacheStore();
    expect(store.increment("k", 1, 60)).toBe(1);
    expect(store.increment("k", 1, 60)).toBe(2);
    expect(store.increment("k", 5, 60)).toBe(7);
    expect(await store.get("k")).toBe(7);
    await store.close();
  });

  it("QueryCache on MemoryCacheStore yields sequential versions", async () => {
    const store = new MemoryCacheStore();
    const cache = new QueryCache(store);

    await cache.bumpResourceVersion("product");
    await cache.bumpResourceVersion("product");
    await cache.bumpResourceVersion("product");

    expect(await cache.getResourceVersion("product")).toBe(3);
    await store.close();
  });
});
