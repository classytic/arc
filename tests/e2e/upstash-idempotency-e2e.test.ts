/**
 * End-to-end test for RedisIdempotencyStore against real Upstash Redis.
 *
 * Validates the full idempotency contract: lock → set response → get →
 * unlock, plus TTL expiry, atomic unlock, cross-prefix cleanup, and
 * corrupt-entry resilience. This is the guarantee a Fastify service needs
 * when replaying responses for retried mutations.
 *
 *   1. tryLock → set → get round-trip
 *   2. tryLock is atomic (second lock attempt fails while held)
 *   3. unlock only releases the holder's lock (TOCTOU-safe)
 *   4. TTL expiry drops stored results server-side
 *   5. delete() cleans both result + lock keys
 *   6. deleteByPrefix() scans and removes every matching key
 *   7. findByPrefix() returns the freshest matching result
 *   8. Corrupt JSON resolves to undefined without throwing
 *
 * Skipped when UPSTASH_REDIS_URL is not set.
 */

import "dotenv/config";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ioredisAsIdempotencyClient,
  type RedisClient,
  RedisIdempotencyStore,
} from "../../src/idempotency/stores/redis.js";

const redisUrl = process.env.UPSTASH_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeRedis("Upstash Redis — RedisIdempotencyStore end-to-end", () => {
  let redis: Redis;
  let client: RedisClient;
  let store: RedisIdempotencyStore;

  beforeAll(async () => {
    redis = new Redis(redisUrl!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
    });
    client = ioredisAsIdempotencyClient(redis);
    store = new RedisIdempotencyStore({
      client,
      prefix: `arc-test-idem-${runId}:`,
      lockPrefix: `arc-test-idem-lock-${runId}:`,
      ttlMs: 60_000,
    });

    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`Unexpected ping: ${pong}`);
  }, 30_000);

  afterAll(async () => {
    // Best-effort cleanup of any keys we left behind.
    const keys = await redis.keys(`arc-test-idem*-${runId}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit().catch(() => redis.disconnect());
  });

  // ────────────────────────────────────────────────────────────────────
  // 1. Happy path: lock → set → get → unlock
  // ────────────────────────────────────────────────────────────────────

  it("locks, stores a response envelope, and retrieves it by key", async () => {
    const key = "POST:/orders:req-1";
    const locked = await store.tryLock(key, "req-1", 10_000);
    expect(locked).toBe(true);

    const now = new Date();
    await store.set(key, {
      statusCode: 201,
      headers: { "content-type": "application/json" },
      body: { orderId: "o-1" },
      createdAt: now,
      expiresAt: new Date(now.getTime() + 30_000),
    });

    const result = await store.get(key);
    expect(result).toBeDefined();
    expect(result!.statusCode).toBe(201);
    expect(result!.body).toEqual({ orderId: "o-1" });
    expect(result!.headers["content-type"]).toBe("application/json");

    await store.unlock(key, "req-1");
    expect(await store.isLocked(key)).toBe(false);

    await store.delete(key);
  }, 15_000);

  // ────────────────────────────────────────────────────────────────────
  // 2. Atomic lock contention
  // ────────────────────────────────────────────────────────────────────

  it("tryLock is atomic — a second acquirer fails while the first holds it", async () => {
    const key = "POST:/payments:req-2";

    const a = await store.tryLock(key, "worker-a", 10_000);
    const b = await store.tryLock(key, "worker-b", 10_000);

    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(await store.isLocked(key)).toBe(true);

    await store.unlock(key, "worker-a");
    expect(await store.isLocked(key)).toBe(false);

    // After release, another worker can acquire.
    const c = await store.tryLock(key, "worker-c", 10_000);
    expect(c).toBe(true);
    await store.unlock(key, "worker-c");
  }, 15_000);

  // ────────────────────────────────────────────────────────────────────
  // 3. unlock TOCTOU safety
  // ────────────────────────────────────────────────────────────────────

  it("unlock() only releases if the caller is the current holder", async () => {
    const key = "POST:/transfers:req-3";
    await store.tryLock(key, "holder", 10_000);

    // A different requestId must NOT release the lock.
    await store.unlock(key, "imposter");
    expect(await store.isLocked(key)).toBe(true);

    // The real holder can still release.
    await store.unlock(key, "holder");
    expect(await store.isLocked(key)).toBe(false);
  }, 15_000);

  // ────────────────────────────────────────────────────────────────────
  // 4. TTL expiry (server-side)
  // ────────────────────────────────────────────────────────────────────

  it("honors TTL — stored results vanish after expiresAt", async () => {
    const key = "POST:/expiring:req-4";
    const now = new Date();
    await store.set(key, {
      statusCode: 200,
      headers: {},
      body: { ok: true },
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1_000), // 1-second TTL
    });

    expect(await store.get(key)).toBeDefined();
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await store.get(key)).toBeUndefined();
  }, 10_000);

  // ────────────────────────────────────────────────────────────────────
  // 5. delete() removes both result and lock keys
  // ────────────────────────────────────────────────────────────────────

  it("delete() removes both the result and lock for a key", async () => {
    const key = "POST:/cleanup:req-5";
    await store.tryLock(key, "req-5", 10_000);
    await store.set(key, {
      statusCode: 200,
      headers: {},
      body: { ok: true },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10_000),
    });

    await store.delete(key);
    expect(await store.get(key)).toBeUndefined();
    expect(await store.isLocked(key)).toBe(false);
  }, 15_000);

  // ────────────────────────────────────────────────────────────────────
  // 6. deleteByPrefix / findByPrefix
  // ────────────────────────────────────────────────────────────────────

  it("deleteByPrefix() removes every matching result and lock via SCAN", async () => {
    for (let i = 0; i < 5; i++) {
      await store.set(`POST:/bulk:${i}`, {
        statusCode: 200,
        headers: {},
        body: { n: i },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
      });
    }

    const deleted = await store.deleteByPrefix("POST:/bulk:");
    expect(deleted).toBeGreaterThanOrEqual(5);

    // Every bulk key is gone.
    for (let i = 0; i < 5; i++) {
      expect(await store.get(`POST:/bulk:${i}`)).toBeUndefined();
    }
  }, 30_000);

  it("findByPrefix() returns the first unexpired result matching a prefix", async () => {
    await store.set("POST:/find:a", {
      statusCode: 200,
      headers: {},
      body: { which: "a" },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10_000),
    });

    const found = await store.findByPrefix("POST:/find:");
    expect(found).toBeDefined();
    expect((found!.body as { which: string }).which).toBe("a");

    await store.deleteByPrefix("POST:/find:");
  }, 15_000);

  // ────────────────────────────────────────────────────────────────────
  // 7. Corrupt entry resilience
  // ────────────────────────────────────────────────────────────────────

  it("returns undefined for a corrupt cached entry and doesn't throw", async () => {
    const key = "POST:/corrupt:req-7";
    // Write invalid JSON directly, bypassing the store.
    await redis.set(`arc-test-idem-${runId}:${key}`, "{not json", "EX", 30);

    await expect(store.get(key)).resolves.toBeUndefined();

    await redis.del(`arc-test-idem-${runId}:${key}`);
  }, 10_000);
});
