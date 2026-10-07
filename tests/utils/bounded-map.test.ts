/**
 * `touch` / `evictToSize` / `assertCapacity` — the insertion-order LRU moves,
 * written once.
 *
 * Seven places hand-rolled them and the copies drifted into three real bugs,
 * each pinned below against the component that had it:
 *   - response cache: evict-BEFORE-insert with `>=` spun forever at
 *     `maxEntries: 0`, freezing the event loop on the first cached GET;
 *   - response cache: `maxEntries: NaN` made the comparison always false —
 *     unbounded;
 *   - MCP auth cache + memory cache: a falsy-key guard never evicted `""`.
 */

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { MemoryCacheStore } from "../../src/cache/memory.js";
import { assertCapacity, evictToSize, touch } from "../../src/collections/boundedMap.js";
import { McpAuthCache } from "../../src/integrations/mcp/authBridge.js";
import { responseCachePlugin } from "../../src/plugins/response-cache.js";

describe("touch / evictToSize", () => {
  it("touch moves a key to most-recent", () => {
    const m = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    touch(m, "a", 1);
    expect([...m.keys()]).toEqual(["b", "a"]);
  });

  it("evicts least-recent first and reports the count", () => {
    const m = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    const evicted: string[] = [];
    expect(evictToSize(m, 1, (k) => evicted.push(k))).toBe(2);
    expect(evicted).toEqual(["a", "b"]);
    expect([...m.keys()]).toEqual(["c"]);
  });

  it("maxSize 0 empties the map — terminates rather than spinning", () => {
    const m = new Map([["only", 1]]);
    expect(evictToSize(m, 0)).toBe(1);
    expect(m.size).toBe(0);
  });

  it("an empty-string key is evicted like any other", () => {
    const m = new Map([
      ["", 1],
      ["b", 2],
    ]);
    evictToSize(m, 1);
    expect([...m.keys()]).toEqual(["b"]);
  });

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])(
    "assertCapacity rejects %s, naming the option",
    (bad) => {
      expect(() => assertCapacity("thing maxEntries", bad)).toThrow(/thing maxEntries/);
    },
  );

  it("assertCapacity accepts 0 — a deliberately disabled cache", () => {
    expect(assertCapacity("x", 0)).toBe(0);
  });
});

describe("the components that had the bugs", () => {
  it("response cache with maxEntries: 0 serves requests instead of hanging", async () => {
    const app = Fastify({ logger: false });
    await app.register(responseCachePlugin, { maxEntries: 0, defaultTTL: 60 });
    app.get("/items", async () => ({ ok: true }));
    await app.ready();

    // Pre-fix, the first cacheable GET entered `while (0 >= 0)` with nothing to
    // evict and never returned. The test's own timeout would be the only exit.
    const res = await app.inject({ method: "GET", url: "/items" });
    expect(res.statusCode).toBe(200);
    const again = await app.inject({ method: "GET", url: "/items" });
    expect(again.headers["x-cache"]).not.toBe("HIT"); // nothing is retained
    await app.close();
  }, 5_000);

  it("response cache refuses a non-integer maxEntries at registration", async () => {
    const app = Fastify({ logger: false });
    await expect(
      app.register(responseCachePlugin, { maxEntries: Number.NaN }).ready(),
    ).rejects.toThrow(/responseCache maxEntries/);
    await app.close();
  });

  it("MCP auth cache evicts an empty-string key when full", () => {
    const cache = new McpAuthCache({ maxEntries: 1, ttlMs: 60_000 });
    cache.set("", null);
    cache.set("second", null);
    expect(cache.get("")).toBeUndefined();
    expect(cache.get("second")).toBeNull();
  });

  it("memory cache evicts an empty-string key at the head of the map", async () => {
    const store = new MemoryCacheStore({ maxEntries: 1 });
    await store.set("", "first");
    await store.set("second", "value");
    expect(await store.get("")).toBeUndefined();
    expect(await store.get("second")).toBe("value");
  });
});
