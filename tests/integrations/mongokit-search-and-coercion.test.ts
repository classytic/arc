/**
 * MongoKit 3.5.5 — `searchMode` + schema-aware coercion integration with Arc
 *
 * Two pure-additive MongoKit features that should "just work" through Arc
 * with no Arc-side code changes. These tests pin that contract:
 *
 * 1. **`searchMode: 'auto'`** on Repository — when no text index exists, the
 *    repo automatically falls back to regex search across `searchFields`.
 *    This means `?search=foo` flowing through Arc → BaseController → MongoKit
 *    works against any collection, not only ones with text indexes.
 *
 * 2. **Schema-aware coercion** on QueryParser — passing `schema: Model.schema`
 *    to the parser causes filter values like `?stock=50` to coerce to a real
 *    `number` against the declared field type instead of the legacy heuristic.
 *    The coercion happens inside the parser; Arc just hands the parsed query
 *    to the controller, so the integration is verified by checking that
 *    numeric comparisons (`?stock[gte]=10`) actually return the right docs.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

interface Product {
  name: string;
  description: string;
  stock: number;
  price: number;
  active: boolean;
}

describe("MongoKit Repository searchMode integration via Arc", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    const ProductSchema = new mongoose.Schema<Product>(
      {
        name: { type: String, required: true },
        description: String,
        stock: { type: Number, default: 0 },
        price: { type: Number, default: 0 },
        active: { type: Boolean, default: true },
      },
      { timestamps: true },
    );
    // NOTE: deliberately NO text index — we want to prove `searchMode: 'auto'`
    // falls back to regex when no text index exists.

    const Product =
      (mongoose.models.SearchProduct as mongoose.Model<Product>) ||
      mongoose.model<Product>("SearchProduct", ProductSchema);

    await Product.deleteMany({});
    await Product.create([
      {
        name: "MacBook Pro",
        description: "Apple laptop with M3 chip",
        stock: 5,
        price: 2499,
        active: true,
      },
      {
        name: "iPad Air",
        description: "Apple tablet 11-inch",
        stock: 12,
        price: 599,
        active: true,
      },
      {
        name: "Dell XPS",
        description: "Windows laptop with OLED screen",
        stock: 3,
        price: 1899,
        active: true,
      },
      {
        name: "Kindle Paperwhite",
        description: "Amazon e-reader",
        stock: 0,
        price: 149,
        active: false,
      },
    ]);

    // Repository with searchMode: 'auto' + searchFields → regex fallback
    // because there's no text index on this collection.
    const productRepo = new Repository(
      Product,
      [],
      {},
      {
        searchMode: "auto",
        searchFields: ["name", "description"],
      },
    );

    const productResource = defineResource({
      name: "product",
      adapter: createMongooseAdapter({ model: Product, repository: productRepo }),
      controller: new BaseController(productRepo, {
        resourceName: "product",
        // No `search` field in allowedFilterFields — `search` is a top-level
        // pagination/search param, not a filter field. The repo handles it.
        queryParser: new QueryParser({
          allowedFilterFields: ["stock", "price", "active"],
          allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte", "in"],
        }),
        tenantField: false,
      }),
      queryParser: new QueryParser({
        allowedFilterFields: ["stock", "price", "active"],
        allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte", "in"],
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
      cors: false,
      rateLimit: false,
      underPressure: false,
      plugins: async (f) => {
        await f.register(productResource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("?search=apple uses regex fallback (no text index, no error)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/products?search=apple",
    });

    // Without searchMode: 'auto', this would have thrown "No text index found".
    // With auto → regex fallback against searchFields=['name','description'],
    // it returns the two Apple products.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Product[]; total: number };
    expect(body.total).toBe(2);
    const names = body.data.map((d) => d.name).sort();
    expect(names).toEqual(["MacBook Pro", "iPad Air"]);
  });

  it("?search=laptop matches description field via regex", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/products?search=laptop",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Product[]; total: number };
    // "Apple laptop with M3 chip" + "Windows laptop with OLED screen"
    expect(body.total).toBe(2);
    expect(body.data.map((d) => d.name).sort()).toEqual(["Dell XPS", "MacBook Pro"]);
  });

  it("?search=apple&stock[gte]=10 composes regex search with numeric filter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/products?search=apple&stock[gte]=10",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Product[]; total: number };
    // Apple products with stock >= 10: only iPad Air (stock 12)
    expect(body.total).toBe(1);
    expect(body.data[0]?.name).toBe("iPad Air");
  });
});

describe("MongoKit schema-aware value coercion via Arc", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Reuse the connection — second describe shares the same memory server
    if (mongoose.connection.readyState === 0) {
      await setupTestDatabase();
    }

    const InventorySchema = new mongoose.Schema(
      {
        sku: { type: String, required: true },
        stock: { type: Number, required: true },
        price: { type: Number, required: true },
        active: { type: Boolean, default: true },
      },
      { timestamps: true },
    );

    const Inventory =
      (mongoose.models.CoercionInventory as mongoose.Model<{
        sku: string;
        stock: number;
        price: number;
        active: boolean;
      }>) || mongoose.model("CoercionInventory", InventorySchema);

    await Inventory.deleteMany({});
    await Inventory.create([
      { sku: "ABC-001", stock: 5, price: 19.99, active: true },
      { sku: "ABC-002", stock: 50, price: 49.99, active: true },
      { sku: "ABC-003", stock: 100, price: 99.99, active: false },
      { sku: "ABC-004", stock: 200, price: 199.99, active: true },
    ]);

    const repo = new Repository(Inventory);

    // Pass `schema: Inventory.schema` to QueryParser → it builds a field-type
    // map from the schema and coerces filter values authoritatively.
    // Without this, `?stock=50` would parse as the string "50" via heuristic
    // and Mongoose would coerce it again at query time. With this, the parser
    // produces a number directly — single source of truth.
    const inventoryResource = defineResource({
      name: "inventory",
      // Arc's default prefix is `/${name}s` (no real pluralization), which would
      // give `/inventorys`. Set explicitly to match common URL convention.
      prefix: "/inventories",
      adapter: createMongooseAdapter({ model: Inventory, repository: repo }),
      controller: new BaseController(repo, {
        resourceName: "inventory",
        queryParser: new QueryParser({
          schema: Inventory.schema,
          allowedFilterFields: ["sku", "stock", "price", "active"],
          allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte", "in"],
        }),
        tenantField: false,
      }),
      queryParser: new QueryParser({
        schema: Inventory.schema,
        allowedFilterFields: ["sku", "stock", "price", "active"],
        allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte", "in"],
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
      cors: false,
      rateLimit: false,
      underPressure: false,
      plugins: async (f) => {
        await f.register(inventoryResource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    // Don't tear down the DB here — first describe may have left it active.
    // The vitest process will clean up at exit.
  });

  it("?stock=50 coerces to number against Number field", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventories?stock=50",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ sku: string; stock: number }>; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]?.sku).toBe("ABC-002");
    // Critical: the value coerced to a real JS number, not a string.
    expect(typeof body.data[0]?.stock).toBe("number");
  });

  it("?stock[gte]=50 numeric range works (coercion in operator path)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventories?stock[gte]=50",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ sku: string }>; total: number };
    // stock >= 50: ABC-002 (50), ABC-003 (100), ABC-004 (200)
    expect(body.total).toBe(3);
    expect(body.data.map((d) => d.sku).sort()).toEqual(["ABC-002", "ABC-003", "ABC-004"]);
  });

  it("?active=true coerces string to boolean against Boolean field", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventories?active=true",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ sku: string; active: boolean }>; total: number };
    expect(body.total).toBe(3);
    expect(body.data.every((d) => d.active === true)).toBe(true);
  });

  it("?price[lt]=100 numeric coercion in lt operator", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventories?price[lt]=100",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ sku: string; price: number }>; total: number };
    // price < 100: ABC-001 (19.99), ABC-002 (49.99), ABC-003 (99.99)
    expect(body.total).toBe(3);
    expect(body.data.every((d) => d.price < 100)).toBe(true);
  });

  it("?sku=ABC-001 stays a string against String field (no false numeric coercion)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventories?sku=ABC-001",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ sku: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]?.sku).toBe("ABC-001");
  });
});
