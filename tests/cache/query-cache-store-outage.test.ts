/**
 * `QueryCache` over a shared store that fails (Redis down): reads go to the source, nothing throws, and no
 * entry cached before the outage is served past an invalidation made during it.
 *
 * Before: every store error propagated, so a cached route (and any host reading tag versions, such as a
 * settings reader) answered 500 for as long as Redis was down.
 */
import { describe, expect, it, vi } from "vitest";
import type { CacheStore } from "../../src/cache/interface.js";
import { MemoryCacheStore } from "../../src/cache/memory.js";
import { QueryCache } from "../../src/cache/QueryCache.js";

/** A memory store that throws on every call while `down`. */
function flaky() {
  const inner = new MemoryCacheStore();
  const state = { down: false };
  const guard = () => {
    if (state.down) throw new Error("Stream isn't writeable");
  };
  const store = {
    get: async (k: string) => (guard(), inner.get(k)),
    set: async (k: string, v: unknown, ttl?: number) => (guard(), inner.set(k, v, ttl)),
    delete: async (k: string) => (guard(), inner.delete(k)),
    increment: async (k: string, by?: number, ttl?: number) => (guard(), inner.increment(k, by, ttl)),
  } as unknown as CacheStore;
  return { store, state };
}

const config = { staleTime: 60, gcTime: 60 };

describe("QueryCache with its store down", () => {
  it("reads miss, writes are skipped, versions read 0; one report per outage", async () => {
    const { store, state } = flaky();
    const onStoreError = vi.fn();
    const qc = new QueryCache(store, { onStoreError });
    state.down = true;
    await expect(qc.get("k")).resolves.toMatchObject({ status: "miss" });
    await expect(qc.set("k", { a: 1 }, config)).resolves.toBeUndefined();
    await expect(qc.getTagVersion("settings")).resolves.toBe(0);
    await expect(qc.getResourceVersion("order")).resolves.toBe(0);
    expect(onStoreError).toHaveBeenCalledTimes(1);
    expect(qc.degraded).toBe(true);
    state.down = false;
    await qc.set("k", { a: 1 }, config);
    await expect(qc.get("k")).resolves.toMatchObject({ status: "fresh", data: { a: 1 } });
    expect(qc.degraded).toBe(false);
  });

  it("a version bump refused during the outage is replayed before any version is read again", async () => {
    const { store, state } = flaky();
    const qc = new QueryCache(store);
    await qc.bumpTagVersion("settings");
    expect(await qc.getTagVersion("settings")).toBe(1);
    state.down = true;
    await qc.bumpTagVersion("settings"); // an edit while Redis is down
    state.down = false;
    // Recovered: the stale version 1 is never answered (entries cached under it stay orphaned).
    expect(await qc.getTagVersion("settings")).toBe(2);
  });

  it("an entry whose invalidation was refused reads as a miss, then is deleted on recovery", async () => {
    const { store, state } = flaky();
    const qc = new QueryCache(store);
    await qc.set("list:a", ["old"], config);
    state.down = true;
    await qc.invalidate("list:a");
    state.down = false;
    await expect(qc.get("list:a")).resolves.toMatchObject({ status: "miss" });
    expect(await store.get("list:a")).toBeUndefined();
    expect(qc.degraded).toBe(false);
  });
});
