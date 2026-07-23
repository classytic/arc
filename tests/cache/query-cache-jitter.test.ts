/**
 * Wave-12 performance: opt-in freshness jitter in QueryCache.
 *
 * `jitter` (0–1, default 0 = off) varies each write's effective staleTime
 * by ±(jitter × staleTime) so entries cached together don't all go stale
 * in the same instant (synchronized revalidation burst). Single-flight in
 * BaseCrudController handles same-key stampedes; jitter de-synchronizes
 * ACROSS keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCacheStore } from "../../src/cache/memory.js";
import { QueryCache } from "../../src/cache/QueryCache.js";

describe("QueryCache — freshness jitter", () => {
  let store: MemoryCacheStore;
  let cache: QueryCache;

  beforeEach(() => {
    store = new MemoryCacheStore({ defaultTtlSeconds: 300 });
    cache = new QueryCache(store);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
  });

  it("default (no jitter) keeps staleTime exact and never consults Math.random", async () => {
    const random = vi.spyOn(Math, "random");
    const now = Date.now();
    let currentTime = now;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    await cache.set("key", "data", { staleTime: 100, gcTime: 60 });
    expect(random).not.toHaveBeenCalled();

    currentTime = now + 99_000;
    expect((await cache.get("key")).status).toBe("fresh");
    currentTime = now + 101_000;
    expect((await cache.get("key")).status).toBe("stale");
  });

  it("jitter widens staleTime up to +(jitter × staleTime) at random=1", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // factor = 1 + 0.5 = 1.5
    const now = Date.now();
    let currentTime = now;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    await cache.set("key", "data", { staleTime: 100, gcTime: 600, jitter: 0.5 });

    currentTime = now + 149_000; // < 150s effective staleTime
    expect((await cache.get("key")).status).toBe("fresh");
    currentTime = now + 151_000;
    expect((await cache.get("key")).status).toBe("stale");
  });

  it("jitter narrows staleTime down to -(jitter × staleTime) at random=0", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // factor = 1 - 0.5 = 0.5
    const now = Date.now();
    let currentTime = now;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    await cache.set("key", "data", { staleTime: 100, gcTime: 600, jitter: 0.5 });

    currentTime = now + 49_000; // < 50s effective staleTime
    expect((await cache.get("key")).status).toBe("fresh");
    currentTime = now + 51_000;
    expect((await cache.get("key")).status).toBe("stale");
  });

  it("effective staleTime is clamped at 0 (jitter=1, random=0 → immediately stale)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // factor = 1 - 1 = 0
    await cache.set("key", "data", { staleTime: 100, gcTime: 600, jitter: 1 });

    const result = await cache.get("key");
    expect(result.status).toBe("stale");
    expect(result.data).toBe("data"); // still served within the SWR window
  });
});
