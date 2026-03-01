/**
 * QueryCache SWR (Stale-While-Revalidate) Tests
 *
 * Validates freshness transitions: FRESH → STALE → MISS
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryCache } from '../../src/cache/QueryCache.js';
import { MemoryCacheStore } from '../../src/cache/memory.js';

describe('QueryCache SWR Behavior', () => {
  let store: MemoryCacheStore;
  let cache: QueryCache;

  beforeEach(() => {
    store = new MemoryCacheStore({ defaultTtlMs: 300_000 });
    cache = new QueryCache(store);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
  });

  it('should transition FRESH → STALE → MISS over time', async () => {
    const now = Date.now();
    let currentTime = now;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    // Set with staleTime=10s, gcTime=20s (total=30s)
    await cache.set('key', 'data', { staleTime: 10, gcTime: 20 });

    // T+0: FRESH
    const r1 = await cache.get('key');
    expect(r1.status).toBe('fresh');

    // T+5s: still FRESH
    currentTime = now + 5_000;
    const r2 = await cache.get('key');
    expect(r2.status).toBe('fresh');

    // T+11s: STALE (past staleTime=10s, before staleTime+gcTime=30s)
    currentTime = now + 11_000;
    const r3 = await cache.get('key');
    expect(r3.status).toBe('stale');
    expect(r3.data).toBe('data'); // data still returned

    // T+25s: still STALE
    currentTime = now + 25_000;
    const r4 = await cache.get('key');
    expect(r4.status).toBe('stale');

    // T+31s: MISS (past staleTime+gcTime=30s)
    currentTime = now + 31_000;
    const r5 = await cache.get('key');
    expect(r5.status).toBe('miss');
  });

  it('should support staleTime=0 (immediately stale, SWR only)', async () => {
    await cache.set('key', 'data', { staleTime: 0, gcTime: 60 });
    const result = await cache.get('key');
    expect(result.status).toBe('stale');
    expect(result.data).toBe('data');
  });

  it('should support large staleTime (long freshness)', async () => {
    const now = Date.now();
    let currentTime = now;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    await cache.set('key', 'data', { staleTime: 3600, gcTime: 60 }); // 1h fresh

    // T+30min: still FRESH
    currentTime = now + 30 * 60 * 1000;
    const result = await cache.get('key');
    expect(result.status).toBe('fresh');
  });

  it('should delete expired entries on get', async () => {
    const now = Date.now();
    let currentTime = now;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    await cache.set('key', 'data', { staleTime: 30, gcTime: 60 });

    // Advance past total lifetime (30 + 60 = 90s)
    currentTime = now + 100_000;
    const result = await cache.get('key');
    expect(result.status).toBe('miss');

    // Entry should be deleted from store
    const raw = await store.get('key');
    expect(raw).toBeUndefined();
  });

  it('should handle cache.set overwrite correctly', async () => {
    await cache.set('key', 'old', { staleTime: 30, gcTime: 60 });
    await cache.set('key', 'new', { staleTime: 30, gcTime: 60 });

    const result = await cache.get<string>('key');
    expect(result.status).toBe('fresh');
    expect(result.data).toBe('new');
  });

  it('should handle concurrent gets on same stale key', async () => {
    const now = Date.now();
    let currentTime = now;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    await cache.set('key', 'data', { staleTime: 30, gcTime: 60 });

    // Advance past staleTime (30s) but before total lifetime (90s)
    currentTime = now + 35_000;
    const [r1, r2] = await Promise.all([
      cache.get('key'),
      cache.get('key'),
    ]);

    expect(r1.status).toBe('stale');
    expect(r2.status).toBe('stale');
    expect(r1.data).toBe('data');
    expect(r2.data).toBe('data');
  });
});
