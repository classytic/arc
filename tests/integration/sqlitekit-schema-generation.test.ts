/**
 * Integration — Arc DrizzleAdapter + sqlitekit schema generator.
 *
 * Proves the "swap kits" promise for the OpenAPI/validation path:
 *   drizzle table → sqlitekit `buildCrudSchemasFromTable` → arc OpenApiSchemas
 *                 → Fastify route validation (real AJV, real 400 on bad body)
 *
 * Paired with `sqlitekit-arc.test.ts` (CRUD round-trip) and
 * `mongokit-arc.test.ts` (mongoose equivalent). If this passes, the
 * schema-generation contract is kit-agnostic at runtime.
 */

import { createDrizzleAdapter } from "@classytic/sqlitekit/adapter";
import { timestampPlugin } from "@classytic/sqlitekit/plugins/timestamp";
import { SqliteRepository } from "@classytic/sqlitekit/repository";
import { buildCrudSchemasFromTable } from "@classytic/sqlitekit/schema/crud";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowPublic, defineResource } from "../../src/index.js";

// ──────────────────────────────────────────────────────────────────────
// Fixture
// ──────────────────────────────────────────────────────────────────────

const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  price: integer("price").notNull(),
  stock: integer("stock").notNull().default(0),
  status: text("status", { enum: ["active", "archived"] }).default("active"),
  createdAt: text("createdAt"),
  updatedAt: text("updatedAt"),
});

type ProductDoc = {
  id: string;
  name: string;
  price: number;
  stock: number;
  status?: "active" | "archived";
  createdAt?: string;
  updatedAt?: string;
};

describe("Arc DrizzleAdapter + sqlitekit schema generator — end-to-end", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  async function buildApp() {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price INTEGER NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        status TEXT DEFAULT 'active',
        createdAt TEXT,
        updatedAt TEXT
      );
    `);
    const drizzleDb = drizzle(db);
    const repo = new SqliteRepository<ProductDoc>({
      db: drizzleDb,
      table: products,
      plugins: [timestampPlugin()],
    });

    const adapter = createDrizzleAdapter<ProductDoc>({
      table: products,
      repository: repo,
      schemaGenerator: (table, opts) =>
        buildCrudSchemasFromTable(table as typeof products, opts ?? {}),
    });

    const resource = defineResource<ProductDoc>({
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
      // Ask arc to strictly validate so AJV rejects unknown / wrong-typed fields
      schemaOptions: {
        strictAdditionalProperties: true,
      },
    });

    // Opt into strict AJV so `additionalProperties: false` from the generated
    // createBody actually rejects (Fastify's default `removeAdditional: true`
    // silently strips instead of 400-ing).
    const fastify = Fastify({
      logger: false,
      ajv: { customOptions: { removeAdditional: false } },
    });
    await fastify.register(resource.toPlugin());
    await fastify.ready();
    return fastify;
  }

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  // ────────────────────────────────────────────────────────────────────
  // Schema shape
  // ────────────────────────────────────────────────────────────────────

  it("getSchemaMetadata() introspects all columns with correct types", async () => {
    const repo = new SqliteRepository<ProductDoc>({
      db: drizzle(db),
      table: products,
    });
    const adapter = createDrizzleAdapter<ProductDoc>({ table: products, repository: repo });
    const meta = adapter.getSchemaMetadata();

    expect(meta.fields.id).toMatchObject({ type: "string" });
    expect(meta.fields.name).toMatchObject({ type: "string", required: true });
    expect(meta.fields.price).toMatchObject({ type: "number", required: true });
    // stock has a default → not required in metadata
    expect(meta.fields.stock).toMatchObject({ type: "number", required: false });
    // status is an enum column
    expect(meta.fields.status?.enum).toEqual(["active", "archived"]);
    // primary key shows up as a unique single-field index
    expect(meta.indexes).toEqual(expect.arrayContaining([{ fields: ["id"], unique: true }]));
  });

  it("delegates to sqlitekit's buildCrudSchemasFromTable when wired", async () => {
    const repo = new SqliteRepository<ProductDoc>({
      db: drizzle(db),
      table: products,
    });
    const adapter = createDrizzleAdapter<ProductDoc>({
      table: products,
      repository: repo,
      schemaGenerator: (table, opts) =>
        buildCrudSchemasFromTable(table as typeof products, opts ?? {}),
    });

    const schemas = adapter.generateSchemas();
    expect(schemas).toBeTruthy();
    expect(schemas).toHaveProperty("createBody");
    expect(schemas).toHaveProperty("updateBody");
    expect(schemas).toHaveProperty("params");
    expect(schemas).toHaveProperty("listQuery");

    const createBody = (schemas as { createBody: { properties: Record<string, unknown> } })
      .createBody;
    // Drizzle column introspection should preserve the enum on `status`
    expect(createBody.properties.status).toMatchObject({ enum: ["active", "archived"] });
    // `price` should be required (notNull + no default)
    expect((schemas as { createBody: { required?: string[] } }).createBody.required).toContain(
      "price",
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // End-to-end: schema → Fastify validation
  // ────────────────────────────────────────────────────────────────────

  it("POST /products accepts a valid body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-1", name: "Laptop", price: 1499, stock: 5, status: "active" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("POST /products rejects wrong type on `price` (AJV integer validation)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-2", name: "Laptop", price: "not-a-number" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    // Fastify / AJV emits `price` / `must be integer` style errors
    expect(JSON.stringify(body)).toMatch(/price|integer|number/i);
  });

  it("POST /products rejects unknown enum value on `status`", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-3", name: "Laptop", price: 100, status: "retired" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /products rejects missing required field `name`", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-4", price: 100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /products rejects extra fields under strictAdditionalProperties", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-5", name: "Laptop", price: 100, bogus: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /products/:id accepts partial valid body", async () => {
    await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-6", name: "Laptop", price: 100 },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/products/p-6",
      payload: { price: 200 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect((body.data ?? body).price).toBe(200);
  });

  it("PATCH /products/:id rejects wrong-typed partial field", async () => {
    await app.inject({
      method: "POST",
      url: "/products",
      payload: { id: "p-7", name: "Laptop", price: 100 },
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/products/p-7",
      payload: { price: "oops" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ────────────────────────────────────────────────────────────────────
  // No schemaGenerator wired — adapter returns null (arc 2.12)
  // ────────────────────────────────────────────────────────────────────
  //
  // Arc 2.12 cut the built-in mongoose AND drizzle fallbacks: schema
  // generation belongs in the kit, not in arc core. Without a
  // `schemaGenerator` the adapter returns `null` so resource boot
  // doesn't crash, but no auto-OpenAPI is produced for that resource.
  // CLI scaffolds wire the kit generator automatically; hand-rolled
  // hosts must pass it explicitly.

  it("returns null when no schemaGenerator is wired (no built-in fallback in 2.12)", async () => {
    const repo = new SqliteRepository<ProductDoc>({
      db: drizzle(db),
      table: products,
    });
    const adapter = createDrizzleAdapter<ProductDoc>({
      table: products,
      repository: repo,
    });
    expect(adapter.generateSchemas()).toBeNull();
  });

  it("getSchemaMetadata still works without a schemaGenerator (arc-internal introspection)", async () => {
    // arc's own SchemaMetadata format (used by the introspection plugin /
    // registry) is distinct from OpenAPI and stays in arc — only the
    // OpenAPI fallback was cut. This test pins that boundary.
    const repo = new SqliteRepository<ProductDoc>({
      db: drizzle(db),
      table: products,
    });
    const adapter = createDrizzleAdapter<ProductDoc>({
      table: products,
      repository: repo,
    });
    const meta = adapter.getSchemaMetadata?.();
    expect(meta).toBeDefined();
    expect(meta?.fields).toBeDefined();
  });
});
