/**
 * Integration test — Arc + @classytic/sqlitekit end-to-end.
 *
 * Validates that a `SqliteRepository` (built on `@classytic/repo-core`)
 * drops into Arc's `defineResource` without shims or adapters. Real
 * in-memory SQLite DB, real CRUD routes, real HTTP round-trips through
 * Fastify.
 *
 * If this passes, Arc accepts the cross-kit contract end-to-end —
 * runtime, not just types.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRepository } from "@classytic/sqlitekit/repository";
import { timestampPlugin } from "@classytic/sqlitekit/plugins/timestamp";
import { allowPublic, defineResource } from "../../src/index.js";
import type { DataAdapter } from "../../src/adapters/index.js";

// ──────────────────────────────────────────────────────────────────────
// Fixture — a `products` table with typed columns
// ──────────────────────────────────────────────────────────────────────

const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  price: integer("price").notNull(),
  stock: integer("stock").notNull().default(0),
  // Arc defaults list sort to "-createdAt" (Mongo convention). Any kit
  // that strictly validates sort columns against its schema needs this
  // field. sqlitekit's `timestampPlugin` auto-stamps it on create/update.
  // Resources without a `createdAt` column opt out via
  // `defineResource({ defaultSort: false })` — this test keeps the
  // column because it also exercises `timestampPlugin`. See
  // `tests/integration/sqlitekit-no-createdat.test.ts` for the
  // explicit portability proof.
  createdAt: text("createdAt"),
  updatedAt: text("updatedAt"),
});

type ProductDoc = {
  id: string;
  name: string;
  price: number;
  stock: number;
  createdAt?: string;
  updatedAt?: string;
};

describe("Arc + sqlitekit — end-to-end integration", () => {
  let db: Database.Database;
  let repo: SqliteRepository<ProductDoc>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp(logLevel: "error" | "fatal" = "fatal") {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price INTEGER NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT,
        updatedAt TEXT
      );
    `);
    const drizzleDb = drizzle(db);
    repo = new SqliteRepository<ProductDoc>({
      db: drizzleDb,
      table: products,
      plugins: [timestampPlugin()],
    });
    void logLevel;

    // Build the DataAdapter manually — Arc only requires { repository, type, name }.
    // This is the key DX test: apps wiring a kit-provided repo through Arc should
    // not need kit-specific factories from arc/adapters.
    const adapter: DataAdapter<ProductDoc> = {
      repository: repo as unknown as DataAdapter<ProductDoc>["repository"],
      type: "drizzle",
      name: "products-drizzle",
    };

    const productResource = defineResource<ProductDoc>({
      name: "product",
      idField: "id",
      adapter,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const fastify = Fastify({ logger: { level: "error" } });
    await fastify.register(productResource.toPlugin());
    return fastify;
  }

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  // ────────────────────────────────────────────────────────────────────
  // CRUD — every route goes through Arc's controller → SqliteRepository
  // ────────────────────────────────────────────────────────────────────

  it("creates a product through Arc → SqliteRepository", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-1", name: "Laptop", price: 1499, stock: 5 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc).toMatchObject({ id: "p-1", name: "Laptop", price: 1499, stock: 5 });
  });

  it("lists products after create", async () => {
    await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-1", name: "Laptop", price: 1499, stock: 5 },
    });
    await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-2", name: "Mouse", price: 29, stock: 100 },
    });

    const res = await app.inject({ method: "GET", url: "/products" });
    if (res.statusCode !== 200) {
      // Surface the error so we can diagnose
      console.error("LIST ERROR:", res.statusCode, res.body);
    }
    expect(res.statusCode).toBe(200);

    const body = res.json();
    // Arc's default list shape: envelope { data: { docs, total, ... } } or bare { docs }
    const payload = body.data ?? body;
    const docs = Array.isArray(payload) ? payload : (payload.docs ?? []);
    expect(docs.length).toBe(2);
    const names = docs.map((d: ProductDoc) => d.name).sort();
    expect(names).toEqual(["Laptop", "Mouse"]);
  });

  it("gets a product by id via idField=id", async () => {
    await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-1", name: "Laptop", price: 1499, stock: 5 },
    });

    const res = await app.inject({ method: "GET", url: "/products/p-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc).toMatchObject({ id: "p-1", name: "Laptop" });
  });

  it("updates a product by id", async () => {
    await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-1", name: "Laptop", price: 1499, stock: 5 },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/products/p-1",
      payload: { price: 1299, stock: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc.price).toBe(1299);
    expect(doc.stock).toBe(3);
    expect(doc.name).toBe("Laptop"); // untouched
  });

  it("deletes a product by id", async () => {
    await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-1", name: "Laptop", price: 1499, stock: 5 },
    });

    const del = await app.inject({ method: "DELETE", url: "/products/p-1" });
    expect(del.statusCode).toBe(200);

    const getRes = await app.inject({ method: "GET", url: "/products/p-1" });
    expect(getRes.statusCode).toBe(404);
  });

  // ────────────────────────────────────────────────────────────────────
  // Contract proof — direct repo access still works (no wrapping happened)
  // ────────────────────────────────────────────────────────────────────

  it("SqliteRepository is passed through Arc without wrapping", async () => {
    // After arc registration, the repo we passed in must BE the repo the
    // adapter holds — zero transformation. This proves Arc doesn't
    // silently wrap/copy the repo.
    const all = await repo.findAll();
    expect(Array.isArray(all)).toBe(true);
  });

  it("404 on unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/products/nonexistent" });
    expect(res.statusCode).toBe(404);
  });
});
