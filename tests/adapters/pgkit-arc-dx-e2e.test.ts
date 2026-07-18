/**
 * pgkit × arc — runtime DX integration probe (real Postgres semantics)
 *
 * The Postgres counterpart of `mongokit-arc-dx-e2e.test.ts`: a pgkit
 * `PgRepository` over PGlite (in-process WASM Postgres — no server, no
 * native compilation, CI-cheap) wired through `createPgAdapter` →
 * `defineResource` → `createApp` serves real CRUD requests.
 *
 * What this catches that the type probe can't:
 *
 *   1. End-to-end HTTP round-trip on real PG16 semantics — RETURNING
 *      clauses, unique violations, ILIKE filters.
 *   2. Filter wiring — arc's query parsing → repo `getAll({ filters })`
 *      → pgkit's Filter compiler → SQL WHERE.
 *   3. Feature detection — pgkit implements the StandardRepo surface
 *      (findOneAndUpdate, deleteMany, getOne) arc plugins reach for.
 *   4. repo-core version skew — pgkit builds against repo-core 0.14;
 *      this file runs it on whatever arc has installed, so a missing
 *      runtime API fails HERE before any host hits it.
 */

import { PGlite } from "@electric-sql/pglite";
import { PgRepository } from "@classytic/pgkit";
import { createPgAdapter } from "@classytic/pgkit/adapter";
import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

// ============================================================================
// Domain model — what a real Postgres host would write
// ============================================================================

interface Product {
  id: string;
  name: string;
  sku: string;
  price: number;
  category: "electronics" | "books" | "food";
  inStock: boolean;
  createdAt: string;
}

const products = pgTable("products", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  name: text("name").notNull(),
  sku: text("sku").notNull().unique(),
  price: integer("price").notNull(),
  category: text("category", { enum: ["electronics", "books", "food"] }).notNull(),
  inStock: boolean("inStock").notNull().default(true),
  createdAt: text("createdAt").notNull().default(""),
});

const DDL = `
create table "products" (
  "id" text primary key default gen_random_uuid()::text,
  "name" text not null,
  "sku" text not null unique,
  "price" integer not null,
  "category" text not null,
  "inStock" boolean not null default true,
  "createdAt" text not null default ''
);
`;

let client: PGlite;
let app: FastifyInstance;
let repo: PgRepository<Product>;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(DDL);
  const db = drizzle(client);

  repo = new PgRepository<Product>({
    db,
    table: products,
    defaultSort: "-createdAt",
  });

  const resource = defineResource({
    name: "product",
    prefix: "/products",
    adapter: createPgAdapter({ table: products, repository: repo }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });

  app = await createApp({
    preset: "testing",
    auth: false,
    logger: false,
    plugins: async (f) => {
      await f.register(resource.toPlugin());
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await client?.close();
});

// ============================================================================
// 1. Zero-friction wiring — the happy path every Postgres host walks
// ============================================================================

describe("pgkit → arc — zero-friction wiring (PGlite)", () => {
  it("POST /products creates via pgkit RETURNING and returns the row", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: {
        name: "Laptop Pro",
        sku: "LP-001",
        price: 1299,
        category: "electronics",
        createdAt: "2026-01-01",
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(200);
    expect(res.statusCode).toBeLessThan(300);
    const body = JSON.parse(res.body);
    expect(body.sku).toBe("LP-001");
    expect(body.price).toBe(1299);
    expect(typeof body.id).toBe("string"); // pg default gen_random_uuid()
  });

  it("GET /products lists via pgkit with the pagination envelope", async () => {
    await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Book", sku: "BK-001", price: 20, category: "books", createdAt: "2026-01-02" },
    });

    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.page).toBe("number");
    expect(typeof body.limit).toBe("number");
  });

  it("GET /products?category=books filters through pgkit's Filter compiler", async () => {
    const res = await app.inject({ method: "GET", url: "/products?category=books" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
    const categories = (body.data as Array<{ category: string }>).map((d) => d.category);
    expect(categories.every((c) => c === "books")).toBe(true);
  });

  it("GET /products/:id returns a single row", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Food", sku: "FD-001", price: 10, category: "food", createdAt: "2026-01-03" },
    });
    const id = JSON.parse(createRes.body).id;

    const res = await app.inject({ method: "GET", url: `/products/${id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).sku).toBe("FD-001");
  });

  it("PATCH /products/:id updates partially via pgkit", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Patch Target", sku: "PT-001", price: 50, category: "electronics", createdAt: "2026-01-04" },
    });
    const id = JSON.parse(createRes.body).id;

    const res = await app.inject({ method: "PATCH", url: `/products/${id}`, payload: { price: 75 } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.price).toBe(75);
    expect(body.sku).toBe("PT-001"); // partial-update semantics
  });

  it("DELETE /products/:id removes the row; subsequent GET 404s", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Gone", sku: "GN-001", price: 5, category: "food", createdAt: "2026-01-05" },
    });
    const id = JSON.parse(createRes.body).id;

    expect((await app.inject({ method: "DELETE", url: `/products/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/products/${id}` })).statusCode).toBe(404);
  });
});

// ============================================================================
// 2. Feature detection — pgkit exposes the StandardRepo optionals arc reaches for
// ============================================================================

describe("pgkit × arc — feature detection of StandardRepo optionals", () => {
  it("pgkit's PgRepository satisfies MinimalRepo + the optionals arc plugins detect", () => {
    expect(typeof repo.create).toBe("function");
    expect(typeof repo.getById).toBe("function");
    expect(typeof repo.getAll).toBe("function");
    expect(typeof repo.update).toBe("function");
    expect(typeof repo.delete).toBe("function");

    // StandardRepo extensions: auditPlugin → findAll; idempotencyPlugin →
    // getOne + deleteMany + findOneAndUpdate; EventOutbox → all of those.
    expect(typeof (repo as unknown as { findAll?: unknown }).findAll).toBe("function");
    expect(typeof (repo as unknown as { getOne?: unknown }).getOne).toBe("function");
    expect(typeof (repo as unknown as { findOneAndUpdate?: unknown }).findOneAndUpdate).toBe(
      "function",
    );
    expect(typeof (repo as unknown as { deleteMany?: unknown }).deleteMany).toBe("function");
  });

  it("unique violations classify as duplicate-key (Postgres 23505)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Dup", sku: "DUP-001", price: 1, category: "food", createdAt: "2026-01-06" },
    });
    expect(first.statusCode).toBeLessThan(300);

    const dup = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Dup2", sku: "DUP-001", price: 2, category: "food", createdAt: "2026-01-07" },
    });
    // Must be a clean client error (409/400 family), never a 500 crash.
    expect(dup.statusCode).toBeGreaterThanOrEqual(400);
    expect(dup.statusCode).toBeLessThan(500);
  });
});
