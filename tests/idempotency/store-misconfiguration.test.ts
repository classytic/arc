/**
 * Idempotency store misconfiguration — the filter-stripping failure mode.
 *
 * Live incident (2026-08-14, be-prod): the idempotency repository's Mongoose
 * schema declared NO paths (`new Schema({}, { strict: false, _id: false })`)
 * while the host set `mongoose.set('strictQuery', true)` globally. strictQuery
 * strips filter keys that aren't schema paths — with zero declared paths that
 * is EVERY key, so `getOne({ _id: fullKey })` became `getOne({})`. One shared
 * row absorbed every idempotency key, and every keyed request replayed the
 * most recent cached response across keys and users: an order-cancel response
 * was served as "success" for a different order that was never canceled.
 *
 * Pins the two-layer fix:
 *   1. plugin boot self-check (default on) — registration REFUSES a store
 *      that cannot round-trip a key;
 *   2. adapter identity checks — with the self-check disabled, every read
 *      that returns a cross-key document throws
 *      `IdempotencyStoreMisconfiguredError` instead of serving it;
 *   3. the documented-correct schema (`_id: String` + `strictQuery: false`)
 *      passes the self-check and round-trips normally under the same global
 *      strictQuery setting;
 *   4. MemoryIdempotencyStore passes the self-check (no regression).
 */

import {
  batchOperationsPlugin,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  Repository,
} from "@classytic/mongokit";
import Fastify from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import {
  IdempotencyStoreMisconfiguredError,
  repositoryAsIdempotencyStore,
} from "../../src/idempotency/repository-idempotency-adapter.js";
import { createIdempotencyResult } from "../../src/idempotency/stores/index.js";

let mongod: MongoMemoryServer;
let priorStrictQuery: boolean | "throw";

function buildRepo(schema: Schema, name: string): Repository<Record<string, unknown>> {
  const model = mongoose.model(name, schema, name.toLowerCase());
  return new Repository(model as never, [
    methodRegistryPlugin(),
    batchOperationsPlugin(),
    mongoOperationsPlugin(),
  ]);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  priorStrictQuery = mongoose.get("strictQuery");
  // The host-global setting that turned the pathless schema into a
  // filter-stripper. Applied here exactly as be-prod's db.connect.ts does.
  mongoose.set("strictQuery", true);
}, 120_000);

afterAll(async () => {
  mongoose.set("strictQuery", priorStrictQuery);
  await mongoose.disconnect();
  await mongod.stop();
}, 60_000);

describe("filter-stripping repository (pathless schema under strictQuery: true)", () => {
  it("plugin boot self-check REFUSES the store", async () => {
    const broken = buildRepo(
      new Schema({}, { strict: false, timestamps: false, _id: false }),
      "BrokenIdem1",
    );
    const app = Fastify({ logger: false });
    await expect(
      app.register(idempotencyPlugin, { enabled: true, repository: broken as never }),
    ).rejects.toThrow(
      /self-check|not applying the key filter|IDEMPOTENCY_STORE_MISCONFIGURED|strictQuery/i,
    );
    await app.close();
  });

  it("adapter identity check refuses a cross-key read (runtime backstop when selfCheck is off)", async () => {
    const broken = buildRepo(
      new Schema({}, { strict: false, timestamps: false, _id: false }),
      "BrokenIdem2",
    );
    const store = repositoryAsIdempotencyStore(broken as never, 60_000);
    // Seed one entry. On this broken repo the upsert filter is stripped, but
    // setOnInsert stamps the key on the inserted row — so KEY-A's own reads
    // still verify. The corruption surfaces on the CROSS-key read.
    await store.set("KEY-A", createIdempotencyResult(200, { order: "A" }, {}, 60_000));
    const own = await store.get("KEY-A");
    expect(own?.statusCode).toBe(200);
    // KEY-B's stripped filter matches KEY-A's row → identity check throws
    // instead of replaying A's response for B.
    await expect(store.get("KEY-B")).rejects.toBeInstanceOf(IdempotencyStoreMisconfiguredError);
  });
});

describe("correct schema (_id: String, strictQuery: false) under the same global setting", () => {
  it("passes the boot self-check and round-trips keys exactly", async () => {
    const healthy = buildRepo(
      new Schema({ _id: String }, { strict: false, strictQuery: false, timestamps: false }),
      "HealthyIdem1",
    );
    const app = Fastify({ logger: false });
    await app.register(idempotencyPlugin, { enabled: true, repository: healthy as never });
    const store = app.idempotency.store;
    expect(store).toBeDefined();
    if (!store) throw new Error("store missing");

    await store.set("RT-A", createIdempotencyResult(201, { order: "A" }, {}, 60_000));
    const hitA = await store.get("RT-A");
    expect(hitA?.statusCode).toBe(201);
    expect((hitA?.body as { order: string }).order).toBe("A");
    const missB = await store.get("RT-B");
    expect(missB).toBeUndefined();

    // Lock isolation across keys — the broken store collapsed this too.
    expect(await store.tryLock("LOCK-A", "req1", 30_000)).toBe(true);
    expect(await store.tryLock("LOCK-B", "req2", 30_000)).toBe(true);
    expect(await store.tryLock("LOCK-A", "req3", 30_000)).toBe(false);
    await app.close();
  });
});

describe("memory store", () => {
  it("passes the boot self-check (no regression)", async () => {
    const app = Fastify({ logger: false });
    await app.register(idempotencyPlugin, { enabled: true });
    expect(app.idempotency.store).toBeDefined();
    await app.close();
  });
});

describe("availability vs correctness (the two outcomes must not collapse)", () => {
  /**
   * Caught on the boot immediately after the self-check first shipped: a
   * mongoose connection that dropped mid-boot made the probe read return
   * nothing, and the plugin killed the whole app while reporting "the store
   * is not persisting or not filtering by key" — a false diagnosis, and a
   * hard dependency of BOOT on DB availability that this plugin never had
   * (it previously touched the store only on the first keyed request).
   *
   * An unreachable store says NOTHING about key filtering, so it must not
   * produce a correctness verdict. The adapter's per-read identity checks
   * remain the runtime backstop either way.
   */
  it("an UNREACHABLE store warns and boots (availability is not a correctness verdict)", async () => {
    const unreachable = {
      name: "unreachable",
      get: async () => {
        throw new Error("connection closed");
      },
      set: async () => {
        throw new Error("connection closed");
      },
      tryLock: async () => true,
      unlock: async () => {},
      isLocked: async () => false,
      delete: async () => {},
      deleteByPrefix: async () => 0,
      findByPrefix: async () => undefined,
    };
    const app = Fastify({ logger: false });
    await expect(
      app.register(idempotencyPlugin, { enabled: true, store: unreachable }),
    ).resolves.toBeDefined();
    expect(app.idempotency.store).toBeDefined();
    await app.close();
  });

  it("a store that silently drops writes warns and boots (ambiguous, not provably misconfigured)", async () => {
    // Every read misses. Indistinguishable from an unreachable store at boot
    // — so it degrades rather than asserting a filter-stripping verdict it
    // has not actually proven.
    const amnesiac = {
      name: "amnesiac",
      get: async () => undefined,
      set: async () => {},
      tryLock: async () => true,
      unlock: async () => {},
      isLocked: async () => false,
      delete: async () => {},
      deleteByPrefix: async () => 0,
      findByPrefix: async () => undefined,
    };
    const app = Fastify({ logger: false });
    await expect(
      app.register(idempotencyPlugin, { enabled: true, store: amnesiac }),
    ).resolves.toBeDefined();
    await app.close();
  });

  it("a CROSS-KEY hit still refuses to boot (the unambiguous violation)", async () => {
    // Returns the same entry for every key — the production failure mode,
    // provable from the probe alone.
    const crossKey = {
      name: "cross-key",
      get: async () => ({
        key: "whatever",
        statusCode: 299,
        headers: {},
        body: { probe: true },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
      set: async () => {},
      tryLock: async () => true,
      unlock: async () => {},
      isLocked: async () => false,
      delete: async () => {},
      deleteByPrefix: async () => 0,
      findByPrefix: async () => undefined,
    };
    const app = Fastify({ logger: false });
    await expect(
      app.register(idempotencyPlugin, { enabled: true, store: crossKey }),
    ).rejects.toThrow(/returned key A's entry|ignoring the key filter/i);
    await app.close();
  });
});
