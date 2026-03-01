import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { responseCachePlugin } from "../../src/plugins/response-cache.js";

describe("Response Cache - Stale-While-Revalidate Jitter Lock", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });

    // Register cache plugin with 30s default TTL
    await app.register(responseCachePlugin, {
      maxEntries: 100,
      defaultTTL: 30,
      invalidateOn: ["POST"],
      xCacheHeader: true,
    });

    let callCount = 0;

    // Simulate dummy route that caches
    app.get(
      "/api/products",
      {
        preHandler: [
          async (req, rep) => app.responseCache.middleware(req, rep),
        ],
      },
      async () => {
        callCount++;
        return { products: [], callCount };
      },
    );

    // Simulate mutation route that invalidates
    app.post("/api/products", async () => {
      return { created: true };
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("prevents caching immediately after an invalidation due to jitter lock", async () => {
    // 1. Initial request (MISS, should cache)
    const res1 = await app.inject({ method: "GET", url: "/api/products" });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers["x-cache"]).toBe("MISS");

    // 2. Second request (HIT)
    const res2 = await app.inject({ method: "GET", url: "/api/products" });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers["x-cache"]).toBe("HIT");

    // 3. Mutate (Invalidates and sets a jitter lock)
    // We expect jitter to be 1500ms since we made it the default in invalidatePrefix
    const res3 = await app.inject({ method: "POST", url: "/api/products" });
    expect(res3.statusCode).toBe(200);

    // 4. Request immediately after mutation (MISS, should NOT cache because of lock)
    const res4 = await app.inject({ method: "GET", url: "/api/products" });
    expect(res4.statusCode).toBe(200);
    expect(res4.headers["x-cache"]).toBe("MISS");

    // 5. Another request still immediately after (MISS, still shouldn't cache because lock is active)
    const res5 = await app.inject({ method: "GET", url: "/api/products" });
    expect(res5.statusCode).toBe(200);
    expect(res5.headers["x-cache"]).toBe("MISS");

    // 6. We manually override and wait for lock to clear (Simulate 1500ms passing)
    // For vitest tests without vi.advanceTimers, we just verify the state up to the lock.
  });
});
