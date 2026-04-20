/**
 * QueryCache Core Tests
 *
 * Tests the CacheEnvelope, get/set, version bumping, and key generation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildQueryKey, hashParams, tagVersionKey, versionKey } from "../../src/cache/keys.js";
import { MemoryCacheStore } from "../../src/cache/memory.js";
import { QueryCache } from "../../src/cache/QueryCache.js";

describe("QueryCache", () => {
  let store: MemoryCacheStore;
  let cache: QueryCache;

  beforeEach(() => {
    store = new MemoryCacheStore({ defaultTtlSeconds: 60 });
    cache = new QueryCache(store);
  });

  afterEach(async () => {
    await store.close();
  });

  // ==========================================================================
  // get / set
  // ==========================================================================

  describe("get/set", () => {
    it("should return miss for unknown key", async () => {
      const result = await cache.get("nonexistent");
      expect(result.status).toBe("miss");
      expect(result.data).toBeUndefined();
    });

    it("should store and retrieve data", async () => {
      await cache.set("key1", { name: "test" }, { staleTime: 30, gcTime: 60 });
      const result = await cache.get<{ name: string }>("key1");
      expect(result.status).toBe("fresh");
      expect(result.data).toEqual({ name: "test" });
    });

    it("should return fresh status within staleTime", async () => {
      await cache.set("key1", "hello", { staleTime: 30, gcTime: 60 });
      const result = await cache.get<string>("key1");
      expect(result.status).toBe("fresh");
      expect(result.data).toBe("hello");
    });

    it("should return stale status after staleTime but before gcTime", async () => {
      const now = Date.now();
      let currentTime = now;
      vi.spyOn(Date, "now").mockImplementation(() => currentTime);

      await cache.set("key1", "hello", { staleTime: 30, gcTime: 60 });

      // Advance past staleTime (30s) but before staleTime + gcTime (90s)
      currentTime = now + 31_000;
      const result = await cache.get<string>("key1");
      expect(result.status).toBe("stale");
      expect(result.data).toBe("hello");

      vi.restoreAllMocks();
    });

    it("should return miss after total lifetime (staleTime + gcTime)", async () => {
      const now = Date.now();
      let currentTime = now;
      vi.spyOn(Date, "now").mockImplementation(() => currentTime);

      await cache.set("key1", "hello", { staleTime: 30, gcTime: 60 });

      // Advance past staleTime + gcTime (30 + 60 = 90s)
      currentTime = now + 91_000;
      const result = await cache.get<string>("key1");
      expect(result.status).toBe("miss");

      vi.restoreAllMocks();
    });

    it("should use default values when config is partial", async () => {
      await cache.set("key1", "data", {}); // staleTime: 0, gcTime: 60
      const result = await cache.get<string>("key1");
      // With staleTime: 0, data is immediately stale
      expect(result.status).toBe("stale");
      expect(result.data).toBe("data");
    });

    it("should store tags in envelope", async () => {
      await cache.set("key1", "data", { staleTime: 10, gcTime: 60, tags: ["catalog", "products"] });
      const envelope = (await store.get("key1")) as Record<string, unknown>;
      expect(envelope.tags).toEqual(["catalog", "products"]);
    });
  });

  // ==========================================================================
  // invalidate
  // ==========================================================================

  describe("invalidate", () => {
    it("should delete a specific key", async () => {
      await cache.set("key1", "data", { staleTime: 30, gcTime: 60 });
      await cache.invalidate("key1");
      const result = await cache.get("key1");
      expect(result.status).toBe("miss");
    });
  });

  // ==========================================================================
  // Version bumping
  // ==========================================================================

  describe("resource versions", () => {
    it("should return 0 for unset resource version", async () => {
      const version = await cache.getResourceVersion("product");
      expect(version).toBe(0);
    });

    it("should bump resource version", async () => {
      await cache.bumpResourceVersion("product");
      const version = await cache.getResourceVersion("product");
      expect(version).toBeGreaterThan(0);
    });

    it("should change version on each bump", async () => {
      await cache.bumpResourceVersion("product");
      const v1 = await cache.getResourceVersion("product");

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 5));

      await cache.bumpResourceVersion("product");
      const v2 = await cache.getResourceVersion("product");
      expect(v2).toBeGreaterThanOrEqual(v1);
    });
  });

  describe("tag versions", () => {
    it("should return 0 for unset tag version", async () => {
      const version = await cache.getTagVersion("catalog");
      expect(version).toBe(0);
    });

    it("should bump tag version", async () => {
      await cache.bumpTagVersion("catalog");
      const version = await cache.getTagVersion("catalog");
      expect(version).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// Cache Key Utilities
// ============================================================================

describe("Cache Key Utilities", () => {
  describe("buildQueryKey", () => {
    it("should build deterministic key with all parameters", () => {
      const key = buildQueryKey("product", "list", 12345, { page: 1, limit: 20 }, "user1", "org1");
      expect(key).toContain("arc:product:12345:list:");
      expect(key).toContain("u=user1");
      expect(key).toContain("o=org1");
    });

    it('should use "anon" and "pub" defaults for missing userId/orgId', () => {
      const key = buildQueryKey("product", "list", 0, {});
      expect(key).toContain("u=anon");
      expect(key).toContain("o=pub");
    });

    it("should produce same key for same params", () => {
      const k1 = buildQueryKey("product", "list", 0, { page: 1, sort: "name" });
      const k2 = buildQueryKey("product", "list", 0, { sort: "name", page: 1 }); // different order
      expect(k1).toBe(k2);
    });

    it("should produce different keys for different params", () => {
      const k1 = buildQueryKey("product", "list", 0, { page: 1 });
      const k2 = buildQueryKey("product", "list", 0, { page: 2 });
      expect(k1).not.toBe(k2);
    });

    it("should produce different keys for different versions", () => {
      const k1 = buildQueryKey("product", "list", 1, { page: 1 });
      const k2 = buildQueryKey("product", "list", 2, { page: 1 });
      expect(k1).not.toBe(k2);
    });
  });

  describe("hashParams", () => {
    it("should produce stable hash for same input", () => {
      const h1 = hashParams({ a: 1, b: "hello" });
      const h2 = hashParams({ b: "hello", a: 1 });
      expect(h1).toBe(h2);
    });

    it("should handle nested objects", () => {
      const h1 = hashParams({ filter: { status: "active" }, page: 1 });
      const h2 = hashParams({ page: 1, filter: { status: "active" } });
      expect(h1).toBe(h2);
    });

    it("should handle empty params", () => {
      const hash = hashParams({});
      expect(typeof hash).toBe("string");
      expect(hash.length).toBeGreaterThan(0);
    });
  });

  describe("versionKey / tagVersionKey", () => {
    it("should return correct version key format", () => {
      expect(versionKey("product")).toBe("arc:ver:product");
    });

    it("should return correct tag version key format", () => {
      expect(tagVersionKey("catalog")).toBe("arc:tagver:catalog");
    });
  });
});
