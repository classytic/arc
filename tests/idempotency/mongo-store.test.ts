/**
 * MongoIdempotencyStore tests
 *
 * Uses mongodb-memory-server for a real Mongo backend.
 * Covers the first-lock acquisition bug (fresh key returned false)
 * and the full lock/set/get/unlock lifecycle.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoIdempotencyStore } from "../../src/idempotency/stores/mongodb.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let store: MongoIdempotencyStore;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  store = new MongoIdempotencyStore({
    connection: { db: client.db("test-idemp") },
    collection: "idemp_keys",
    createIndex: true,
    ttlMs: 60_000,
  });
  // Wait a tick for fire-and-forget index creation
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(async () => {
  await client?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  // Clear collection between tests
  await client.db("test-idemp").collection("idemp_keys").deleteMany({});
});

// ============================================================================
// First-lock acquisition — the reported bug
// ============================================================================

describe("MongoIdempotencyStore — first-lock acquisition", () => {
  it("tryLock returns true for a brand-new key (upsert path)", async () => {
    const locked = await store.tryLock("fresh-key-1", "req-1", 10_000);
    expect(locked).toBe(true);
  });

  it("tryLock returns false for an already-locked key (conflict path)", async () => {
    await store.tryLock("key-2", "req-A", 10_000);
    const second = await store.tryLock("key-2", "req-B", 10_000);
    expect(second).toBe(false);
  });

  it("tryLock succeeds after lock expires", async () => {
    await store.tryLock("key-3", "req-A", 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 20));
    const reclaimed = await store.tryLock("key-3", "req-B", 10_000);
    expect(reclaimed).toBe(true);
  });
});

// ============================================================================
// Full lifecycle: lock → set → get → replay
// ============================================================================

describe("MongoIdempotencyStore — lifecycle", () => {
  it("stores and retrieves a cached result", async () => {
    const locked = await store.tryLock("lifecycle-1", "req-1", 10_000);
    expect(locked).toBe(true);

    await store.set("lifecycle-1", {
      statusCode: 201,
      headers: { "x-custom": "value" },
      body: { orderId: "abc" },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const cached = await store.get("lifecycle-1");
    expect(cached).toBeDefined();
    expect(cached?.statusCode).toBe(201);
    expect(cached?.body).toEqual({ orderId: "abc" });
    expect(cached?.headers["x-custom"]).toBe("value");
  });

  it("second request with same key gets cached result (replay)", async () => {
    // First request
    await store.tryLock("replay-1", "req-1", 10_000);
    await store.set("replay-1", {
      statusCode: 200,
      headers: {},
      body: { total: 42 },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Second request — should get cached
    const cached = await store.get("replay-1");
    expect(cached).toBeDefined();
    expect(cached?.statusCode).toBe(200);
    expect(cached?.body).toEqual({ total: 42 });
  });

  it("get returns undefined for non-existent key", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeUndefined();
  });

  it("get returns undefined for expired entry", async () => {
    await store.tryLock("expired-1", "req-1", 10_000);
    await store.set("expired-1", {
      statusCode: 200,
      headers: {},
      body: {},
      createdAt: new Date(),
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    const result = await store.get("expired-1");
    expect(result).toBeUndefined();
  });
});

// ============================================================================
// Lock and unlock
// ============================================================================

describe("MongoIdempotencyStore — lock management", () => {
  it("isLocked returns true for active lock", async () => {
    await store.tryLock("lock-1", "req-1", 10_000);
    expect(await store.isLocked("lock-1")).toBe(true);
  });

  it("isLocked returns false after unlock", async () => {
    await store.tryLock("lock-2", "req-1", 10_000);
    await store.unlock("lock-2", "req-1");
    expect(await store.isLocked("lock-2")).toBe(false);
  });

  it("unlock by wrong requestId does not release lock", async () => {
    await store.tryLock("lock-3", "req-A", 10_000);
    await store.unlock("lock-3", "req-B"); // wrong owner
    expect(await store.isLocked("lock-3")).toBe(true);
  });

  it("isLocked returns false for non-existent key", async () => {
    expect(await store.isLocked("no-such-key")).toBe(false);
  });
});

// ============================================================================
// Delete and prefix operations
// ============================================================================

describe("MongoIdempotencyStore — delete operations", () => {
  it("delete removes a specific key", async () => {
    await store.tryLock("del-1", "req-1", 10_000);
    await store.set("del-1", {
      statusCode: 200,
      headers: {},
      body: {},
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await store.delete("del-1");
    expect(await store.get("del-1")).toBeUndefined();
  });

  it("deleteByPrefix removes matching keys", async () => {
    for (const suffix of ["a", "b", "c"]) {
      await store.tryLock(`prefix-test:${suffix}`, `req-${suffix}`, 10_000);
      await store.set(`prefix-test:${suffix}`, {
        statusCode: 200,
        headers: {},
        body: {},
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
    }

    const deleted = await store.deleteByPrefix("prefix-test:");
    expect(deleted).toBe(3);
  });

  it("findByPrefix returns first matching cached result", async () => {
    await store.tryLock("find:x", "req-1", 10_000);
    await store.set("find:x", {
      statusCode: 200,
      headers: {},
      body: { found: true },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await store.findByPrefix("find:");
    expect(result).toBeDefined();
    expect(result?.body).toEqual({ found: true });
  });

  it("findByPrefix returns undefined when no match", async () => {
    const result = await store.findByPrefix("no-match:");
    expect(result).toBeUndefined();
  });
});

// ============================================================================
// Error handling — infrastructure errors must NOT collapse into 409
// ============================================================================

describe("MongoIdempotencyStore — error handling", () => {
  it("tryLock returns false for E11000 duplicate key (genuine contention)", async () => {
    // First lock succeeds
    const first = await store.tryLock("race-1", "req-A", 10_000);
    expect(first).toBe(true);

    // Concurrent lock attempt on same key — returns false (not throw)
    const second = await store.tryLock("race-1", "req-B", 10_000);
    expect(second).toBe(false);
  });

  it("tryLock THROWS for non-contention errors (not false)", async () => {
    // Create a store with a broken collection that throws a non-E11000 error
    const brokenDb = {
      collection: () => ({
        findOne: async () => null,
        insertOne: async () => ({ acknowledged: true }),
        updateOne: async () => {
          const err = new Error("Authentication failed") as Error & { code: number };
          err.code = 18; // Mongo auth error
          throw err;
        },
        deleteOne: async () => ({ deletedCount: 0 }),
        deleteMany: async () => ({ deletedCount: 0 }),
        createIndex: async () => "ok",
      }),
    };

    const brokenStore = new MongoIdempotencyStore({
      connection: { db: brokenDb } as unknown as { db: { collection(name: string): unknown } },
      createIndex: false,
    });

    // Should throw the auth error, NOT return false
    await expect(brokenStore.tryLock("key", "req", 10_000)).rejects.toThrow("Authentication failed");
  });

  it("tryLock THROWS for write concern errors", async () => {
    const wcErrorDb = {
      collection: () => ({
        findOne: async () => null,
        insertOne: async () => ({ acknowledged: true }),
        updateOne: async () => {
          const err = new Error("Write concern timeout") as Error & { code: number };
          err.code = 64; // WriteConcernFailed
          throw err;
        },
        deleteOne: async () => ({ deletedCount: 0 }),
        deleteMany: async () => ({ deletedCount: 0 }),
        createIndex: async () => "ok",
      }),
    };

    const wcStore = new MongoIdempotencyStore({
      connection: { db: wcErrorDb } as unknown as { db: { collection(name: string): unknown } },
      createIndex: false,
    });

    await expect(wcStore.tryLock("key", "req", 10_000)).rejects.toThrow("Write concern");
  });
});

// ============================================================================
// ensureIndex — transient failures must be retried
// ============================================================================

describe("MongoIdempotencyStore — index creation", () => {
  it("same instance retries index creation on next write after transient startup failure", async () => {
    let createIndexCalls = 0;
    const flakyDb = {
      collection: () => ({
        findOne: async () => null,
        insertOne: async () => ({ acknowledged: true }),
        updateOne: async () => ({
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 1,
        }),
        deleteOne: async () => ({ deletedCount: 0 }),
        deleteMany: async () => ({ deletedCount: 0 }),
        createIndex: async () => {
          createIndexCalls++;
          if (createIndexCalls === 1) throw new Error("ECONNREFUSED");
          return "ok";
        },
      }),
    };

    const singleStore = new MongoIdempotencyStore({
      connection: { db: flakyDb } as unknown as {
        db: { collection(name: string): unknown };
      },
      createIndex: true,
    });
    // Constructor fire-and-forget fails
    await new Promise((r) => setTimeout(r, 20));
    expect(createIndexCalls).toBe(1);

    // Same instance — tryLock triggers lazy retry of ensureIndex
    await singleStore.tryLock("key-1", "req-1", 10_000);
    expect(createIndexCalls).toBe(2); // Retried and succeeded

    // Third call should NOT retry (indexCreated is now true)
    await singleStore.tryLock("key-2", "req-2", 10_000);
    expect(createIndexCalls).toBe(2); // No retry
  });

  it("same instance retries from set() path too", async () => {
    let createIndexCalls = 0;
    const flakyDb = {
      collection: () => ({
        findOne: async () => null,
        insertOne: async () => ({ acknowledged: true }),
        updateOne: async () => ({
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: 1,
        }),
        deleteOne: async () => ({ deletedCount: 0 }),
        deleteMany: async () => ({ deletedCount: 0 }),
        createIndex: async () => {
          createIndexCalls++;
          if (createIndexCalls === 1) throw new Error("ECONNREFUSED");
          return "ok";
        },
      }),
    };

    const s = new MongoIdempotencyStore({
      connection: { db: flakyDb } as unknown as {
        db: { collection(name: string): unknown };
      },
      createIndex: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(createIndexCalls).toBe(1); // Failed

    await s.set("k", {
      statusCode: 200,
      headers: {},
      body: {},
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(createIndexCalls).toBe(2); // Retried from set()
  });

  it("marks index as created on code 85 (IndexOptionsConflict = already exists)", async () => {
    let createIndexCalls = 0;
    const conflictDb = {
      collection: () => ({
        findOne: async () => null,
        insertOne: async () => ({ acknowledged: true }),
        updateOne: async () => ({
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 1,
        }),
        deleteOne: async () => ({ deletedCount: 0 }),
        deleteMany: async () => ({ deletedCount: 0 }),
        createIndex: async () => {
          createIndexCalls++;
          const err = new Error("Index already exists") as Error & { code: number };
          err.code = 85;
          throw err;
        },
      }),
    };

    const s = new MongoIdempotencyStore({
      connection: { db: conflictDb } as unknown as {
        db: { collection(name: string): unknown };
      },
      createIndex: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(createIndexCalls).toBe(1);

    // Should NOT retry — code 85 is treated as success
    await s.tryLock("k", "r", 10_000);
    expect(createIndexCalls).toBe(1);
  });
});

// ============================================================================
// Real TTL cleanup — proves Mongo actually deletes expired docs
// ============================================================================

describe("MongoIdempotencyStore — TTL expiry (real Mongo)", () => {
  let ttlMongod: MongoMemoryServer;
  let ttlClient: MongoClient;

  beforeAll(async () => {
    // Start mongod with aggressive TTL monitor (1s instead of default 60s)
    ttlMongod = await MongoMemoryServer.create({
      instance: { args: ["--setParameter", "ttlMonitorSleepSecs=1"] },
    });
    ttlClient = await MongoClient.connect(ttlMongod.getUri());
  });

  afterAll(async () => {
    await ttlClient?.close();
    await ttlMongod?.stop();
  });

  it("expired doc is removed by Mongo TTL monitor", async () => {
    const db = ttlClient.db("ttl-test");
    const col = db.collection("idemp_ttl");

    const ttlStore = new MongoIdempotencyStore({
      connection: { db },
      collection: "idemp_ttl",
      createIndex: true,
      ttlMs: 1_000, // 1 second
      logger: { warn: () => {} },
    });

    // Wait for index creation
    await new Promise((r) => setTimeout(r, 200));

    // Lock + store a result with 1s TTL
    await ttlStore.tryLock("ttl-key-1", "req-1", 10_000);
    await ttlStore.set("ttl-key-1", {
      statusCode: 200,
      headers: {},
      body: { cached: true },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1_000), // expires in 1s
    });

    // Verify doc exists
    const before = await col.findOne({ _id: "ttl-key-1" });
    expect(before).not.toBeNull();

    // Wait for TTL monitor to run (sleepSecs=1, so 3s is safe)
    await new Promise((r) => setTimeout(r, 3_000));

    // Doc should be gone — removed by Mongo's TTL monitor
    const after = await col.findOne({ _id: "ttl-key-1" });
    expect(after).toBeNull();
  }, 10_000); // 10s timeout for this test
});

// ============================================================================
// Plugin + Mongo regression — non-E11000 must NOT become 409
// ============================================================================

describe("idempotencyPlugin + MongoIdempotencyStore — error propagation", () => {
  it("Mongo auth error surfaces as 500, not 409", async () => {
    const Fastify = (await import("fastify")).default;
    const { idempotencyPlugin } = await import("../../src/idempotency/idempotencyPlugin.js");

    // Real MongoIdempotencyStore with a collection that throws auth error on updateOne
    let firstCall = true;
    const brokenDb = {
      collection: () => ({
        findOne: async () => null,
        insertOne: async () => ({ acknowledged: true }),
        updateOne: async () => {
          if (firstCall) {
            firstCall = false;
            const err = new Error("not authorized on db") as Error & { code: number };
            err.code = 13; // Mongo Unauthorized
            throw err;
          }
          return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        },
        deleteOne: async () => ({ deletedCount: 0 }),
        deleteMany: async () => ({ deletedCount: 0 }),
        createIndex: async () => "ok",
      }),
    };

    const mongoStore = new MongoIdempotencyStore({
      connection: { db: brokenDb } as unknown as { db: { collection(name: string): unknown } },
      createIndex: false,
      logger: { warn: () => {} },
    });

    const app = Fastify({ logger: false });
    await app.register(idempotencyPlugin, {
      enabled: true,
      store: mongoStore,
    });

    app.post("/test", {
      preHandler: [app.idempotency.middleware],
    }, async () => ({ ok: true }));

    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/test",
      headers: { "idempotency-key": "mongo-auth-err" },
    });

    // Must be 500 (auth error), NOT 409 (conflict)
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});
