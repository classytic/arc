import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSessionCache } from "../../../src/integrations/mcp/sessionCache.js";
import type { SessionEntry } from "../../../src/integrations/mcp/types.js";

function mockEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  const auth = { userId: "user-1" };
  return {
    transport: { handleRequest: vi.fn(), close: vi.fn() },
    lastAccessed: Date.now(),
    organizationId: "org-1",
    auth,
    authRef: { current: auth },
    ...overrides,
  };
}

describe("McpSessionCache", () => {
  let cache: McpSessionCache;

  afterEach(() => {
    cache?.close();
  });

  it("stores and retrieves sessions", () => {
    cache = new McpSessionCache({ ttlMs: 60000 });
    const entry = mockEntry();
    cache.set("s1", entry);
    expect(cache.get("s1")).toBe(entry);
    expect(cache.size).toBe(1);
  });

  it("returns undefined for missing sessions", () => {
    cache = new McpSessionCache();
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("evicts expired sessions on get", () => {
    cache = new McpSessionCache({ ttlMs: 50 });
    const entry = mockEntry();
    cache.set("s1", entry);
    // Manually backdate the lastAccessed to simulate expiry
    entry.lastAccessed = Date.now() - 100;
    expect(cache.get("s1")).toBeUndefined();
  });

  it("touches refreshes TTL", () => {
    cache = new McpSessionCache({ ttlMs: 100 });
    const entry = mockEntry({ lastAccessed: Date.now() - 80 });
    cache.set("s1", entry);
    cache.touch("s1");
    expect(entry.lastAccessed).toBeGreaterThan(Date.now() - 20);
  });

  it("removes sessions explicitly", () => {
    cache = new McpSessionCache();
    cache.set("s1", mockEntry());
    cache.remove("s1");
    expect(cache.get("s1")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("calls transport.close() on removal", () => {
    cache = new McpSessionCache();
    const entry = mockEntry();
    cache.set("s1", entry);
    cache.remove("s1");
    expect(entry.transport.close).toHaveBeenCalled();
  });

  it("evicts oldest when at max capacity", () => {
    cache = new McpSessionCache({ maxSessions: 2, ttlMs: 60000 });
    cache.set("s1", mockEntry({ lastAccessed: Date.now() - 1000 }));
    cache.set("s2", mockEntry({ lastAccessed: Date.now() - 500 }));
    cache.set("s3", mockEntry()); // should evict s1 (oldest)
    expect(cache.get("s1")).toBeUndefined();
    expect(cache.get("s2")).toBeDefined();
    expect(cache.get("s3")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("close() clears all sessions and stops timer", () => {
    cache = new McpSessionCache();
    const e1 = mockEntry();
    const e2 = mockEntry();
    cache.set("s1", e1);
    cache.set("s2", e2);
    cache.close();
    expect(cache.size).toBe(0);
    expect(e1.transport.close).toHaveBeenCalled();
    expect(e2.transport.close).toHaveBeenCalled();
  });
});
