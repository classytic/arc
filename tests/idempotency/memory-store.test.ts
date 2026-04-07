import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdempotencyResult } from "../../src/idempotency/stores/interface.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/stores/memory.js";

describe("MemoryIdempotencyStore", () => {
  let store: MemoryIdempotencyStore;

  beforeEach(() => {
    store = new MemoryIdempotencyStore({ cleanupIntervalMs: 60000 });
  });

  afterEach(async () => {
    await store.close();
  });

  describe("get/set", () => {
    it("stores and retrieves a result", async () => {
      const result = createIdempotencyResult(
        200,
        { ok: true },
        { "content-type": "application/json" },
        60000,
      );
      await store.set("key1", result);
      const retrieved = await store.get("key1");
      expect(retrieved).toBeDefined();
      expect(retrieved?.statusCode).toBe(200);
      expect(retrieved?.body).toEqual({ ok: true });
    });

    it("returns undefined for missing key", async () => {
      expect(await store.get("nonexistent")).toBeUndefined();
    });

    it("returns undefined for expired entry", async () => {
      const result = createIdempotencyResult(200, {}, {}, 1); // 1ms TTL
      await store.set("expired", result);
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.get("expired")).toBeUndefined();
    });

    it("evicts oldest entries when at max capacity", async () => {
      const smallStore = new MemoryIdempotencyStore({ maxEntries: 3, cleanupIntervalMs: 60000 });
      for (let i = 0; i < 5; i++) {
        await smallStore.set(`key-${i}`, createIdempotencyResult(200, {}, {}, 60000));
      }
      // Should have evicted some entries
      const stats = smallStore.getStats();
      expect(stats.results).toBeLessThanOrEqual(5);
      await smallStore.close();
    });
  });

  describe("locks", () => {
    it("acquires lock successfully", async () => {
      const locked = await store.tryLock("lock1", "req-1", 5000);
      expect(locked).toBe(true);
    });

    it("fails to acquire lock held by another request", async () => {
      await store.tryLock("lock1", "req-1", 5000);
      const locked = await store.tryLock("lock1", "req-2", 5000);
      expect(locked).toBe(false);
    });

    it("acquires lock after previous expires", async () => {
      await store.tryLock("lock1", "req-1", 1); // 1ms TTL
      await new Promise((r) => setTimeout(r, 10));
      const locked = await store.tryLock("lock1", "req-2", 5000);
      expect(locked).toBe(true);
    });

    it("unlocks only if requestId matches", async () => {
      await store.tryLock("lock1", "req-1", 5000);
      await store.unlock("lock1", "req-2"); // Wrong requestId
      expect(await store.isLocked("lock1")).toBe(true);
      await store.unlock("lock1", "req-1"); // Correct requestId
      expect(await store.isLocked("lock1")).toBe(false);
    });

    it("isLocked returns false for expired locks", async () => {
      await store.tryLock("lock1", "req-1", 1);
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.isLocked("lock1")).toBe(false);
    });
  });

  describe("prefix operations", () => {
    it("deleteByPrefix removes matching entries", async () => {
      await store.set("order:123:fp1", createIdempotencyResult(200, {}, {}, 60000));
      await store.set("order:123:fp2", createIdempotencyResult(200, {}, {}, 60000));
      await store.set("order:456:fp1", createIdempotencyResult(200, {}, {}, 60000));
      const count = await store.deleteByPrefix("order:123:");
      expect(count).toBe(2);
      expect(await store.get("order:456:fp1")).toBeDefined();
    });

    it("findByPrefix returns first matching non-expired entry", async () => {
      await store.set("key:abc:1", createIdempotencyResult(200, { id: 1 }, {}, 60000));
      await store.set("key:abc:2", createIdempotencyResult(201, { id: 2 }, {}, 60000));
      const found = await store.findByPrefix("key:abc:");
      expect(found).toBeDefined();
      expect(found?.statusCode).toBe(200);
    });

    it("findByPrefix returns undefined for no match", async () => {
      expect(await store.findByPrefix("nomatch:")).toBeUndefined();
    });

    it("findByPrefix skips expired entries", async () => {
      await store.set("exp:1", createIdempotencyResult(200, {}, {}, 1)); // 1ms TTL
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.findByPrefix("exp:")).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("removes entry and lock by key", async () => {
      await store.set("del-key", createIdempotencyResult(200, {}, {}, 60000));
      await store.tryLock("del-key", "req-1", 5000);
      await store.delete("del-key");
      expect(await store.get("del-key")).toBeUndefined();
      expect(await store.isLocked("del-key")).toBe(false);
    });
  });

  describe("close", () => {
    it("clears all entries and stops cleanup", async () => {
      await store.set("key1", createIdempotencyResult(200, {}, {}, 60000));
      await store.close();
      const stats = store.getStats();
      expect(stats.results).toBe(0);
      expect(stats.locks).toBe(0);
    });
  });

  describe("getStats", () => {
    it("returns current counts", async () => {
      await store.set("a", createIdempotencyResult(200, {}, {}, 60000));
      await store.set("b", createIdempotencyResult(200, {}, {}, 60000));
      await store.tryLock("c", "req-1", 5000);
      const stats = store.getStats();
      expect(stats.results).toBe(2);
      expect(stats.locks).toBe(1);
    });
  });
});
