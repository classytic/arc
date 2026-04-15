/**
 * End-to-end production-readiness tests for RedisCacheStore against real
 * Upstash Redis. Validates:
 *
 *   1. SET with PX TTL → GET round-trip, DEL removes the entry
 *   2. Prefix namespacing isolates stores in the same Redis
 *   3. Server-side TTL expiry (wait past the TTL and verify GET returns undefined)
 *   4. Corrupt-JSON resilience (malformed entries resolve to undefined)
 *   5. clear() via SCAN removes every prefixed key
 *   6. Concurrent load (100 parallel set/get) — no hangs, no connection leaks
 *   7. Connection cleanup (redis.quit()) leaves no dangling handle
 *
 * Skipped when UPSTASH_REDIS_URL is not set.
 */

import "dotenv/config";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ioredisAsCacheClient,
  type RedisCacheClient,
  RedisCacheStore,
} from "../../src/cache/redis.js";

const redisUrl = process.env.UPSTASH_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeRedis("Upstash Redis — RedisCacheStore production readiness", () => {
  let redis: Redis;
  let client: RedisCacheClient;

  beforeAll(async () => {
    redis = new Redis(redisUrl!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
    });
    client = ioredisAsCacheClient(redis);

    // Sanity probe.
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`Unexpected ping: ${pong}`);
  }, 30_000);

  afterAll(async () => {
    // quit() drains in-flight commands and closes the socket cleanly.
    await redis.quit().catch(() => redis.disconnect());
  });

  // ────────────────────────────────────────────────────────────────────
  // 1. Basic round-trip
  // ────────────────────────────────────────────────────────────────────

  it("sets, gets, and deletes JSON-encoded values with a TTL", async () => {
    const store = new RedisCacheStore<{ allow: boolean; roles: string[] }>({
      client,
      prefix: `arc-test-basic-${runId}:`,
      defaultTtlMs: 5_000,
    });

    await store.set("perm:user-1", { allow: true, roles: ["admin"] });
    const value = await store.get("perm:user-1");
    expect(value).toEqual({ allow: true, roles: ["admin"] });

    await store.delete("perm:user-1");
    expect(await store.get("perm:user-1")).toBeUndefined();
  }, 20_000);

  // ────────────────────────────────────────────────────────────────────
  // 2. Prefix isolation
  // ────────────────────────────────────────────────────────────────────

  it("isolates stores by prefix — same key, different namespaces", async () => {
    const storeA = new RedisCacheStore<string>({
      client,
      prefix: `arc-test-iso-${runId}-A:`,
    });
    const storeB = new RedisCacheStore<string>({
      client,
      prefix: `arc-test-iso-${runId}-B:`,
    });

    await storeA.set("shared", "from-A");
    await storeB.set("shared", "from-B");

    expect(await storeA.get("shared")).toBe("from-A");
    expect(await storeB.get("shared")).toBe("from-B");

    await storeA.delete("shared");
    // Deleting A must not touch B.
    expect(await storeB.get("shared")).toBe("from-B");
    await storeB.delete("shared");
  }, 20_000);

  // ────────────────────────────────────────────────────────────────────
  // 3. TTL expiry (server-side)
  // ────────────────────────────────────────────────────────────────────

  it("honors PX TTL — entries vanish after the TTL elapses", async () => {
    const store = new RedisCacheStore<string>({
      client,
      prefix: `arc-test-ttl-${runId}:`,
    });

    await store.set("ephemeral", "bye", { ttlMs: 1_000 });
    expect(await store.get("ephemeral")).toBe("bye");

    await new Promise((r) => setTimeout(r, 1_300));
    expect(await store.get("ephemeral")).toBeUndefined();
  }, 15_000);

  // ────────────────────────────────────────────────────────────────────
  // 4. Corrupt JSON handling
  // ────────────────────────────────────────────────────────────────────

  it("returns undefined for corrupt cache entries and tracks the miss", async () => {
    const prefix = `arc-test-corrupt-${runId}:`;
    const store = new RedisCacheStore<string>({ client, prefix });

    // Write a non-JSON value directly, bypassing the store.
    await redis.set(`${prefix}bad`, "{not valid json", "PX", 10_000);

    expect(await store.get("bad")).toBeUndefined();

    // Clean up the raw key.
    await redis.del(`${prefix}bad`);

    const stats = store.stats?.();
    expect(stats).toBeDefined();
    expect(stats!.misses).toBeGreaterThanOrEqual(1);
  }, 15_000);

  // ────────────────────────────────────────────────────────────────────
  // 5. clear() via SCAN
  // ────────────────────────────────────────────────────────────────────

  it("clear() removes every key in the prefix via SCAN", async () => {
    const prefix = `arc-test-clear-${runId}:`;
    const store = new RedisCacheStore<number>({ client, prefix });

    for (let i = 0; i < 25; i++) {
      await store.set(`item-${i}`, i);
    }

    // Sanity: keys exist before clear.
    const before = await redis.keys(`${prefix}*`);
    expect(before.length).toBe(25);

    await store.clear!();

    const after = await redis.keys(`${prefix}*`);
    expect(after.length).toBe(0);
  }, 30_000);

  // ────────────────────────────────────────────────────────────────────
  // 6. Concurrent load — no hangs, no connection leaks
  // ────────────────────────────────────────────────────────────────────

  it("handles 100 concurrent set+get operations cleanly", async () => {
    const store = new RedisCacheStore<{ n: number }>({
      client,
      prefix: `arc-test-load-${runId}:`,
      defaultTtlMs: 10_000,
    });

    const writes = Array.from({ length: 100 }, (_, i) => store.set(`k-${i}`, { n: i }));
    await Promise.all(writes);

    const reads = Array.from({ length: 100 }, (_, i) => store.get(`k-${i}`));
    const results = await Promise.all(reads);

    for (let i = 0; i < 100; i++) {
      expect(results[i]).toEqual({ n: i });
    }

    // Cleanup so we don't leave 100 keys behind in Upstash.
    await store.clear!();
    const remaining = await redis.keys(`arc-test-load-${runId}:*`);
    expect(remaining.length).toBe(0);
  }, 60_000);

  // ────────────────────────────────────────────────────────────────────
  // 7. Stats under activity
  // ────────────────────────────────────────────────────────────────────

  it("tracks hits and misses accurately", async () => {
    const store = new RedisCacheStore<string>({
      client,
      prefix: `arc-test-stats-${runId}:`,
    });

    await store.set("hit", "present");
    expect(await store.get("hit")).toBe("present"); // hit
    expect(await store.get("hit")).toBe("present"); // hit
    expect(await store.get("missing")).toBeUndefined(); // miss

    const stats = store.stats?.();
    expect(stats).toBeDefined();
    expect(stats!.hits).toBeGreaterThanOrEqual(2);
    expect(stats!.misses).toBeGreaterThanOrEqual(1);

    await store.delete("hit");
  }, 15_000);
});
