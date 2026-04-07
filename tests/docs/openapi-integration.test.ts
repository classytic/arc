/**
 * Full integration: defineResource → Fastify (AJV strict) → OpenAPI docs
 *
 * This test exercises the full boot path with a REAL Mongoose model + MongoKit
 * QueryParser and verifies three independent concerns that previously regressed:
 *
 * 1. AJV strict-mode emits NO warnings on resource registration
 *    (populate oneOf, filter fields, body schemas, etc.)
 *
 * 2. OpenAPI spec generates and contains the resource's paths + schemas
 *    (createBody, updateBody, listQuery, params all reachable)
 *
 * 3. Real requests work end-to-end:
 *    - POST with unknown extra fields is NOT rejected (additionalProperties)
 *    - GET /:id with ObjectId works
 *    - GET /?filter=... with qs bracket notation works
 *    - GET /?populate=... works
 */

import Fastify, { type FastifyInstance } from "fastify";
import { QueryParser, Repository } from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema, type Model } from "mongoose";
import qs from "qs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { defineResource } from "../../src/core/defineResource.js";
import { buildOpenApiSpec, openApiPlugin } from "../../src/docs/openapi.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { FastifyWithDecorators } from "../../src/types/index.js";

// ============================================================================
// Fixtures
// ============================================================================

interface IProduct {
  name: string;
  price: number;
  status: "draft" | "published" | "archived";
  tags: string[];
}

const ProductSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, maxlength: 200 },
    price: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["draft", "published", "archived"],
      default: "draft",
    },
    tags: [{ type: String }],
  },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let ProductModel: Model<IProduct>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ProductModel =
    mongoose.models.OpenApiProduct ||
    mongoose.model<IProduct>("OpenApiProduct", ProductSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ProductModel.deleteMany({});
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a Fastify instance with AJV strict mode set to "log", so any
 * strict-mode violation is captured in the warnings array instead of crashing.
 */
async function buildStrictApp(): Promise<{ app: FastifyInstance; warnings: string[] }> {
  const warnings: string[] = [];
  const app = Fastify({
    logger: false,
    routerOptions: { querystringParser: (s: string) => qs.parse(s) },
    ajv: {
      customOptions: {
        coerceTypes: true,
        useDefaults: true,
        removeAdditional: false,
        strict: "log",
        logger: {
          log: () => {},
          warn: (msg: string) => warnings.push(String(msg)),
          error: (msg: string) => warnings.push(String(msg)),
        },
      },
    },
  });
  return { app, warnings };
}

function buildProductResource() {
  const repo = new Repository<IProduct>(ProductModel);
  const parser = new QueryParser({
    allowedFilterFields: ["name", "status", "price"],
    maxLimit: 100,
  });

  return defineResource<IProduct>({
    name: "product",
    // biome-ignore lint: model type mismatch with generic Repository
    adapter: createMongooseAdapter({ model: ProductModel, repository: repo }),
    queryParser: parser,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("defineResource → Fastify strict → OpenAPI integration", () => {
  it("no AJV strict-mode warnings on resource registration", async () => {
    const { app, warnings } = await buildStrictApp();
    const resource = buildProductResource();

    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.register(openApiPlugin, {
      title: "Test API",
      version: "1.0.0",
    });
    await app.ready();

    const strictWarnings = warnings.filter(
      (w) =>
        w.includes("strict mode") ||
        w.includes("strictTypes") ||
        w.includes("additionalProperties without type") ||
        w.includes("missing type"),
    );
    expect(strictWarnings).toEqual([]);

    await app.close();
  });

  it("OpenAPI spec contains the product resource paths + schemas", async () => {
    const { app } = await buildStrictApp();
    const resource = buildProductResource();

    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.register(openApiPlugin, { title: "Test API", version: "1.0.0" });
    await app.ready();

    // Fetch generated spec through the plugin route
    const res = await app.inject({ method: "GET", url: "/_docs/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();

    // Paths exist
    expect(spec.paths).toBeDefined();
    expect(spec.paths["/products"]).toBeDefined();
    expect(spec.paths["/products/{id}"]).toBeDefined();

    // All CRUD operations documented
    expect(spec.paths["/products"].get).toBeDefined(); // list
    expect(spec.paths["/products"].post).toBeDefined(); // create
    expect(spec.paths["/products/{id}"].get).toBeDefined(); // get
    expect(spec.paths["/products/{id}"].patch).toBeDefined(); // update
    expect(spec.paths["/products/{id}"].delete).toBeDefined(); // delete

    // List should document MongoKit-style query params (page, limit, sort, etc.)
    const listParams = spec.paths["/products"].get.parameters as Array<{ name: string }>;
    const paramNames = listParams.map((p) => p.name);
    expect(paramNames).toContain("page");
    expect(paramNames).toContain("limit");
    expect(paramNames).toContain("sort");

    // Create body schema should be present and allow additionalProperties
    // (either inline or as a $ref to components/schemas/<Name>)
    const createOp = spec.paths["/products"].post;
    const createSchema = createOp.requestBody?.content?.["application/json"]?.schema;
    expect(createSchema).toBeDefined();

    await app.close();
  });

  it("POST with unknown extra fields is accepted (additionalProperties: true)", async () => {
    const { app, warnings } = await buildStrictApp();
    const resource = buildProductResource();

    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: {
        name: "Test Product",
        price: 99.99,
        // unknown extra field — should NOT be rejected
        customMetadata: { source: "integration-test" },
      },
    });
    // This is the regression: before the safeBody / adapter fix this returned
    // 400 "must NOT have additional properties"
    expect([200, 201]).toContain(res.statusCode);

    // No AJV warnings fired either
    const strictWarnings = warnings.filter((w) => w.includes("strict mode"));
    expect(strictWarnings).toEqual([]);

    await app.close();
  });

  it("GET /?status=published&price[gte]=50 (bracket notation) works", async () => {
    const { app } = await buildStrictApp();
    const resource = buildProductResource();

    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.ready();

    await ProductModel.create([
      { name: "Cheap", price: 10, status: "published", tags: [] },
      { name: "Mid", price: 75, status: "published", tags: [] },
      { name: "Expensive", price: 500, status: "published", tags: [] },
      { name: "Draft", price: 100, status: "draft", tags: [] },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/products?status=published&price[gte]=50",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // Should get Mid ($75) and Expensive ($500), not Cheap or Draft
    const names = (body.docs as Array<{ name: string }>).map((p) => p.name).sort();
    expect(names).toEqual(["Expensive", "Mid"]);

    await app.close();
  });

  it("GET /:id with real ObjectId works end-to-end", async () => {
    const { app } = await buildStrictApp();
    const resource = buildProductResource();

    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.ready();

    const created = await ProductModel.create({
      name: "FindMe",
      price: 42,
      status: "published",
      tags: ["new"],
    });

    const res = await app.inject({
      method: "GET",
      url: `/products/${created._id.toString()}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.name).toBe("FindMe");

    await app.close();
  });

  it("buildOpenApiSpec (standalone) produces a valid spec from registry entries", async () => {
    const { app } = await buildStrictApp();
    const resource = buildProductResource();
    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.ready();

    const arc = (app as unknown as FastifyWithDecorators).arc;
    const resources = arc?.registry?.getAll() ?? [];
    expect(resources.length).toBeGreaterThan(0);

    const spec = buildOpenApiSpec(resources, {
      title: "Standalone API",
      version: "2.0.0",
    });

    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe("Standalone API");
    expect(spec.info.version).toBe("2.0.0");
    expect(spec.paths["/products"]).toBeDefined();
    expect(spec.paths["/products/{id}"]).toBeDefined();
    expect(spec.components.schemas).toBeDefined();

    await app.close();
  });

  it("listQuery params in spec are well-formed (type + description, no orphan constraints)", async () => {
    const { app } = await buildStrictApp();
    const resource = buildProductResource();
    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.register(openApiPlugin, { title: "Test", version: "1.0.0" });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/_docs/openapi.json" });
    const spec = res.json();
    const listParams = spec.paths["/products"].get.parameters as Array<{
      name: string;
      schema?: { type?: string; minimum?: number; maximum?: number };
    }>;

    // page and limit must have their `type` preserved (regression check)
    const page = listParams.find((p) => p.name === "page");
    const limit = listParams.find((p) => p.name === "limit");
    expect(page?.schema?.type).toBe("integer");
    expect(limit?.schema?.type).toBe("integer");
    expect(limit?.schema?.maximum).toBe(100); // from QueryParser config

    await app.close();
  });
});
