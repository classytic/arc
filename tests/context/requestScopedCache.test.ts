/**
 * `requestScopedCache` — a store whose lifetime is one request.
 *
 * The value of this thing is entirely in what it REFUSES to do. A cache that
 * merely "works" here is one that also leaks across requests, and that failure
 * is invisible in production: every read still returns a well-formed document,
 * occasionally belonging to someone else's request. So the tests below are
 * mostly negative, and the isolation ones are the point.
 */

import { describe, expect, it } from "vitest";
import { requestContext } from "../../src/context/requestContext.js";
import { hasRequestScopedCache, requestScopedCache } from "../../src/context/requestScopedCache.js";

/** Run `fn` inside a request context, as arc's onRequest hook would. */
function inRequest<T>(fn: () => T): T {
  return requestContext.run({ startTime: Date.now() }, fn);
}

describe("requestScopedCache — outside a request", () => {
  it("returns undefined rather than lazily creating a shared store", () => {
    // THE safety property. Returning a process-wide fallback here would make
    // every cron job, script and boot-time read share one cache — the exact
    // cross-request leak the scoping exists to prevent.
    expect(requestScopedCache()).toBeUndefined();
  });

  it("reports no cache allocated", () => {
    expect(hasRequestScopedCache()).toBe(false);
  });
});

describe("requestScopedCache — inside a request", () => {
  it("returns a usable adapter", async () => {
    await inRequest(async () => {
      const cache = requestScopedCache();
      expect(cache).toBeDefined();
      await cache?.set("k", { v: 1 });
      expect(await cache?.get("k")).toEqual({ v: 1 });
    });
  });

  it("returns the SAME instance across calls within one request", () => {
    inRequest(() => {
      expect(requestScopedCache()).toBe(requestScopedCache());
    });
  });

  it("allocates lazily — an untouched request creates nothing", () => {
    inRequest(() => {
      expect(hasRequestScopedCache()).toBe(false);
      requestScopedCache();
      expect(hasRequestScopedCache()).toBe(true);
    });
  });

  it("implements delete and clear per the repo-core contract", async () => {
    await inRequest(async () => {
      const cache = requestScopedCache();
      await cache?.set("a", 1);
      await cache?.set("b", 2);
      await cache?.delete("a");
      expect(await cache?.get("a")).toBeUndefined();
      expect(await cache?.get("b")).toBe(2);
      await cache?.clear?.();
      expect(await cache?.get("b")).toBeUndefined();
    });
  });
});

describe("requestScopedCache — isolation is the whole point", () => {
  it("does NOT share entries between two sequential requests", async () => {
    await inRequest(async () => {
      await requestScopedCache()?.set("order:1", { total: 100 });
    });
    await inRequest(async () => {
      // A process-lifetime cache would hand over the previous request's order
      // here, and nothing downstream could tell.
      expect(await requestScopedCache()?.get("order:1")).toBeUndefined();
    });
  });

  it("does NOT share entries between INTERLEAVED concurrent requests", async () => {
    // The realistic shape: two placements in flight at once. Sequential
    // isolation can pass on a store that is merely reset per request; only
    // interleaving proves each request has its OWN store.
    const started: Array<() => void> = [];
    const gate = new Promise<void>((r) => started.push(r));

    const requestA = inRequest(async () => {
      await requestScopedCache()?.set("shared-key", "A");
      await gate; // yield to B mid-request
      return await requestScopedCache()?.get("shared-key");
    });

    const requestB = inRequest(async () => {
      await requestScopedCache()?.set("shared-key", "B");
      started[0]?.();
      return await requestScopedCache()?.get("shared-key");
    });

    expect(await requestA).toBe("A");
    expect(await requestB).toBe("B");
  });

  it("survives the async boundaries a real handler crosses", async () => {
    // ALS propagates across await points; if it did not, a handler would get a
    // fresh (or absent) cache halfway through and silently stop caching.
    await inRequest(async () => {
      const before = requestScopedCache();
      await new Promise((r) => setTimeout(r, 1));
      await Promise.resolve();
      expect(requestScopedCache()).toBe(before);
    });
  });
});

/**
 * The bound. Unbounded was correct while a scope meant one HTTP request: the
 * store died in milliseconds and was bounded by what one request touched.
 * 2.40 extended scopes to job runs, and `schedulesPlugin` wraps the WHOLE
 * handler in one — so a nightly sweep over a million rows holds a single cache
 * for the duration. The lifetime the old design ruled out now happens.
 *
 * Evicting is always safe here because this is a cache: a miss costs the
 * re-read it was avoiding, nothing more. Growing without limit does not have
 * that property.
 */
describe("requestScopedCache — bounded for long-lived scopes", () => {
  const MAX_ENTRIES = 10_000;

  it("keeps every entry below the cap", async () => {
    await inRequest(async () => {
      const cache = requestScopedCache();
      for (let i = 0; i < MAX_ENTRIES; i++) await cache?.set(`k${i}`, i);
      expect(await cache?.get("k0")).toBe(0);
      expect(await cache?.get(`k${MAX_ENTRIES - 1}`)).toBe(MAX_ENTRIES - 1);
    });
  });

  it("evicts rather than growing forever once the cap is passed", async () => {
    await inRequest(async () => {
      const cache = requestScopedCache();
      // One past the cap: the least recently used key must be gone, and the
      // newest must be present. A store that kept both is unbounded.
      for (let i = 0; i < MAX_ENTRIES + 1; i++) await cache?.set(`k${i}`, i);
      expect(await cache?.get("k0")).toBeUndefined();
      expect(await cache?.get(`k${MAX_ENTRIES}`)).toBe(MAX_ENTRIES);
    });
  });

  it("evicts LEAST-RECENTLY-USED, not oldest-written", async () => {
    await inRequest(async () => {
      const cache = requestScopedCache();
      for (let i = 0; i < MAX_ENTRIES; i++) await cache?.set(`k${i}`, i);

      // Touch the oldest key — a job looping over a hot row must not lose it
      // just because it was written first.
      expect(await cache?.get("k0")).toBe(0);
      await cache?.set("overflow", "x");

      expect(await cache?.get("k0")).toBe(0); // rescued by the read
      expect(await cache?.get("k1")).toBeUndefined(); // now the LRU victim
    });
  });

  it("an overwrite refreshes recency instead of leaving a stale slot", async () => {
    await inRequest(async () => {
      const cache = requestScopedCache();
      for (let i = 0; i < MAX_ENTRIES; i++) await cache?.set(`k${i}`, i);

      await cache?.set("k0", "rewritten");
      await cache?.set("overflow", "x");

      expect(await cache?.get("k0")).toBe("rewritten");
      expect(await cache?.get("k1")).toBeUndefined();
    });
  });

  it("a scope well under the cap is untouched — no eviction on the normal path", async () => {
    await inRequest(async () => {
      const cache = requestScopedCache();
      for (let i = 0; i < 50; i++) await cache?.set(`k${i}`, i);
      for (let i = 0; i < 50; i++) expect(await cache?.get(`k${i}`)).toBe(i);
    });
  });
});
