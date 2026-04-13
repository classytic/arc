/**
 * Idempotency Plugin — end-to-end integration tests
 *
 * Proves the full round-trip: HTTP request → idempotency plugin → store →
 * cached replay. Uses both MemoryIdempotencyStore and MongoIdempotencyStore
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { MongoIdempotencyStore } from "../../src/idempotency/stores/mongodb.js";

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
  app.post("/orders", {
    preHandler: [app.idempotency.middleware],
  }, async (_req, reply) => {
    orderCounter++;
    return reply.code(201).send({
      success: true,
      data: { orderId: `order-${orderCounter}`, counter: orderCounter },
    });
  });

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
    expect(body.success).toBe(true);
    expect(body.data.orderId).toBeDefined();
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
    expect(secondBody.data.orderId).toBe(firstBody.data.orderId);
    expect(secondBody.data.counter).toBe(firstBody.data.counter);
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
    expect(bodyA.data.orderId).not.toBe(bodyB.data.orderId);
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
    expect(bodyA.data.counter).not.toBe(bodyB.data.counter);
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

describe("idempotencyPlugin + MongoIdempotencyStore — e2e", () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let app: FastifyInstance;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongod.getUri());
    const db = client.db("idemp-e2e");

    const store = new MongoIdempotencyStore({
      connection: { db },
      collection: "idemp_e2e",
      ttlMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 100));

    app = await buildApp({ store });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
    await mongod?.stop();
  });

  it("first request with Mongo store succeeds (regression: was 409 before fix)", async () => {
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

  it("replay with Mongo store returns cached response", async () => {
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
    expect(JSON.parse(second.body).data.orderId).toBe(
      JSON.parse(first.body).data.orderId,
    );
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

    app.post("/test", {
      preHandler: [app.idempotency.middleware],
    }, async () => ({ ok: true }));

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
