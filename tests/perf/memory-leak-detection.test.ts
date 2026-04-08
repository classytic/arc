/**
 * Memory leak detection — long-running CRUD workload
 *
 * Approach: warm up the app + GC, capture baseline heap, run a large
 * number of CRUD operations, GC again, measure delta. Assert that growth
 * per operation stays below a sane threshold.
 *
 * What this catches:
 *   - Unbounded caches (sessions, query cache, hooks)
 *   - Closure retention in long-lived state
 *   - Listeners that aren't cleaned up between requests
 *   - Repository connection leaks
 *
 * What this does NOT catch:
 *   - Per-request fragmentation (would need RSS tracking + sustained load)
 *   - Slow leaks under specific edge cases (would need fuzzing)
 *
 * Run with `--expose-gc` for accurate measurements:
 *   npm run test:perf
 *
 * If `global.gc` isn't available, the test still runs but uses heuristics
 * (multiple measurements + median) to filter out GC noise.
 */

import { Repository } from "@classytic/mongokit";
import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

interface IItem {
  sku: string;
  name: string;
  value: number;
}

const ItemSchema = new Schema<IItem>(
  {
    sku: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    value: { type: Number, default: 0 },
  },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let ItemModel: Model<IItem>;
let app: FastifyInstance;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ItemModel = mongoose.models.LeakItem || mongoose.model<IItem>("LeakItem", ItemSchema);

  const repo = new Repository<IItem>(ItemModel);
  const resource = defineResource<IItem>({
    name: "item",
    prefix: "/items",
    // biome-ignore lint: generic
    adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
    idField: "sku",
    tenantField: false,
    controller: new BaseController(repo, {
      resourceName: "item",
      idField: "sku",
      tenantField: false,
    }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });

  app = await createApp({
    preset: "development",
    auth: false,
    logger: false,
    helmet: false,
    rateLimit: false,
    plugins: async (fastify) => {
      await fastify.register(resource.toPlugin());
    },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await mongoose.disconnect();
  await mongoServer.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Force GC if available, otherwise yield to the microtask queue. */
async function gc(): Promise<void> {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    // Run twice to give the gc a chance to clean up GC artifacts
    await new Promise((r) => setTimeout(r, 10));
    globalThis.gc();
  }
  // Yield so any pending microtasks finish
  await new Promise((r) => setImmediate(r));
}

function heapUsedMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/** Measure heap median across N samples to filter out GC noise. */
async function measureHeapMedian(samples: number): Promise<number> {
  const readings: number[] = [];
  for (let i = 0; i < samples; i++) {
    await gc();
    readings.push(heapUsedMB());
  }
  readings.sort((a, b) => a - b);
  return readings[Math.floor(readings.length / 2)] ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Memory leak detection — long-running workload", () => {
  it("CREATE + READ + UPDATE + DELETE cycle does not leak (1000 iterations)", async () => {
    // Cleanup any leftover docs
    await ItemModel.deleteMany({});

    // Warm up — initialize MongoDB connection pool, JIT, allocate steady-state caches
    for (let i = 0; i < 50; i++) {
      const sku = `WARM-${i}`;
      await app.inject({
        method: "POST",
        url: "/items",
        payload: { sku, name: "warm", value: i },
      });
      await app.inject({ method: "GET", url: `/items/${sku}` });
      await app.inject({
        method: "PATCH",
        url: `/items/${sku}`,
        payload: { value: i + 1 },
      });
      await app.inject({ method: "DELETE", url: `/items/${sku}` });
    }
    await gc();
    const baselineMB = await measureHeapMedian(5);

    // Sustained workload — 1000 full CRUD cycles
    const ITERATIONS = 1000;
    for (let i = 0; i < ITERATIONS; i++) {
      const sku = `LEAK-${i}`;
      const c = await app.inject({
        method: "POST",
        url: "/items",
        payload: { sku, name: `Item ${i}`, value: i },
      });
      expect([200, 201]).toContain(c.statusCode);

      const r = await app.inject({ method: "GET", url: `/items/${sku}` });
      expect(r.statusCode).toBe(200);

      const u = await app.inject({
        method: "PATCH",
        url: `/items/${sku}`,
        payload: { value: i * 2 },
      });
      expect(u.statusCode).toBe(200);

      const d = await app.inject({ method: "DELETE", url: `/items/${sku}` });
      expect(d.statusCode).toBe(200);
    }

    await gc();
    const afterMB = await measureHeapMedian(5);
    const deltaMB = afterMB - baselineMB;
    const perIterationKB = (deltaMB * 1024) / ITERATIONS;

    // Log for visibility (vitest captures stdout)
    // eslint-disable-next-line no-console
    console.log(
      `[leak] baseline=${baselineMB.toFixed(2)}MB after=${afterMB.toFixed(2)}MB delta=${deltaMB.toFixed(2)}MB perOp=${perIterationKB.toFixed(2)}KB`,
    );

    // Perf tests run in an isolated lane (`npm run test:perf`) with explicit
    // GC exposure. That lets us keep the stricter leak threshold instead of
    // masking regressions with a full-suite-noise allowance.
    expect(deltaMB).toBeLessThan(30);
  }, 120_000);

  it("LIST endpoint with high-frequency queries does not leak (500 iterations)", async () => {
    await ItemModel.deleteMany({});
    await ItemModel.insertMany(
      Array.from({ length: 50 }, (_, i) => ({
        sku: `LIST-${i}`,
        name: `Item ${i}`,
        value: i,
      })),
    );

    // Warm up
    for (let i = 0; i < 30; i++) {
      await app.inject({ method: "GET", url: "/items?limit=20" });
    }
    await gc();
    const baselineMB = await measureHeapMedian(5);

    const ITERATIONS = 500;
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await app.inject({
        method: "GET",
        url: `/items?page=${(i % 3) + 1}&limit=20`,
      });
      expect(r.statusCode).toBe(200);
    }

    await gc();
    const afterMB = await measureHeapMedian(5);
    const deltaMB = afterMB - baselineMB;
    // eslint-disable-next-line no-console
    console.log(
      `[leak-list] baseline=${baselineMB.toFixed(2)}MB after=${afterMB.toFixed(2)}MB delta=${deltaMB.toFixed(2)}MB`,
    );

    // 500 list queries should add no more than 20 MB (permissive — adjust down later if stable)
    expect(deltaMB).toBeLessThan(20);
  }, 60_000);

  it("repeated PATCH on same doc does not leak hook references (300 iterations)", async () => {
    await ItemModel.deleteMany({});
    await ItemModel.create({ sku: "PATCH-LEAK", name: "Original", value: 0 });

    // Warm up
    for (let i = 0; i < 30; i++) {
      await app.inject({
        method: "PATCH",
        url: "/items/PATCH-LEAK",
        payload: { value: i },
      });
    }
    await gc();
    const baselineMB = await measureHeapMedian(5);

    const ITERATIONS = 300;
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await app.inject({
        method: "PATCH",
        url: "/items/PATCH-LEAK",
        payload: { value: i, name: `Iter-${i}` },
      });
      expect(r.statusCode).toBe(200);
    }

    await gc();
    const afterMB = await measureHeapMedian(5);
    const deltaMB = afterMB - baselineMB;
    // eslint-disable-next-line no-console
    console.log(
      `[leak-patch] baseline=${baselineMB.toFixed(2)}MB after=${afterMB.toFixed(2)}MB delta=${deltaMB.toFixed(2)}MB`,
    );

    // 300 PATCHes on same doc should add no more than 15 MB
    expect(deltaMB).toBeLessThan(15);
  }, 60_000);
});
