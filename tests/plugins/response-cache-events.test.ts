/**
 * Response Cache Event Invalidation Tests
 *
 * Tests event-driven cache invalidation in the response-cache plugin.
 * Validates that CRUD domain events (e.g., product.created) properly
 * invalidate cached responses, including cross-resource patterns.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import { responseCachePlugin } from "../../src/plugins/response-cache.js";

describe("Response Cache Event Invalidation", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it("invalidates cache on CRUD event when eventInvalidation is true", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(responseCachePlugin, {
      defaultTTL: 60,
      eventInvalidation: true,
    });

    app.get(
      "/products",
      {
        preHandler: [app.responseCache.middleware],
      },
      async () => {
        return { success: true, data: [{ _id: "1" }] };
      },
    );

    await app.ready();

    // First request -- cache MISS
    const res1 = await app.inject({ method: "GET", url: "/products" });
    expect(res1.headers["x-cache"]).toBe("MISS");

    // Second request -- cache HIT
    const res2 = await app.inject({ method: "GET", url: "/products" });
    expect(res2.headers["x-cache"]).toBe("HIT");

    // Publish a CRUD event to invalidate the cache
    await app.events.publish("product.created", { _id: "2", name: "New" });

    // Allow event handler to process
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Third request -- should be MISS because cache was invalidated
    const res3 = await app.inject({ method: "GET", url: "/products" });
    expect(res3.headers["x-cache"]).toBe("MISS");
  });

  it("supports cross-resource invalidation patterns", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(responseCachePlugin, {
      defaultTTL: 60,
      eventInvalidation: {
        patterns: { "order.*": ["/products"] },
      },
    });

    app.get(
      "/products",
      {
        preHandler: [app.responseCache.middleware],
      },
      async () => {
        return { success: true, data: [{ _id: "1" }] };
      },
    );

    await app.ready();

    // Warm the cache
    await app.inject({ method: "GET", url: "/products" });
    const hitRes = await app.inject({ method: "GET", url: "/products" });
    expect(hitRes.headers["x-cache"]).toBe("HIT");

    // Publish an order event that should invalidate /products via pattern
    await app.events.publish("order.created", { _id: "o1" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    // /products should be MISS now
    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.headers["x-cache"]).toBe("MISS");
  });

  it("does not invalidate cache when eventInvalidation is not set", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(responseCachePlugin, {
      defaultTTL: 60,
      // eventInvalidation not set -- defaults to disabled
    });

    app.get(
      "/products",
      {
        preHandler: [app.responseCache.middleware],
      },
      async () => {
        return { success: true, data: [{ _id: "1" }] };
      },
    );

    await app.ready();

    // Warm the cache
    await app.inject({ method: "GET", url: "/products" });
    const hitRes = await app.inject({ method: "GET", url: "/products" });
    expect(hitRes.headers["x-cache"]).toBe("HIT");

    // Publish a CRUD event
    await app.events.publish("product.created", { _id: "2" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Should still be a HIT because event invalidation is disabled
    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.headers["x-cache"]).toBe("HIT");
  });

  it("non-CRUD events do not invalidate cache", async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.register(responseCachePlugin, {
      defaultTTL: 60,
      eventInvalidation: true,
    });

    app.get(
      "/products",
      {
        preHandler: [app.responseCache.middleware],
      },
      async () => {
        return { success: true, data: [{ _id: "1" }] };
      },
    );

    await app.ready();

    // Warm the cache
    await app.inject({ method: "GET", url: "/products" });
    const hitRes = await app.inject({ method: "GET", url: "/products" });
    expect(hitRes.headers["x-cache"]).toBe("HIT");

    // Publish a non-CRUD event (system.started is not created/updated/deleted)
    await app.events.publish("system.started", { timestamp: new Date().toISOString() });

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Should still be a HIT because 'started' is not a CRUD action
    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.headers["x-cache"]).toBe("HIT");
  });
});
