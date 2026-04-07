/**
 * QueryCache Tag & Cross-Resource Invalidation Tests
 *
 * Validates version-based invalidation for resources and tags.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildQueryKey } from "../../src/cache/keys.js";
import { MemoryCacheStore } from "../../src/cache/memory.js";
import { QueryCache } from "../../src/cache/QueryCache.js";

describe("QueryCache Tag Invalidation", () => {
  let store: MemoryCacheStore;
  let cache: QueryCache;

  beforeEach(() => {
    store = new MemoryCacheStore({ defaultTtlMs: 300_000 });
    cache = new QueryCache(store);
  });

  afterEach(async () => {
    await store.close();
  });

  // ==========================================================================
  // Resource version invalidation
  // ==========================================================================

  describe("resource version invalidation", () => {
    it("should invalidate all cached queries when resource version is bumped", async () => {
      // Cache with version 0
      const v0 = await cache.getResourceVersion("product");
      const key1 = buildQueryKey("product", "list", v0, { page: 1 });
      const key2 = buildQueryKey("product", "list", v0, { page: 2 });

      await cache.set(key1, { docs: [{ id: 1 }] }, { staleTime: 300, gcTime: 300 });
      await cache.set(key2, { docs: [{ id: 2 }] }, { staleTime: 300, gcTime: 300 });

      // Both should be fresh
      expect((await cache.get(key1)).status).toBe("fresh");
      expect((await cache.get(key2)).status).toBe("fresh");

      // Bump version → new queries use new version → old keys become orphans
      await cache.bumpResourceVersion("product");
      const v1 = await cache.getResourceVersion("product");
      expect(v1).not.toBe(v0);

      // New query with new version → miss (no data cached for this version)
      const newKey = buildQueryKey("product", "list", v1, { page: 1 });
      expect((await cache.get(newKey)).status).toBe("miss");

      // Old keys are still in store (they expire via TTL), but new code won't use them
      // because the version in the key doesn't match the current version
    });

    it("should not affect other resources when bumping version", async () => {
      const productV = await cache.getResourceVersion("product");
      const orderV = await cache.getResourceVersion("order");

      const productKey = buildQueryKey("product", "list", productV, {});
      const orderKey = buildQueryKey("order", "list", orderV, {});

      await cache.set(productKey, { docs: [] }, { staleTime: 300, gcTime: 300 });
      await cache.set(orderKey, { docs: [] }, { staleTime: 300, gcTime: 300 });

      // Bump only product
      await cache.bumpResourceVersion("product");

      // Order key still valid (same version)
      expect((await cache.get(orderKey)).status).toBe("fresh");
    });
  });

  // ==========================================================================
  // Tag version invalidation
  // ==========================================================================

  describe("tag version invalidation", () => {
    it("should track tag versions independently", async () => {
      const v1 = await cache.getTagVersion("catalog");
      const v2 = await cache.getTagVersion("analytics");

      expect(v1).toBe(0);
      expect(v2).toBe(0);

      await cache.bumpTagVersion("catalog");

      const v1After = await cache.getTagVersion("catalog");
      const v2After = await cache.getTagVersion("analytics");

      expect(v1After).toBeGreaterThan(0);
      expect(v2After).toBe(0); // unchanged
    });

    it("should bump tag version multiple times", async () => {
      await cache.bumpTagVersion("catalog");
      const v1 = await cache.getTagVersion("catalog");

      await new Promise((resolve) => setTimeout(resolve, 5));

      await cache.bumpTagVersion("catalog");
      const v2 = await cache.getTagVersion("catalog");

      expect(v2).toBeGreaterThanOrEqual(v1);
    });
  });

  // ==========================================================================
  // Multi-tenant key isolation
  // ==========================================================================

  describe("multi-tenant key isolation", () => {
    it("should create different keys for different users", async () => {
      const v = await cache.getResourceVersion("product");
      const keyA = buildQueryKey("product", "list", v, { page: 1 }, "userA");
      const keyB = buildQueryKey("product", "list", v, { page: 1 }, "userB");

      expect(keyA).not.toBe(keyB);

      await cache.set(keyA, { docs: [{ id: "a" }] }, { staleTime: 300, gcTime: 300 });

      // userB should miss
      expect((await cache.get(keyB)).status).toBe("miss");
      // userA should hit
      expect((await cache.get(keyA)).status).toBe("fresh");
    });

    it("should create different keys for different orgs", async () => {
      const v = await cache.getResourceVersion("product");
      const key1 = buildQueryKey("product", "list", v, {}, undefined, "org1");
      const key2 = buildQueryKey("product", "list", v, {}, undefined, "org2");

      expect(key1).not.toBe(key2);
    });
  });
});
