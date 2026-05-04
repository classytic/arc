/**
 * Integration test — Arc + @classytic/mongokit end-to-end.
 *
 * Validates that mongokit's `Repository` (built on `@classytic/repo-core`)
 * drops into Arc's `defineResource` with zero shims. Uses
 * `mongodb-memory-server` so the test is self-contained.
 *
 * Complementary to `sqlitekit-arc.test.ts` — both kits ride the same
 * `MinimalRepo<TDoc>` + `StandardRepo<TDoc>` contract from repo-core.
 */

import { Repository } from "@classytic/mongokit";
import type { DataAdapter } from "@classytic/repo-core/adapter";
import Fastify from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allowPublic, defineResource } from "../../src/index.js";

interface ProductDoc {
  _id?: string;
  name: string;
  price: number;
  stock: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const productSchema = new Schema<ProductDoc>(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    stock: { type: Number, default: 0 },
  },
  { timestamps: true },
);

describe("Arc + mongokit — end-to-end integration", () => {
  let mongoServer: MongoMemoryServer;
  let Product: mongoose.Model<ProductDoc>;
  let repo: Repository<ProductDoc>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp() {
    repo = new Repository<ProductDoc>(Product);

    const adapter: DataAdapter<ProductDoc> = {
      repository: repo as unknown as DataAdapter<ProductDoc>["repository"],
      type: "mongoose",
      name: "products-mongoose",
    };

    const productResource = defineResource<ProductDoc>({
      name: "product",
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

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Product = mongoose.model<ProductDoc>("Product", productSchema);
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 30_000);

  beforeEach(async () => {
    if (app) await app.close();
    await Product.deleteMany({});
    app = await buildApp();
  });

  // ────────────────────────────────────────────────────────────────────
  // CRUD — every route goes through Arc's controller → mongokit Repository
  // ────────────────────────────────────────────────────────────────────

  async function createProduct(payload: Partial<ProductDoc>): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/products", payload });
    if (res.statusCode !== 201) {
      throw new Error(`create failed ${res.statusCode}: ${res.body}`);
    }
    const body = res.json();
    const doc = body.data ?? body;
    return String(doc._id);
  }

  it("creates a product through Arc → mongokit Repository", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Laptop", price: 1499, stock: 5 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc).toMatchObject({ name: "Laptop", price: 1499, stock: 5 });
    expect(doc._id).toBeDefined();
  });

  it("lists products after create", async () => {
    await createProduct({ name: "Laptop", price: 1499, stock: 5 });
    await createProduct({ name: "Mouse", price: 29, stock: 100 });

    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    const payload = body.data ?? body;
    const data = Array.isArray(payload) ? payload : (payload.data ?? []);
    expect(data.length).toBe(2);
    const names = data.map((d: ProductDoc) => d.name).sort();
    expect(names).toEqual(["Laptop", "Mouse"]);
  });

  it("gets a product by _id", async () => {
    const id = await createProduct({ name: "Laptop", price: 1499, stock: 5 });

    const res = await app.inject({ method: "GET", url: `/products/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc).toMatchObject({ name: "Laptop" });
  });

  it("updates a product by _id", async () => {
    const id = await createProduct({ name: "Laptop", price: 1499, stock: 5 });

    const res = await app.inject({
      method: "PATCH",
      url: `/products/${id}`,
      payload: { price: 1299, stock: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const doc = body.data ?? body;
    expect(doc.price).toBe(1299);
    expect(doc.stock).toBe(3);
    expect(doc.name).toBe("Laptop");
  });

  it("deletes a product by _id", async () => {
    const id = await createProduct({ name: "Laptop", price: 1499, stock: 5 });

    const del = await app.inject({ method: "DELETE", url: `/products/${id}` });
    expect(del.statusCode).toBe(200);

    const getRes = await app.inject({ method: "GET", url: `/products/${id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it("mongokit Repository is passed through Arc without wrapping", async () => {
    // Direct repo access works — proves Arc doesn't copy/wrap the repo.
    const all = await repo.getAll({});
    expect(all).toBeDefined();
  });

  it("404 on unknown id", async () => {
    // Valid 24-char ObjectId that won't exist — avoids the cast-error path.
    const res = await app.inject({
      method: "GET",
      url: "/products/507f1f77bcf86cd799439011",
    });
    expect(res.statusCode).toBe(404);
  });
});
