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
