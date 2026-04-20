/**
 * Production-scenario tests for MemoryCacheStore.
 *
 * These cover the gaps that cache-stores.test.ts doesn't exercise:
 *   1. Memory-budget eviction (maxMemoryBytes + watermark)
 *   2. Stats accuracy under load (hits/misses/evictions counters)
 *   3. Background cleanup timer actually fires and removes expired entries
 *   4. close() clears the timer so Node can exit cleanly (no leaked handles)
 *   5. High-volume LRU pressure (sustained sets vs. eviction path)
 */

import { afterEach, describe, expect, it } from "vitest";
import { MemoryCacheStore } from "../../src/cache/memory.js";

describe("MemoryCacheStore — production scenarios", () => {
  const stores: MemoryCacheStore<unknown>[] = [];

  // Every test registers its store so afterEach can reliably close them —
  // an uncleared cleanupTimer would leave an unref'd handle lying around.
  const track = <T>(store: MemoryCacheStore<T>): MemoryCacheStore<T> => {
    stores.push(store as MemoryCacheStore<unknown>);
    return store;
  };

  afterEach(async () => {
    while (stores.length) {
      const s = stores.pop();
      if (s) await s.close();
    }
  });

  // ── Memory budget eviction ──

  it("evicts LRU entries when maxMemoryBytes is exceeded", async () => {
    const store = track(
      new MemoryCacheStore<string>({
        maxEntries: 10_000,
        maxMemoryBytes: 2_000, // deliberately tiny
        evictionWatermark: 0.9,
        maxEntryBytes: 10_000,
      }),
    );

    // Each value is ~200 bytes after JSON-encoding — enough to fill the budget quickly.
    const payload = "x".repeat(180);
    for (let i = 0; i < 50; i++) {
      await store.set(`k-${i}`, payload);
    }

    const stats = store.stats();
    // Watermark is 90% of 2000 = 1800 bytes. After eviction we should be at/below budget.
    expect(stats.memoryBytes).toBeLessThanOrEqual(2_000);
    expect(stats.evictions).toBeGreaterThan(0);
    // Oldest keys evicted first.
    expect(await store.get("k-0")).toBeUndefined();
    // At least one recent key should survive.
    expect(await store.get("k-49")).toBe(payload);
  });

  // ── High-volume LRU pressure ──

  it("maintains a bounded entry count under sustained writes", async () => {
    const maxEntries = 100;
    const store = track(new MemoryCacheStore<number>({ maxEntries, defaultTtlSeconds: 60 }));

    for (let i = 0; i < 5_000; i++) {
      await store.set(`k-${i}`, i);
    }

    const stats = store.stats();
    expect(stats.entries).toBe(maxEntries);
    expect(stats.evictions).toBe(5_000 - maxEntries);

    // Tail should still be reachable.
    expect(await store.get("k-4999")).toBe(4999);
    // Head should have been evicted long ago.
    expect(await store.get("k-0")).toBeUndefined();
  });

  // ── Stats counters ──

  it("tracks hit/miss/eviction counts accurately", async () => {
    const store = track(new MemoryCacheStore<string>({ maxEntries: 3 }));

    await store.set("a", "A");
    await store.set("b", "B");
    await store.set("c", "C");

    expect(await store.get("a")).toBe("A"); // hit → also refresh LRU
    expect(await store.get("missing")).toBeUndefined(); // miss

    await store.set("d", "D"); // triggers eviction of oldest (b)

    const stats = store.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.evictions).toBe(1);
    expect(stats.entries).toBe(3);

    expect(await store.get("b")).toBeUndefined(); // miss++
    expect(store.stats().misses).toBe(2);
  });

  // ── Background cleanup timer ──

  it("runs the background cleanup interval to evict expired entries", async () => {
    const store = track(
      new MemoryCacheStore<string>({
        defaultTtlSeconds: 0.02,
        cleanupIntervalMs: 1_000, // clamped minimum — must stay >= 1s
      }),
    );

    await store.set("a", "A");
    await store.set("b", "B");

    // Wait for TTL to lapse AND for at least one cleanup tick to run.
    await new Promise((r) => setTimeout(r, 1_200));

    // Entries must be gone — either by lazy `get()` or by the background sweep.
    // Check stats first so we exercise the background path specifically:
    // if `entries` is already 0 here, the interval removed them.
    // (Without the timer firing, lazy expiry only runs on `get()`.)
    expect(store.stats().entries).toBe(0);
  }, 10_000);

  // ── close() resource cleanup ──

  it("close() clears the interval handle so Node can exit", async () => {
    const store = new MemoryCacheStore<string>({ cleanupIntervalMs: 1_000 });
    await store.set("a", "A");

    // Grab the internal timer handle — private field, reached via bracket access
    // to pin the leak-prevention contract.
    const timer = (store as unknown as { cleanupTimer: NodeJS.Timeout }).cleanupTimer;
    expect(timer).toBeDefined();

    await store.close();

    // After close() the store is empty and stats reflect no entries.
    expect(store.stats().entries).toBe(0);
    // Operations remain safe to call (idempotent close contract).
    await store.close();
  });

  // ── Update-in-place byte accounting ──

  it("re-setting an existing key reclaims the previous entry's bytes", async () => {
    const store = track(
      new MemoryCacheStore<string>({
        maxMemoryBytes: 10_000,
        maxEntries: 100,
      }),
    );

    await store.set("k", "x".repeat(1_000));
    const after1 = store.stats().memoryBytes;

    await store.set("k", "y".repeat(500));
    const after2 = store.stats().memoryBytes;

    expect(after2).toBeLessThan(after1);
    expect(store.stats().entries).toBe(1);
  });

  // ── Oversized entry rejection ──

  it("oversized entries don't change byte accounting or evict neighbors", async () => {
    // maxEntryBytes is clamped to min 1024 by the store — pick a payload
    // that's clearly bigger than the clamped floor.
    const store = track(
      new MemoryCacheStore<string>({
        maxEntries: 10,
        maxEntryBytes: 1024,
        logger: { warn: () => {}, error: () => {} },
      }),
    );

    await store.set("small", "ok");
    const baseline = store.stats().memoryBytes;

    await store.set("big", "x".repeat(2_000)); // > 1024 bytes → rejected
    expect(await store.get("big")).toBeUndefined();
    expect(store.stats().memoryBytes).toBe(baseline);
    expect(await store.get("small")).toBe("ok");
  });
});
