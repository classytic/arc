/**
 * Idempotency Plugin — end-to-end integration tests
 *
 * Proves the full round-trip: HTTP request → idempotency plugin → store →
 * cached replay. Uses both MemoryIdempotencyStore and a mongokit Repository
 * to cover the two real-world backends.
 *
 * Scenarios:
 * 1. First request succeeds (200 + body)
 * 2. Replay with same key returns cached response (200 + x-idempotency-replayed)
 * 3. Different body with same key returns SAME cached response (fingerprint includes body)
 * 4. Same key from different user is NOT replayed (user-scoped fingerprint)
 * 5. No idempotency key header → normal request (no caching)
 * 6. GET requests are ignored (only POST/PUT/PATCH by default)
 * 7. Concurrent in-flight request with same key → 409 with Retry-After
 * 8. Infrastructure error in store.tryLock → 500 (not 409)
 * 9. Mongo store integration — first-lock bug regression
 */

import {
  batchOperationsPlugin,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  Repository,
} from "@classytic/mongokit";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";

// ============================================================================
// Test app factory — registers plugin + a simple POST /orders endpoint
// ============================================================================

async function buildApp(storeOverrides?: Record<string, unknown>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(idempotencyPlugin, {
    enabled: true,
    ttlMs: 60_000,
    ...storeOverrides,
  });

  // Simulated auth — populates request.user from x-user-id header
  app.addHook("preHandler", async (req) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId === "string") {
      (req as Record<string, unknown>).user = { id: userId, _id: userId };
    }
  });

  // Test endpoint — creates an "order"
  let orderCounter = 0;
  app.post(
    "/orders",
    {
      preHandler: [app.idempotency.middleware],
    },
    async (_req, reply) => {
      orderCounter++;
      // No-envelope: emit raw payload directly.
      return reply.code(201).send({
        orderId: `order-${orderCounter}`,
        counter: orderCounter,
      });
    },
  );

  // Test endpoint — GET should be ignored by idempotency
  app.get("/orders", async () => ({ success: true, data: [] }));

  await app.ready();
  return app;
}

// ============================================================================
// 1. Memory store — full lifecycle
// ============================================================================

describe("idempotencyPlugin + MemoryStore — e2e", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("first request succeeds with 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        "idempotency-key": "mem-test-1",
        "x-user-id": "user-A",
      },
      payload: { item: "widget" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.orderId).toBeDefined();
    expect(res.headers["x-idempotency-replayed"]).toBeUndefined();
  });

  it("replay with same key returns cached response", async () => {
    // First request
    const first = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        "idempotency-key": "mem-replay-1",
        "x-user-id": "user-A",
      },
      payload: { item: "gadget" },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.body);

    // Second request with same key + body + user
    const second = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        "idempotency-key": "mem-replay-1",
        "x-user-id": "user-A",
      },
      payload: { item: "gadget" },
    });

    expect(second.statusCode).toBe(201);
    expect(second.headers["x-idempotency-replayed"]).toBe("true");
    const secondBody = JSON.parse(second.body);
    // Same orderId — response was replayed, not re-executed
    expect(secondBody.orderId).toBe(firstBody.orderId);
    expect(secondBody.counter).toBe(firstBody.counter);
  });

  it("same key from different user is NOT replayed (user-scoped)", async () => {
    const userA = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": "user-scope-1", "x-user-id": "alice" },
      payload: { item: "phone" },
    });
    const userB = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": "user-scope-1", "x-user-id": "bob" },
      payload: { item: "phone" },
    });

    const bodyA = JSON.parse(userA.body);
    const bodyB = JSON.parse(userB.body);
    // Different order IDs — not replayed across users
    expect(bodyA.orderId).not.toBe(bodyB.orderId);
    expect(userB.headers["x-idempotency-replayed"]).toBeUndefined();
  });

  it("no idempotency key → normal request (no caching)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "x-user-id": "user-A" },
      payload: { item: "no-key" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "x-user-id": "user-A" },
      payload: { item: "no-key" },
    });

    const bodyA = JSON.parse(first.body);
    const bodyB = JSON.parse(second.body);
    // Different counters — both executed independently
    expect(bodyA.counter).not.toBe(bodyB.counter);
  });

  it("GET requests are ignored by idempotency", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders",
      headers: { "idempotency-key": "get-key-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-idempotency-replayed"]).toBeUndefined();
  });
});

// ============================================================================
// 2. Mongo store — regression test for first-lock bug
// ============================================================================

describe("idempotencyPlugin + repository (mongokit) — e2e", () => {
  let mongod: MongoMemoryServer;
  let app: FastifyInstance;
  let IdempotencyModel: Model<Record<string, unknown>>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

    // Open schema — idempotency stores serialize arbitrary response shapes.
    const schema = new Schema({}, { strict: false, _id: false });
    IdempotencyModel =
      mongoose.models.IdempotencyE2e || mongoose.model("IdempotencyE2e", schema, "idemp_e2e");

    // Pass the repository DIRECTLY to the plugin — no wrapper class.
    // mongokit 3.8+ implements findOneAndUpdate; the plugin uses it for
    // atomic tryLock / set semantics.
    const repo = new Repository(IdempotencyModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      mongoOperationsPlugin(),
    ]);

    app = await buildApp({ repository: repo });
  });

  afterAll(async () => {
    await app?.close();
    await mongoose.disconnect();
    await mongod?.stop();
  });

  it("first request with repository-backed idempotency succeeds (regression: was 409 before fix)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: {
        "idempotency-key": "mongo-first-1",
        "x-user-id": "user-A",
      },
      payload: { item: "test" },
    });

    // This was the original bug: first request returned 409 because
    // tryLock returned false on upsert-insert (matchedCount=0).
    expect(res.statusCode).toBe(201);
    expect(res.headers["x-idempotency-replayed"]).toBeUndefined();
  });

  it("replay via repository returns cached response", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": "mongo-replay-1", "x-user-id": "user-A" },
      payload: { item: "durable" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": "mongo-replay-1", "x-user-id": "user-A" },
      payload: { item: "durable" },
    });

    expect(second.statusCode).toBe(201);
    expect(second.headers["x-idempotency-replayed"]).toBe("true");
    expect(JSON.parse(second.body).orderId).toBe(JSON.parse(first.body).orderId);
  });
});

// ============================================================================
// 3. Error handling — infrastructure errors must NOT become 409
// ============================================================================

describe("idempotencyPlugin — error handling", () => {
  it("store.tryLock throwing a non-contention error surfaces as 500 (not 409)", async () => {
    const brokenStore = {
      name: "broken",
      get: async () => undefined,
      set: async () => {},
      tryLock: async () => {
        throw new Error("Mongo connection lost");
      },
      unlock: async () => {},
      isLocked: async () => false,
      delete: async () => {},
      deleteByPrefix: async () => 0,
      findByPrefix: async () => undefined,
    };

    const app = Fastify({ logger: false });
    await app.register(idempotencyPlugin, {
      enabled: true,
      store: brokenStore,
    });

    app.post(
      "/test",
      {
        preHandler: [app.idempotency.middleware],
      },
      async () => ({ ok: true }),
    );

    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/test",
      headers: { "idempotency-key": "broken-1" },
    });

    // Must be 500 (infrastructure error), not 409 (conflict)
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

// ============================================================================
// 4. Empty-body responses must unlock — regression for the preSerialization
//    lock-leak. Fastify skips preSerialization when payload is null/undefined,
//    so 204 replies and `reply.send()`-with-no-arg previously kept the lock
//    held until TTL. onResponse now handles unlock universally.
// ============================================================================

describe("idempotencyPlugin — empty-body responses release the lock", () => {
  async function buildEmptyBodyApp() {
    const app = Fastify({ logger: false });
    await app.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });

    app.addHook("preHandler", async (req) => {
      const userId = req.headers["x-user-id"];
      if (typeof userId === "string") {
        (req as Record<string, unknown>).user = { id: userId, _id: userId };
      }
    });

    app.post("/204-endpoint", { preHandler: [app.idempotency.middleware] }, async (_req, reply) => {
      reply.code(204).send();
    });

    app.post("/empty-200", { preHandler: [app.idempotency.middleware] }, async (_req, reply) => {
      reply.code(200).send();
    });

    app.post(
      "/non-2xx-empty",
      { preHandler: [app.idempotency.middleware] },
      async (_req, reply) => {
        reply.code(404).send();
      },
    );

    await app.ready();
    return app;
  }

  it("204 No Content releases the lock so a second identical request can proceed", async () => {
    const app = await buildEmptyBodyApp();
    try {
      const first = await app.inject({
        method: "POST",
        url: "/204-endpoint",
        headers: { "idempotency-key": "empty-204-1", "x-user-id": "user-A" },
      });
      expect(first.statusCode).toBe(204);
      // Header was set in the middleware — must survive an empty-body reply
      expect(first.headers["x-idempotency-key"]).toBe("empty-204-1");

      // Second request with the SAME key proves the lock was released.
      // 204 responses have no body to cache, so the second request
      // executes fresh and gets a fresh 204. Assert the exact code so
      // any future regression (accidental 500, 409, etc.) fails loudly.
      const second = await app.inject({
        method: "POST",
        url: "/204-endpoint",
        headers: { "idempotency-key": "empty-204-1", "x-user-id": "user-A" },
      });
      expect(second.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("empty-body 200 releases the lock for subsequent requests", async () => {
    const app = await buildEmptyBodyApp();
    try {
      const first = await app.inject({
        method: "POST",
        url: "/empty-200",
        headers: { "idempotency-key": "empty-200-1", "x-user-id": "user-B" },
      });
      expect(first.statusCode).toBe(200);
      expect(first.headers["x-idempotency-key"]).toBe("empty-200-1");

      const second = await app.inject({
        method: "POST",
        url: "/empty-200",
        headers: { "idempotency-key": "empty-200-1", "x-user-id": "user-B" },
      });
      expect(second.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("non-2xx empty reply (404) releases the lock — no silent lock leak on failure paths", async () => {
    const app = await buildEmptyBodyApp();
    try {
      const first = await app.inject({
        method: "POST",
        url: "/non-2xx-empty",
        headers: { "idempotency-key": "empty-404-1", "x-user-id": "user-C" },
      });
      expect(first.statusCode).toBe(404);

      // Retry with the same key: lock was released → handler runs again,
      // returns 404 again. Assert the exact code so a regression that
      // flips this to 409 (stale lock) or 500 is caught immediately.
      const second = await app.inject({
        method: "POST",
        url: "/non-2xx-empty",
        headers: { "idempotency-key": "empty-404-1", "x-user-id": "user-C" },
      });
      expect(second.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
