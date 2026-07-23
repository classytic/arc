/**
 * Live Redis contract test — arc's `RedisCacheStore` against a REAL server.
 *
 * Runs only when `REDIS_URL` is set (loaded from `.env` when present, see
 * `.env.example`); skipped otherwise so CI without Redis stays green:
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npx vitest run tests/contract/redis-live.test.ts
 *
 * Verifies the semantics the fakes can only model:
 *  - `increment` is atomic INCRBY with TTL-ON-CREATE via the Lua
 *    `expireIfAbsent` (an existing counter's TTL is never replaced —
 *    asserted with a real server-side TTL read);
 *  - the ioredis adapter's eval wiring actually runs on the server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ioredisAsCacheClient, RedisCacheStore } from "../../src/cache/redis.js";

try {
  process.loadEnvFile?.(new URL("../../.env", import.meta.url).pathname.replace(/^\//, ""));
} catch {
  /* no .env — rely on the process environment */
}

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)("RedisCacheStore against live Redis", () => {
  // biome-ignore lint/suspicious/noExplicitAny: ioredis is a devDep loaded lazily so the suite can skip without it
  let redis: any;
  let store: RedisCacheStore;
  const PREFIX = `arc-test:${process.pid}:`;

  beforeAll(async () => {
    const { default: Redis } = await import("ioredis");
    redis = new Redis(REDIS_URL as string, { lazyConnect: true });
    await redis.connect();
    store = new RedisCacheStore({ client: ioredisAsCacheClient(redis), prefix: PREFIX });
  });

  afterAll(async () => {
    if (!redis) return;
    const keys = await redis.keys(`${PREFIX}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it("get/set round-trips with TTL", async () => {
    await store.set("kv", { hello: "redis" }, 30);
    expect(await store.get("kv")).toEqual({ hello: "redis" });
    expect(await redis.ttl(`${PREFIX}kv`)).toBeGreaterThan(0);
  });

  it("increment is atomic and returns the running total", async () => {
    expect(await store.increment("counter", 1, 60)).toBe(1);
    expect(await store.increment("counter", 5, 60)).toBe(6);
    expect(await redis.get(`${PREFIX}counter`)).toBe("6");
  });

  it("TTL applies on CREATE only — an existing counter keeps its expiry", async () => {
    await store.increment("nx", 1, 60);
    const ttlAfterCreate = await redis.ttl(`${PREFIX}nx`);
    expect(ttlAfterCreate).toBeGreaterThan(0);
    expect(ttlAfterCreate).toBeLessThanOrEqual(60);

    await store.increment("nx", 1, 9999); // must NOT replace the 60s TTL
    const ttlAfterIncrement = await redis.ttl(`${PREFIX}nx`);
    expect(ttlAfterIncrement).toBeLessThanOrEqual(60);
  });

  it("a counter at 0 keeps its TTL (the INCRBY-return edge case, on real Redis)", async () => {
    await store.increment("zero", 5, 60);
    await redis.set(`${PREFIX}zero`, "0", "KEEPTTL");
    await store.increment("zero", 5, 9999);
    const ttl = await redis.ttl(`${PREFIX}zero`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("concurrent increments never lose a bump", async () => {
    await Promise.all(Array.from({ length: 50 }, () => store.increment("race", 1, 60)));
    expect(await redis.get(`${PREFIX}race`)).toBe("50");
  });
});
