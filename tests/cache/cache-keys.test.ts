import { describe, expect, it } from "vitest";
import { buildQueryKey, hashParams, tagVersionKey, versionKey } from "../../src/cache/keys.js";

describe("buildQueryKey()", () => {
  it("generates deterministic key with all segments", () => {
    const key = buildQueryKey("users", "list", 1, { page: 1 }, "u1", "org1");
    expect(key).toContain("arc:users:1:list:");
    expect(key).toContain("u=u1");
    expect(key).toContain("o=org1");
  });

  it("uses 'anon' for missing userId", () => {
    const key = buildQueryKey("users", "list", 1, {});
    expect(key).toContain("u=anon");
  });

  it("uses 'pub' for missing orgId", () => {
    const key = buildQueryKey("users", "list", 1, {});
    expect(key).toContain("o=pub");
  });

  it("same params produce same key", () => {
    const k1 = buildQueryKey("posts", "list", 2, { status: "active", page: 1 });
    const k2 = buildQueryKey("posts", "list", 2, { status: "active", page: 1 });
    expect(k1).toBe(k2);
  });

  it("different param order produces same key (stable hash)", () => {
    const k1 = buildQueryKey("posts", "list", 1, { a: 1, b: 2 });
    const k2 = buildQueryKey("posts", "list", 1, { b: 2, a: 1 });
    expect(k1).toBe(k2);
  });

  it("different params produce different keys", () => {
    const k1 = buildQueryKey("posts", "list", 1, { page: 1 });
    const k2 = buildQueryKey("posts", "list", 1, { page: 2 });
    expect(k1).not.toBe(k2);
  });

  it("different resource version produces different key", () => {
    const k1 = buildQueryKey("posts", "list", 1, {});
    const k2 = buildQueryKey("posts", "list", 2, {});
    expect(k1).not.toBe(k2);
  });

  it("different users produce different keys (tenant isolation)", () => {
    const k1 = buildQueryKey("posts", "list", 1, {}, "user-a");
    const k2 = buildQueryKey("posts", "list", 1, {}, "user-b");
    expect(k1).not.toBe(k2);
  });

  it("different orgs produce different keys (org isolation)", () => {
    const k1 = buildQueryKey("posts", "list", 1, {}, "u1", "org-a");
    const k2 = buildQueryKey("posts", "list", 1, {}, "u1", "org-b");
    expect(k1).not.toBe(k2);
  });
});

describe("versionKey()", () => {
  it("generates resource version key", () => {
    expect(versionKey("users")).toBe("arc:ver:users");
  });
});

describe("tagVersionKey()", () => {
  it("generates tag version key", () => {
    expect(tagVersionKey("user-related")).toBe("arc:tagver:user-related");
  });
});

describe("hashParams()", () => {
  it("returns consistent hash for same input", () => {
    expect(hashParams({ a: 1 })).toBe(hashParams({ a: 1 }));
  });

  it("is order-independent", () => {
    expect(hashParams({ z: 1, a: 2 })).toBe(hashParams({ a: 2, z: 1 }));
  });

  it("handles nested objects stably", () => {
    const h1 = hashParams({ filter: { status: "active", type: "post" } });
    const h2 = hashParams({ filter: { type: "post", status: "active" } });
    expect(h1).toBe(h2);
  });

  it("handles empty object", () => {
    const hash = hashParams({});
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("handles arrays", () => {
    const h1 = hashParams({ ids: [1, 2, 3] });
    const h2 = hashParams({ ids: [1, 2, 3] });
    expect(h1).toBe(h2);
  });

  it("different arrays produce different hashes", () => {
    const h1 = hashParams({ ids: [1, 2] });
    const h2 = hashParams({ ids: [2, 1] });
    expect(h1).not.toBe(h2);
  });
});
