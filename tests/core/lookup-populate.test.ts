/**
 * Lookup & Populate Integration Tests
 *
 * Tests MongoKit 3.4 features through Arc's BaseController:
 * - Populate with select/match (refs)
 * - Lookup/join without refs ($lookup aggregation)
 * - allowedLookups security control
 * - allowedPopulate security control
 *
 * Uses in-memory MongoDB via mongodb-memory-server + MongoKit Repository.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { Repository, QueryParser } from "@classytic/mongokit";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ============================================================================
// Models — Category (ref-based) + Product (ref + slug-based join)
// ============================================================================

const CategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    // Ref-based: for populate
    category: { type: mongoose.Schema.Types.ObjectId, ref: "LookupCategory" },
    // String-based: for $lookup join (no ref)
    categorySlug: { type: String },
    status: { type: String, default: "active" },
  },
  { timestamps: true },
);

// ============================================================================
// Repositories
// ============================================================================

let CategoryModel: mongoose.Model<any>;
let ProductModel: mongoose.Model<any>;
let productRepo: Repository<any>;

function setupModels() {
  CategoryModel =
    mongoose.models.LookupCategory ||
    mongoose.model("LookupCategory", CategorySchema);
  ProductModel =
    mongoose.models.LookupProduct ||
    mongoose.model("LookupProduct", ProductSchema);

  productRepo = new Repository(ProductModel);
}

// ============================================================================
// Test Setup
// ============================================================================

let app: FastifyInstance;

beforeAll(async () => {
  await setupTestDatabase();
  setupModels();
});

afterAll(async () => {
  if (app) await app.close();
  await teardownTestDatabase();
});

beforeEach(async () => {
  await CategoryModel.deleteMany({});
  await ProductModel.deleteMany({});
});

// Helper to create app with a resource
async function createTestAppWithResource(resourceOptions: Record<string, any> = {}) {
  if (app) await app.close();

  const queryParser = new QueryParser();

  const productResource = defineResource({
    name: "lookup-product",
    adapter: createMongooseAdapter({
      model: ProductModel,
      repository: productRepo,
    }),
    queryParser,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    ...resourceOptions,
  });

  // Must use qs parser for nested bracket notation (?lookup[cat][from]=...)
  // This matches what createApp() does in production.
  const qs = await import("qs");
  app = Fastify({
    querystringParser: (str: string) => qs.default.parse(str),
  });
  // Decorate for Arc routes
  app.decorate("authenticate", async () => {});
  app.decorate("optionalAuthenticate", async () => {});
  app.decorate("authorize", () => async () => {});

  await app.register(productResource.toPlugin());
  await app.ready();
  return app;
}

// Helper to seed test data
async function seedData() {
  const electronics = await CategoryModel.create({
    name: "Electronics",
    slug: "electronics",
  });
  const clothing = await CategoryModel.create({
    name: "Clothing",
    slug: "clothing",
    isActive: false,
  });

  const phone = await ProductModel.create({
    name: "Phone",
    price: 999,
    category: electronics._id,
    categorySlug: "electronics",
    status: "active",
  });
  const laptop = await ProductModel.create({
    name: "Laptop",
    price: 1999,
    category: electronics._id,
    categorySlug: "electronics",
    status: "active",
  });
  const shirt = await ProductModel.create({
    name: "Shirt",
    price: 29,
    category: clothing._id,
    categorySlug: "clothing",
    status: "draft",
  });

  return { electronics, clothing, phone, laptop, shirt };
}

// ============================================================================
// Populate Tests (ref-based — Mongoose .populate())
// ============================================================================

describe("Populate with select (ref-based)", () => {
  beforeAll(async () => {
    await createTestAppWithResource({
      schemaOptions: {
        query: { allowedPopulate: ["category"] },
      },
    });
  });

  it("should populate category with all fields", async () => {
    const { phone } = await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products/${phone._id}?populate=category`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.category).toBeDefined();
    expect(body.data.category.name).toBe("Electronics");
    expect(body.data.category.slug).toBe("electronics");
  });

  it("should populate category with select (only name)", async () => {
    const { phone } = await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products/${phone._id}?populate[category][select]=name`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.category).toBeDefined();
    expect(body.data.category.name).toBe("Electronics");
    // slug should NOT be included when only 'name' is selected
    expect(body.data.category.slug).toBeUndefined();
  });

  it("should populate on list endpoint", async () => {
    await seedData();

    const res = await app.inject({
      method: "GET",
      url: "/lookup-products?populate=category",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.docs.length).toBe(3);
    // At least one should have populated category
    const withCategory = body.docs.find(
      (d: any) => d.category && typeof d.category === "object",
    );
    expect(withCategory).toBeDefined();
    expect(withCategory.category.name).toBeDefined();
  });

  it("should block populate for non-allowed paths", async () => {
    await seedData();

    const res = await app.inject({
      method: "GET",
      url: "/lookup-products?populate=secret_field",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Should return data but without populated secret_field
    expect(body.docs.length).toBe(3);
  });
});

// ============================================================================
// Lookup Tests ($lookup — no refs, join by slug/code)
// ============================================================================

describe("Lookup/join (no refs — $lookup aggregation)", () => {
  beforeAll(async () => {
    await createTestAppWithResource({
      schemaOptions: {
        query: {
          allowedPopulate: ["category"],
          allowedLookups: ["lookupcategories"],
        },
      },
    });
  });

  it("should join categories by slug via $lookup", async () => {
    await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products?lookup[cat][from]=lookupcategories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.docs.length).toBe(3);

    // Each product should have joined category data
    const phone = body.docs.find((d: any) => d.name === "Phone");
    expect(phone.cat).toBeDefined();
    expect(phone.cat.name).toBe("Electronics");
  });

  it("should support select on lookup (only bring specific fields)", async () => {
    await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products?lookup[cat][from]=lookupcategories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true&lookup[cat][select]=name`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const phone = body.docs.find((d: any) => d.name === "Phone");
    expect(phone.cat).toBeDefined();
    expect(phone.cat.name).toBe("Electronics");
    // slug should NOT be in the result when only 'name' is selected
    expect(phone.cat.slug).toBeUndefined();
  });

  it("should combine lookup with select that includes localField", async () => {
    await seedData();

    // When using select + lookup, the localField MUST be in select for $lookup to work
    const res = await app.inject({
      method: "GET",
      url: `/lookup-products?lookup[cat][from]=lookupcategories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true&lookup[cat][select]=name`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.docs.length).toBeGreaterThan(0);
    // Docs should have the joined category data
    const phone = body.docs.find((d: any) => d.name === "Phone");
    expect(phone.cat).toBeDefined();
    expect(phone.cat.name).toBe("Electronics");
    // Lookup select should limit the joined fields
    expect(phone.cat.slug).toBeUndefined();
  });

  it("should block lookup for non-allowed collections", async () => {
    await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products?lookup[secret][from]=users&lookup[secret][localField]=userId&lookup[secret][foreignField]=_id&lookup[secret][single]=true`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Should return data but without the lookup
    expect(body.docs.length).toBe(3);
    const phone = body.docs.find((d: any) => d.name === "Phone");
    expect(phone.secret).toBeUndefined();
  });
});

// ============================================================================
// No allowedLookups restriction (open)
// ============================================================================

describe("Lookup without allowedLookups (unrestricted)", () => {
  beforeAll(async () => {
    await createTestAppWithResource({
      // No allowedLookups — all lookups allowed
      schemaOptions: {},
    });
  });

  it("should allow any lookup when allowedLookups is not set", async () => {
    await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products?lookup[cat][from]=lookupcategories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const phone = body.docs.find((d: any) => d.name === "Phone");
    expect(phone.cat).toBeDefined();
    expect(phone.cat.name).toBe("Electronics");
  });
});

// ============================================================================
// Sorting, filtering + lookup combined
// ============================================================================

describe("Lookup combined with sort and filter", () => {
  beforeAll(async () => {
    await createTestAppWithResource({ schemaOptions: {} });
  });

  it("should filter + sort + lookup in single query", async () => {
    await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products?status=active&sort=-price&lookup[cat][from]=lookupcategories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Only active products (Phone and Laptop), sorted by price desc
    expect(body.docs.length).toBe(2);
    expect(body.docs[0].name).toBe("Laptop"); // 1999 first
    expect(body.docs[1].name).toBe("Phone"); // 999 second
    // Both should have lookup data
    expect(body.docs[0].cat.name).toBe("Electronics");
  });

  it("should paginate with lookup", async () => {
    await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products?limit=2&page=1&lookup[cat][from]=lookupcategories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.docs.length).toBeLessThanOrEqual(2);
    expect(body.total).toBe(3);
  });
});

// ============================================================================
// Root select + lookup combined
// ============================================================================

describe("Root select + lookup combined", () => {
  beforeAll(async () => {
    await createTestAppWithResource({ schemaOptions: {} });
  });

  it("should apply root select and still join via lookup", async () => {
    await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products?select=name,price,categorySlug&lookup[cat][from]=lookupcategories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.docs.length).toBe(3);
    const phone = body.docs.find((d: any) => d.name === "Phone");
    expect(phone).toBeDefined();
    expect(phone.name).toBe("Phone");
    expect(phone.price).toBe(999);
    // Fixed in MongoKit 3.4.1: lookup aliases are auto-included in $project
    expect(phone.cat).toBeDefined();
    expect(phone.cat.name).toBe("Electronics");
  });

  it("should not break when select excludes localField", async () => {
    await seedData();

    // select=name,price does NOT include categorySlug — lookup may not resolve
    // This should still return 200 (not crash), lookup just won't match
    const res = await app.inject({
      method: "GET",
      url: `/lookup-products?select=name,price&lookup[cat][from]=lookupcategories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.docs.length).toBe(3);
  });
});

// ============================================================================
// Keyset (cursor) pagination + lookup
// ============================================================================

describe("Keyset pagination + lookup", () => {
  beforeAll(async () => {
    await createTestAppWithResource({ schemaOptions: {} });
  });

  it("should work with offset pagination and lookup", async () => {
    await seedData();

    // Page 1
    const page1 = await app.inject({
      method: "GET",
      url: `/lookup-products?limit=2&page=1&sort=-price&lookup[cat][from]=lookupcategories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true`,
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.docs.length).toBe(2);
    expect(body1.total).toBe(3);
    expect(body1.hasNext).toBe(true);
    // First page should have Laptop (1999) and Phone (999)
    expect(body1.docs[0].name).toBe("Laptop");
    expect(body1.docs[0].cat).toBeDefined();
    expect(body1.docs[0].cat.name).toBe("Electronics");

    // Page 2
    const page2 = await app.inject({
      method: "GET",
      url: `/lookup-products?limit=2&page=2&sort=-price&lookup[cat][from]=lookupcategories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true`,
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    expect(body2.docs.length).toBe(1);
    expect(body2.hasNext).toBe(false);
    expect(body2.docs[0].name).toBe("Shirt");
    expect(body2.docs[0].cat).toBeDefined();
    expect(body2.docs[0].cat.name).toBe("Clothing");
  });

  it("should work without lookup (standard offset pagination)", async () => {
    await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products?limit=2&page=1&sort=-price`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.docs.length).toBe(2);
    expect(body.total).toBe(3);
    expect(body.docs[0].name).toBe("Laptop");
  });

  it("should work with keyset (cursor) pagination", async () => {
    await seedData();

    const page1 = await app.inject({
      method: "GET",
      url: `/lookup-products?limit=2&sort=price`,
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.docs.length).toBe(2);

    // Use last doc's _id as cursor for next page
    const cursor = body1.docs[body1.docs.length - 1]._id;
    const page2 = await app.inject({
      method: "GET",
      url: `/lookup-products?limit=2&after=${cursor}&sort=price`,
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    expect(body2.docs.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Field selection on populate (limit/sort on populated)
// ============================================================================

describe("Advanced populate options", () => {
  beforeAll(async () => {
    await createTestAppWithResource({
      schemaOptions: {
        query: { allowedPopulate: ["category"] },
      },
    });
  });

  it("should exclude fields from populate with -prefix", async () => {
    const { phone } = await seedData();

    const res = await app.inject({
      method: "GET",
      url: `/lookup-products/${phone._id}?populate[category][select]=-isActive,-__v`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.category).toBeDefined();
    expect(body.data.category.name).toBe("Electronics");
    // isActive should be excluded
    expect(body.data.category.isActive).toBeUndefined();
  });
});
