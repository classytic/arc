/**
 * RedisIdempotencyStore — mock-based tests
 *
 * Uses a simulated Redis client (in-memory Map) to test:
 * 1. tryLock: first request succeeds, second conflicts
 * 2. tryLock: NX semantics (SET only if not exists)
 * 3. unlock: atomic Lua-based check-and-delete (via eval)
 * 4. unlock: wrong requestId does NOT release lock
 * 5. unlock: fallback path when eval unavailable
 * 6. set/get lifecycle
 * 7. isLocked, delete, deleteByPrefix, findByPrefix
 * 8. TTL expiry (mock clock)
 * 9. TOCTOU race: concurrent unlock cannot steal another worker's lock
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedisIdempotencyStore, type RedisClient } from "../../src/idempotency/stores/redis.js";

// ============================================================================
// Mock Redis Client — simulates ioredis SET NX EX, GET, DEL, EVAL
// ============================================================================

interface MockEntry {
  value: string;
  expiresAt: number;
}

function createMockRedis(): RedisClient & {
  eval: (script: string, numkeys: number, ...args: (string | number)[]) => Promise<unknown>;
  _store: Map<string, MockEntry>;
} {
  const store = new Map<string, MockEntry>();

  function isAlive(key: string): boolean {
    const entry = store.get(key);
    if (!entry) return false;
    if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
      store.delete(key);
      return false;
    }
    return true;
  }

  return {
    _store: store,

    async get(key: string): Promise<string | null> {
      if (!isAlive(key)) return null;
      return store.get(key)?.value ?? null;
    },

    async set(
      key: string,
      value: string,
      options?: { EX?: number; NX?: boolean },
    ): Promise<string | null> {
      if (options?.NX && isAlive(key)) return null; // NX: fail if exists
      const expiresAt = options?.EX ? Date.now() + options.EX * 1000 : 0;
      store.set(key, { value, expiresAt });
      return "OK";
    },

    async del(key: string | string[]): Promise<number> {
      const keys = Array.isArray(key) ? key : [key];
      let deleted = 0;
      for (const k of keys) {
        if (store.delete(k)) deleted++;
      }
      return deleted;
    },

    async exists(key: string | string[]): Promise<number> {
      const keys = Array.isArray(key) ? key : [key];
      return keys.filter((k) => isAlive(k)).length;
    },

    async scan(
      _cursor: string | number,
      ..._args: (string | number)[]
    ): Promise<[string | number, string[]]> {
      // Simple: return all keys matching MATCH pattern (arg index 1 after MATCH)
      const matchIdx = _args.indexOf("MATCH");
      const pattern = matchIdx >= 0 ? String(_args[matchIdx + 1] ?? "*") : "*";
      const prefix = pattern.replace(/\*$/, "");
      const keys = Array.from(store.keys()).filter((k) => k.startsWith(prefix) && isAlive(k));
      return [0, keys]; // cursor 0 = done
    },

    async eval(
      script: string,
      _numkeys: number,
      ...args: (string | number)[]
    ): Promise<unknown> {
      // Minimal Lua interpreter for the unlock script:
      // if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0
      const key = String(args[0]);
      const expected = String(args[1]);
      if (script.includes('redis.call("get"') && script.includes('redis.call("del"')) {
        const current = store.get(key);
        if (current && current.value === expected) {
          store.delete(key);
          return 1;
        }
        return 0;
      }
      return 0;
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("RedisIdempotencyStore", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisIdempotencyStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisIdempotencyStore({ client: redis, ttlMs: 60_000 });
  });

  // ── tryLock ────────────────────────────────────────────────────────────

  describe("tryLock", () => {
    it("first request for a fresh key returns true", async () => {
      expect(await store.tryLock("key-1", "req-A", 10_000)).toBe(true);
    });

    it("second request for same key returns false (NX)", async () => {
      await store.tryLock("key-2", "req-A", 10_000);
      expect(await store.tryLock("key-2", "req-B", 10_000)).toBe(false);
    });

    it("expired lock allows new acquisition", async () => {
      await store.tryLock("key-3", "req-A", 1); // 1ms TTL
      // Force expiry by manipulating mock
      const lockKey = "idem:lock:key-3";
      const entry = redis._store.get(lockKey);
      if (entry) entry.expiresAt = Date.now() - 1;

      expect(await store.tryLock("key-3", "req-B", 10_000)).toBe(true);
    });
  });

  // ── unlock ─────────────────────────────────────────────────────────────

  describe("unlock", () => {
    it("releases lock when requestId matches (atomic Lua path)", async () => {
      await store.tryLock("key-4", "req-A", 10_000);
      await store.unlock("key-4", "req-A");
      expect(await store.isLocked("key-4")).toBe(false);
    });

    it("does NOT release lock when requestId mismatches (Lua check)", async () => {
      await store.tryLock("key-5", "req-A", 10_000);
      await store.unlock("key-5", "req-B"); // wrong owner
      expect(await store.isLocked("key-5")).toBe(true);
    });

    it("TOCTOU race: concurrent unlock cannot steal another worker's lock", async () => {
      // Worker A acquires
      await store.tryLock("key-6", "req-A", 60_000);

      // Simulate: Worker A's lock expires, Worker B acquires
      const lockKey = "idem:lock:key-6";
      redis._store.set(lockKey, { value: "req-B", expiresAt: Date.now() + 60_000 });

      // Worker A tries to unlock — must NOT delete Worker B's lock
      await store.unlock("key-6", "req-A");
      expect(await store.isLocked("key-6")).toBe(true);

      // Verify Worker B still holds it
      const holder = await redis.get(lockKey);
      expect(holder).toBe("req-B");
    });

    it("uses fallback path when eval is unavailable", async () => {
      // Create a client without eval
      const clientNoEval = { ...redis } as RedisClient;
      delete (clientNoEval as Record<string, unknown>).eval;

      const storeNoEval = new RedisIdempotencyStore({ client: clientNoEval });

      await storeNoEval.tryLock("key-7", "req-A", 10_000);
      await storeNoEval.unlock("key-7", "req-A");
      expect(await storeNoEval.isLocked("key-7")).toBe(false);
    });
  });

  // ── set/get lifecycle ──────────────────────────────────────────────────

  describe("set/get lifecycle", () => {
    it("stores and retrieves a cached result", async () => {
      await store.set("res-1", {
        statusCode: 201,
        headers: { "content-type": "application/json" },
        body: { id: "abc" },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const cached = await store.get("res-1");
      expect(cached).toBeDefined();
      expect(cached?.statusCode).toBe(201);
      expect(cached?.body).toEqual({ id: "abc" });
    });

    it("get returns undefined for non-existent key", async () => {
      expect(await store.get("nope")).toBeUndefined();
    });

    it("get returns undefined for expired key", async () => {
      await store.set("exp-1", {
        statusCode: 200,
        headers: {},
        body: {},
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 1), // 1ms TTL
      });
      // Force expiry
      const resultKey = "idem:exp-1";
      const entry = redis._store.get(resultKey);
      if (entry) entry.expiresAt = Date.now() - 1;

      expect(await store.get("exp-1")).toBeUndefined();
    });
  });

  // ── delete operations ──────────────────────────────────────────────────

  describe("delete operations", () => {
    it("delete removes a specific key", async () => {
      await store.set("del-1", {
        statusCode: 200,
        headers: {},
        body: {},
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await store.delete("del-1");
      expect(await store.get("del-1")).toBeUndefined();
    });

    it("deleteByPrefix removes matching keys", async () => {
      for (const s of ["a", "b", "c"]) {
        await store.set(`pfx:${s}`, {
          statusCode: 200,
          headers: {},
          body: {},
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        });
      }
      const count = await store.deleteByPrefix("pfx:");
      expect(count).toBe(3);
    });

    it("findByPrefix returns first match", async () => {
      await store.set("find:x", {
        statusCode: 200,
        headers: {},
        body: { found: true },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const result = await store.findByPrefix("find:");
      expect(result?.body).toEqual({ found: true });
    });
  });

  // ── isLocked ───────────────────────────────────────────────────────────

  describe("isLocked", () => {
    it("returns true when locked", async () => {
      await store.tryLock("il-1", "req-A", 10_000);
      expect(await store.isLocked("il-1")).toBe(true);
    });

    it("returns false when not locked", async () => {
      expect(await store.isLocked("il-2")).toBe(false);
    });
  });
});
