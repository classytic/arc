import { describe, expect, it, vi } from "vitest";
import { MemoryCacheStore } from "../../src/cache/memory.js";
import { type RedisCacheClient, RedisCacheStore } from "../../src/cache/redis.js";

describe("Cache Stores", () => {
  describe("MemoryCacheStore", () => {
    it("enforces hard maxEntries and evicts LRU", async () => {
      const store = new MemoryCacheStore<string>({
        maxEntries: 2,
        defaultTtlSeconds: 10,
      });

      await store.set("a", "A");
      await store.set("b", "B");

      // Access "a" to make it most recently used.
      expect(await store.get("a")).toBe("A");

      await store.set("c", "C");

      expect(await store.get("a")).toBe("A");
      expect(await store.get("b")).toBeUndefined();
      expect(await store.get("c")).toBe("C");

      await store.close();
    });

    it("expires values by TTL", async () => {
      // 0.005s = 5ms; the set path multiplies by 1000 internally so the
      // entry expires almost immediately. Using seconds as the unit means
      // sub-second TTLs are fractional — that's fine, the underlying
      // `setTimeout`/`Date.now()` math is in ms either way.
      const store = new MemoryCacheStore<string>({
        defaultTtlSeconds: 0.005,
      });

      await store.set("short", "value");
      expect(await store.get("short")).toBe("value");

      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(await store.get("short")).toBeUndefined();

      await store.close();
    });

    it("skips oversized entries safely", async () => {
      const warn = vi.fn();
      const store = new MemoryCacheStore<string>({
        maxEntryBytes: 1024,
        logger: { warn, error: vi.fn() },
      });

      await store.set("big", "x".repeat(5000));
      expect(await store.get("big")).toBeUndefined();
      expect(warn).toHaveBeenCalled();

      await store.close();
    });
  });

  describe("RedisCacheStore", () => {
    it("serializes values and uses prefix+ttl on set", async () => {
      const get = vi.fn(async () => null);
      const set = vi.fn(async () => "OK");
      const del = vi.fn(async () => 1);

      const client: RedisCacheClient = { get, set, del };
      const store = new RedisCacheStore<{ allow: boolean }>({
        client,
        prefix: "test:",
        defaultTtlSeconds: 60,
      });

      await store.set("k1", { allow: true });
      expect(set).toHaveBeenCalledWith("test:k1", JSON.stringify({ allow: true }), { EX: 60 });

      await store.delete("k1");
      expect(del).toHaveBeenCalledWith("test:k1");
    });

    it("returns undefined for malformed cached json", async () => {
      const client: RedisCacheClient = {
        get: vi.fn(async () => "{not-json"),
        set: vi.fn(async () => "OK"),
        del: vi.fn(async () => 1),
      };
      const store = new RedisCacheStore<{ ok: boolean }>({ client });
      expect(await store.get("bad")).toBeUndefined();
    });

    it("clear() uses SCAN to delete prefixed keys when scan is available", async () => {
      const del = vi.fn(async () => 3);
      const scan = vi.fn(
        async () => ["0", ["test:k1", "test:k2", "test:k3"]] as [string, string[]],
      );

      const client: RedisCacheClient = {
        get: vi.fn(async () => null),
        set: vi.fn(async () => "OK"),
        del,
        scan,
      };

      const store = new RedisCacheStore<string>({ client, prefix: "test:" });
      await store.clear();

      expect(scan).toHaveBeenCalledWith("0", "MATCH", "test:*", "COUNT", 200);
      expect(del).toHaveBeenCalledWith(["test:k1", "test:k2", "test:k3"]);
    });

    it("clear() is safe no-op when scan is not available", async () => {
      const del = vi.fn(async () => 1);
      const client: RedisCacheClient = {
        get: vi.fn(async () => null),
        set: vi.fn(async () => "OK"),
        del,
      };

      const store = new RedisCacheStore<string>({ client, prefix: "test:" });
      await store.clear(); // should not throw
      expect(del).not.toHaveBeenCalled();
    });

    it("clear() handles multi-page SCAN correctly", async () => {
      let callCount = 0;
      const del = vi.fn(async () => 2);
      const scan = vi.fn(async (cursor: string | number) => {
        callCount++;
        if (String(cursor) === "0") {
          return ["42", ["test:page1-a", "test:page1-b"]] as [string, string[]];
        }
        return ["0", ["test:page2-a"]] as [string, string[]];
      });

      const client: RedisCacheClient = {
        get: vi.fn(async () => null),
        set: vi.fn(async () => "OK"),
        del,
        scan,
      };

      const store = new RedisCacheStore<string>({ client, prefix: "test:" });
      await store.clear();

      expect(callCount).toBe(2);
      expect(del).toHaveBeenCalledTimes(2);
      expect(del).toHaveBeenCalledWith(["test:page1-a", "test:page1-b"]);
      expect(del).toHaveBeenCalledWith(["test:page2-a"]);
    });
  });
});
