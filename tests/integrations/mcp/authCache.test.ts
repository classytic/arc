import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpAuthCache, resolveMcpAuth } from "../../../src/integrations/mcp/authBridge.js";

describe("McpAuthCache", () => {
  let cache: McpAuthCache;

  beforeEach(() => {
    cache = new McpAuthCache({ ttlMs: 100 });
  });

  it("returns undefined for unknown keys", () => {
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("stores and retrieves auth results", () => {
    const auth = { userId: "u1", organizationId: "org-1" };
    cache.set("token-123", auth);
    expect(cache.get("token-123")).toEqual(auth);
  });

  it("caches null results (failed auth)", () => {
    cache.set("bad-token", null);
    expect(cache.get("bad-token")).toBeNull();
  });

  it("expires entries after TTL", async () => {
    cache.set("token-123", { userId: "u1" });
    await new Promise((r) => setTimeout(r, 150));
    expect(cache.get("token-123")).toBeUndefined();
  });

  it("evicts oldest when at capacity", () => {
    const smallCache = new McpAuthCache({ ttlMs: 10_000, maxEntries: 2 });
    smallCache.set("a", { userId: "a" });
    smallCache.set("b", { userId: "b" });
    smallCache.set("c", { userId: "c" }); // Should evict "a"
    expect(smallCache.get("a")).toBeUndefined();
    expect(smallCache.get("b")).toEqual({ userId: "b" });
    expect(smallCache.get("c")).toEqual({ userId: "c" });
  });
});

describe("resolveMcpAuth with cache", () => {
  it("caches auth resolver results to avoid duplicate calls", async () => {
    const resolver = vi.fn().mockResolvedValue({ userId: "u1" });
    const cache = new McpAuthCache({ ttlMs: 5_000 });
    const headers = { authorization: "Bearer test-token" };

    // First call — hits resolver
    const result1 = await resolveMcpAuth(headers, resolver, cache);
    expect(result1).toEqual({ userId: "u1" });
    expect(resolver).toHaveBeenCalledTimes(1);

    // Second call — hits cache, resolver not called again
    const result2 = await resolveMcpAuth(headers, resolver, cache);
    expect(result2).toEqual({ userId: "u1" });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("does not cache when no auth header present", async () => {
    const resolver = vi.fn().mockResolvedValue({ userId: "u1" });
    const cache = new McpAuthCache({ ttlMs: 5_000 });
    const headers = {}; // No authorization or x-api-key

    await resolveMcpAuth(headers, resolver, cache);
    await resolveMcpAuth(headers, resolver, cache);

    // Both calls hit resolver since there's no cache key
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("works without cache (backward compatible)", async () => {
    const resolver = vi.fn().mockResolvedValue({ userId: "u1" });
    const result = await resolveMcpAuth({ authorization: "Bearer x" }, resolver);
    expect(result).toEqual({ userId: "u1" });
  });
});
