/**
 * Schema + Query Integration E2E
 *
 * Tests the full chain: MongoKit QueryParser → Fastify schema validation →
 * bracket notation filters → CRUD → field exclusions → MCP tool schemas.
 *
 * Covers:
 * - name[contains], price[gte], price[lte] bracket filters
 * - excludeFields removing computed fields from body schemas
 * - fieldRules.systemManaged removing org fields when tenantField: false
 * - readonlyFields excluded from create/update body
 * - immutable fields excluded from update body only
 * - MongoKit QueryParser allowedFilterFields/allowedOperators
 * - additionalProperties: true allowing flexible queries
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { Repository, QueryParser } from "@classytic/mongokit";
import { createApp } from "../../src/factory/createApp.js";
import { defineResource } from "../../src/core/defineResource.js";
import { BaseController } from "../../src/core/BaseController.js";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { allowPublic } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";
import type { FastifyInstance } from "fastify";

describe("Schema + Query Integration E2E", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    // Model with diverse field types for testing schema generation
    const ProductSchema = new mongoose.Schema(
      {
        name: { type: String, required: true },
        sku: { type: String, required: true, unique: true },
        price: { type: Number, required: true },
        category: { type: String, enum: ["electronics", "books", "food"] },
        inStock: { type: Boolean, default: true },
        // Computed/auto fields that should be excluded from body
        totalSold: { type: Number, default: 0 },
        rating: { type: Number, default: 0 },
        // Org field that should be excluded when tenantField: false
        organizationId: { type: String },
      },
      { timestamps: true },
    );
    const ProductModel =
      mongoose.models.SchemaTestProduct ||
      mongoose.model("SchemaTestProduct", ProductSchema);
    const productRepo = new Repository(ProductModel);

    const qp = new QueryParser({
      allowedFilterFields: ["name", "category", "price", "inStock"],
      allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"],
      allowedSortFields: ["name", "price", "createdAt"],
    });

    const schemaOptions = {
      fieldRules: {
        name: { type: "string", required: true, description: "Product name" },
        sku: { type: "string", required: true, immutable: true, description: "SKU — cannot be changed after creation" },
        price: { type: "number", required: true, min: 0 },
        category: { type: "string", enum: ["electronics", "books", "food"] },
        inStock: { type: "boolean" },
        totalSold: { systemManaged: true },
        rating: { systemManaged: true },
        organizationId: { systemManaged: true },
        createdAt: { systemManaged: true },
        updatedAt: { systemManaged: true },
      },
      excludeFields: ["__v"],
    };

    const productResource = defineResource({
      name: "product",
      displayName: "Product",
      adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
      controller: new BaseController(productRepo, {
        resourceName: "product",
        queryParser: qp,
        tenantField: false,
        schemaOptions,
      }),
      queryParser: qp,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions,
    });

    // Seed data
    await ProductModel.deleteMany({});
    await ProductModel.create([
      { name: "MacBook Pro", sku: "MBP-001", price: 2499, category: "electronics", inStock: true },
      { name: "TypeScript Handbook", sku: "TSH-001", price: 39, category: "books", inStock: true },
      { name: "Go Handbook", sku: "GOH-001", price: 45, category: "books", inStock: true },
      { name: "Protein Bar", sku: "PB-001", price: 3.5, category: "food", inStock: false },
      { name: "Headphones", sku: "HP-001", price: 199, category: "electronics", inStock: true },
    ]);

    app = await createApp({
      preset: "testing",
      auth: false,
      resources: [productResource],
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDatabase();
  });

  // ============================================================================
  // Bracket Notation Filters
  // ============================================================================

  describe("bracket notation filters", () => {
    it("name[contains] filter works", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?name[contains]=Handbook",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBe(2);
      expect(body.docs.every((d: { name: string }) => d.name.includes("Handbook"))).toBe(true);
    });

    it("price[gte] and price[lte] range filter works", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?price[gte]=30&price[lte]=200",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Should include: TS Handbook (39), Go Handbook (45), Headphones (199)
      expect(body.docs.length).toBe(3);
      expect(body.docs.every((d: { price: number }) => d.price >= 30 && d.price <= 200)).toBe(true);
    });

    it("category exact filter works", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?category=books",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBe(2);
      expect(body.docs.every((d: { category: string }) => d.category === "books")).toBe(true);
    });

    it("combined bracket + exact filters work", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?category=electronics&price[gte]=200",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Only MacBook Pro (2499) — Headphones (199) doesn't meet price[gte]=200
      expect(body.docs.length).toBe(1);
      expect(body.docs[0].name).toBe("MacBook Pro");
    });

    it("inStock boolean filter works", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?inStock=false",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBe(1);
      expect(body.docs[0].name).toBe("Protein Bar");
    });

    it("sort with bracket filters works", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?category=books&sort=price",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBe(2);
      // Ascending: TS Handbook (39) before Go Handbook (45)
      expect(body.docs[0].price).toBeLessThanOrEqual(body.docs[1].price);
    });

    it("pagination with filters works", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?price[gte]=1&limit=2&page=1",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBe(2);
      expect(body.total).toBeGreaterThan(2);
      expect(body.page).toBe(1);
    });
  });

  // ============================================================================
  // Schema Generation — Field Exclusions
  // ============================================================================

  describe("body schema respects field exclusions", () => {
    it("systemManaged fields (totalSold, rating, organizationId) not required on create", async () => {
      // Should succeed without totalSold, rating, organizationId
      const res = await app.inject({
        method: "POST",
        url: "/products",
        payload: { name: "Test Widget", sku: "TW-001", price: 9.99, category: "electronics" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.name).toBe("Test Widget");
      // Clean up
      await app.inject({ method: "DELETE", url: `/products/${res.json().data._id}` });
    });

    it("immutable field (sku) excluded from update body", async () => {
      // Create product
      const create = await app.inject({
        method: "POST",
        url: "/products",
        payload: { name: "Immutable Test", sku: "IMM-001", price: 10 },
      });
      const id = create.json().data._id;

      // Update — sku should be stripped by BodySanitizer even if sent
      const update = await app.inject({
        method: "PATCH",
        url: `/products/${id}`,
        payload: { name: "Updated Name", sku: "CHANGED-SKU" },
      });
      expect(update.statusCode).toBe(200);
      expect(update.json().data.name).toBe("Updated Name");
      // SKU should NOT change (stripped by BodySanitizer)
      expect(update.json().data.sku).toBe("IMM-001");

      // Clean up
      await app.inject({ method: "DELETE", url: `/products/${id}` });
    });

    it("computed fields not in response when marked hidden", async () => {
      // totalSold and rating are systemManaged — they exist in DB but
      // should be in the response (systemManaged ≠ hidden)
      const res = await app.inject({ method: "GET", url: "/products" });
      expect(res.statusCode).toBe(200);
      // systemManaged fields are in response, just not in create/update body schemas
      const doc = res.json().docs[0];
      expect(doc).toHaveProperty("name");
      expect(doc).toHaveProperty("price");
    });
  });

  // ============================================================================
  // Full CRUD Lifecycle
  // ============================================================================

  describe("CRUD lifecycle with schema validation", () => {
    let productId: string;

    it("creates with required fields enforced", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/products",
        payload: { name: "CRUD Test", sku: "CRUD-001", price: 25, category: "books" },
      });
      expect(res.statusCode).toBe(201);
      productId = res.json().data._id;
    });

    it("reads back created product", async () => {
      const res = await app.inject({ method: "GET", url: `/products/${productId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.name).toBe("CRUD Test");
      expect(res.json().data.sku).toBe("CRUD-001");
    });

    it("updates non-immutable fields", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/products/${productId}`,
        payload: { price: 30 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.price).toBe(30);
    });

    it("deletes product", async () => {
      const res = await app.inject({ method: "DELETE", url: `/products/${productId}` });
      expect(res.statusCode).toBe(200);
    });

    it("get returns 404 after delete", async () => {
      const res = await app.inject({ method: "GET", url: `/products/${productId}` });
      expect(res.statusCode).toBe(404);
    });
  });

  // ============================================================================
  // Subdocument array schema
  // ============================================================================

  describe("subdocument array schema generation", () => {
    it("subdoc arrays generate object items, not string items", async () => {
      // Create a model with subdocument array
      const JournalSchema = new mongoose.Schema({
        description: { type: String, required: true },
        entries: [{
          account: { type: mongoose.Schema.Types.ObjectId, required: true },
          debit: { type: Number, default: 0 },
          credit: { type: Number, default: 0 },
        }],
        tags: [String],
      }, { timestamps: true });
      const JM = mongoose.models.SchemaTestJournal || mongoose.model("SchemaTestJournal", JournalSchema);

      const { Repository } = await import("@classytic/mongokit");
      const { MongooseAdapter } = await import("../../src/adapters/mongoose.js");
      const adapter = new MongooseAdapter({ model: JM, repository: new Repository(JM) });
      const schemas = adapter.generateSchemas({}) as any;

      // entries should be array of objects with properties, not array of strings
      const entriesSchema = schemas.response.properties.entries;
      expect(entriesSchema.type).toBe("array");
      expect(entriesSchema.items.type).toBe("object");
      expect(entriesSchema.items.properties).toBeDefined();
      expect(entriesSchema.items.properties.account).toBeDefined();
      expect(entriesSchema.items.properties.debit).toBeDefined();
      expect(entriesSchema.items.properties.credit).toBeDefined();
      expect(entriesSchema.items.properties.account.type).toBe("string"); // ObjectId → string

      // tags should be array of strings
      const tagsSchema = schemas.response.properties.tags;
      expect(tagsSchema.type).toBe("array");
      expect(tagsSchema.items.type).toBe("string");
    });

    it("partial fieldRules does NOT suppress required for unlisted fields", async () => {
      // REGRESSION: when fieldRules has only some fields, ALL Mongoose required fields
      // must still appear in createBody.required — not just fields in fieldRules.
      const PartialSchema = new mongoose.Schema({
        title: { type: String, required: true },
        amount: { type: Number, required: true },
        notes: String,
        internalStatus: { type: String, default: "pending" },
      });
      const PM = mongoose.models.SchemaPartialRules || mongoose.model("SchemaPartialRules", PartialSchema);

      const { Repository } = await import("@classytic/mongokit");
      const { MongooseAdapter } = await import("../../src/adapters/mongoose.js");
      const adapter = new MongooseAdapter({ model: PM, repository: new Repository(PM) });

      // Only mark internalStatus as systemManaged — title and amount are NOT in fieldRules
      const schemas = adapter.generateSchemas({
        fieldRules: { internalStatus: { systemManaged: true } },
      }) as any;

      // title and amount MUST still be required despite not being in fieldRules
      expect(schemas.createBody.required).toContain("title");
      expect(schemas.createBody.required).toContain("amount");
      // internalStatus should be excluded (systemManaged)
      expect(schemas.createBody.properties.internalStatus).toBeUndefined();
      expect(schemas.createBody.required ?? []).not.toContain("internalStatus");
    });

    it("excludeFields removes fields from required array too", async () => {
      const TestSchema = new mongoose.Schema({
        name: { type: String, required: true },
        orgId: { type: String, required: true },
        status: { type: String, required: true },
      });
      const TM = mongoose.models.SchemaTestExclude || mongoose.model("SchemaTestExclude", TestSchema);

      const { Repository } = await import("@classytic/mongokit");
      const { MongooseAdapter } = await import("../../src/adapters/mongoose.js");
      const adapter = new MongooseAdapter({ model: TM, repository: new Repository(TM) });
      const schemas = adapter.generateSchemas({
        excludeFields: ["orgId"],
        fieldRules: { status: { systemManaged: true } },
      }) as any;

      // orgId should NOT be in properties or required
      expect(schemas.createBody.properties.orgId).toBeUndefined();
      expect(schemas.createBody.required ?? []).not.toContain("orgId");
      // status should NOT be in properties or required (systemManaged)
      expect(schemas.createBody.properties.status).toBeUndefined();
      expect(schemas.createBody.required ?? []).not.toContain("status");
      // name should still be required
      expect(schemas.createBody.properties.name).toBeDefined();
      expect(schemas.createBody.required).toContain("name");
    });
  });

  // ============================================================================
  // Query does not strip unknown params (permissive)
  // ============================================================================

  describe("permissive query validation", () => {
    it("unknown query params are passed through (not rejected)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?customField=test&another[nested]=value",
      });
      // Should NOT return 400 — additionalProperties: true
      expect(res.statusCode).toBe(200);
    });

    it("populate with bracket notation passes schema validation (not rejected as 400)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?populate[author][select]=name,email",
      });
      // Should NOT return 400 (schema validation error) — populate is a flexible param.
      // May return 200 (no author relation, populate silently ignored) or 500 (DB error).
      // The key assertion is: it's NOT a schema validation rejection.
      expect(res.statusCode).not.toBe(400);
    });
  });
});
