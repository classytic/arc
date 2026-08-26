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
import {
  hasRequestScopedCache,
  requestScopedCache,
} from "../../src/context/requestScopedCache.js";

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
