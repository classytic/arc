/**
 * Type Inference & DX Tests
 *
 * Verifies that developers get proper type resolution when using Arc adapters,
 * BaseController, and RepositoryLike without explicit type annotations.
 *
 * These are compile-time + runtime tests — if tsc --noEmit passes AND
 * the runtime assertions hold, the DX is correct.
 */

import { describe, it, expect } from "vitest";
import mongoose, { Schema, type Model } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Repository } from "@classytic/mongokit";
import { createMongooseAdapter, MongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import type { RepositoryLike, DataAdapter } from "../../src/adapters/interface.js";

// ============================================================================
// Test Model
// ============================================================================

interface IProduct {
  name: string;
  price: number;
  category: "electronics" | "books" | "food";
  slug: string;
}

const ProductSchema = new Schema<IProduct>({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, enum: ["electronics", "books", "food"] },
  slug: { type: String, unique: true },
});

let mongoServer: MongoMemoryServer;
let ProductModel: Model<IProduct>;

describe("Type Inference & DX", () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const conn = await mongoose.connect(mongoServer.getUri());
    ProductModel =
      conn.models.TypeTestProduct || conn.model<IProduct>("TypeTestProduct", ProductSchema);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ========================================================================
  // createMongooseAdapter — type inference
  // ========================================================================

  describe("createMongooseAdapter type inference", () => {
    it("2-arg form infers TDoc from Model", () => {
      const repo = new Repository<IProduct>(ProductModel);
      const adapter = createMongooseAdapter(ProductModel, repo);

      // Runtime: adapter exists and has correct type identifier
      expect(adapter.type).toBe("mongoose");
      expect(adapter.name).toContain("TypeTestProduct");

      // Compile-time: adapter is DataAdapter<IProduct>, not DataAdapter<unknown>
      // If this compiles, TDoc was inferred correctly
      const typedAdapter: DataAdapter<IProduct> = adapter;
      expect(typedAdapter).toBeDefined();
    });

    it("object form infers TDoc from model field", () => {
      const repo = new Repository<IProduct>(ProductModel);
      const adapter = createMongooseAdapter({ model: ProductModel, repository: repo });

      const typedAdapter: DataAdapter<IProduct> = adapter;
      expect(typedAdapter.type).toBe("mongoose");
    });

    it("accepts RepositoryLike without breaking type inference", () => {
      // User provides a custom repo that satisfies RepositoryLike
      const customRepo: RepositoryLike = {
        getAll: async () => ({ docs: [], total: 0 }),
        getById: async (id: string) => ({ _id: id, name: "test" }),
        create: async (data: unknown) => data,
        update: async (_id: string, data: unknown) => data,
        delete: async () => true,
      };

      // Should compile — RepositoryLike is accepted alongside CrudRepository
      const adapter = createMongooseAdapter(ProductModel, customRepo);
      expect(adapter.type).toBe("mongoose");
    });
  });

  // ========================================================================
  // BaseController — type inference with repository
  // ========================================================================

  describe("BaseController type safety", () => {
    it("accepts MongoKit Repository directly", () => {
      const repo = new Repository<IProduct>(ProductModel);
      const controller = new BaseController(repo, { resourceName: "product" });

      // Compiles without explicit type annotation — TDoc inferred
      expect(controller).toBeDefined();
    });

    it("accepts RepositoryLike", () => {
      const customRepo: RepositoryLike = {
        getAll: async () => [],
        getById: async () => null,
        create: async (data: unknown) => data,
        update: async (_id: string, data: unknown) => data,
        delete: async () => true,
      };

      const controller = new BaseController(customRepo, { resourceName: "product" });
      expect(controller).toBeDefined();
    });

    it("idField option is accepted", () => {
      const repo = new Repository<IProduct>(ProductModel);
      const controller = new BaseController(repo, {
        resourceName: "product",
        idField: "slug",
      });

      expect(controller).toBeDefined();
    });
  });

  // ========================================================================
  // RepositoryLike — optional methods present
  // ========================================================================

  describe("RepositoryLike interface completeness", () => {
    it("required methods are enforced", () => {
      const repo: RepositoryLike = {
        getAll: async () => [],
        getById: async () => null,
        create: async () => ({}),
        update: async () => ({}),
        delete: async () => true,
      };

      expect(typeof repo.getAll).toBe("function");
      expect(typeof repo.getById).toBe("function");
      expect(typeof repo.create).toBe("function");
      expect(typeof repo.update).toBe("function");
      expect(typeof repo.delete).toBe("function");
    });

    it("optional getOne is accepted when provided", () => {
      const repo: RepositoryLike = {
        getAll: async () => [],
        getById: async () => null,
        create: async () => ({}),
        update: async () => ({}),
        delete: async () => true,
        getOne: async (filter: Record<string, unknown>) => ({ ...filter }),
      };

      expect(typeof repo.getOne).toBe("function");
    });

    it("optional preset methods are accepted when provided", () => {
      const repo: RepositoryLike = {
        getAll: async () => [],
        getById: async () => null,
        create: async () => ({}),
        update: async () => ({}),
        delete: async () => true,
        // Preset methods
        getBySlug: async (slug: string) => ({ slug }),
        createMany: async (items: unknown[]) => items,
        updateMany: async () => ({ matchedCount: 0, modifiedCount: 0 }),
        deleteMany: async () => ({ deletedCount: 0 }),
        restore: async (id: string) => ({ id }),
        getDeleted: async () => [],
        getTree: async () => [],
        getChildren: async () => [],
      };

      expect(typeof repo.getBySlug).toBe("function");
      expect(typeof repo.createMany).toBe("function");
      expect(typeof repo.updateMany).toBe("function");
      expect(typeof repo.deleteMany).toBe("function");
      expect(typeof repo.restore).toBe("function");
      expect(typeof repo.getDeleted).toBe("function");
    });

    it("MongoKit Repository satisfies RepositoryLike", () => {
      const repo = new Repository<IProduct>(ProductModel);

      // This assignment must compile — MongoKit implements all required methods
      const asLike: RepositoryLike = repo;
      expect(typeof asLike.getAll).toBe("function");
      expect(typeof asLike.getById).toBe("function");
      expect(typeof asLike.create).toBe("function");
      expect(typeof asLike.update).toBe("function");
      expect(typeof asLike.delete).toBe("function");

      // MongoKit 3.5.0+ has getOne — check if present (optional method)
      // On 3.4.x this is undefined, on 3.5.0+ it's a function
      const hasGetOne = typeof (repo as RepositoryLike).getOne === "function";
      expect(typeof hasGetOne).toBe("boolean");
    });
  });

  // ========================================================================
  // MongooseAdapter — schema metadata
  // ========================================================================

  describe("MongooseAdapter metadata", () => {
    it("getSchemaMetadata returns typed field info", () => {
      const repo = new Repository<IProduct>(ProductModel);
      const adapter = new MongooseAdapter({ model: ProductModel, repository: repo });

      const meta = adapter.getSchemaMetadata();
      expect(meta.name).toBe("TypeTestProduct");
      expect(meta.fields).toHaveProperty("name");
      expect(meta.fields).toHaveProperty("price");
      expect(meta.fields.name.type).toBe("string");
      expect(meta.fields.price.type).toBe("number");
    });

    it("generateSchemas produces OpenAPI schemas", () => {
      const repo = new Repository<IProduct>(ProductModel);
      const adapter = new MongooseAdapter({ model: ProductModel, repository: repo });

      const schemas = adapter.generateSchemas();
      expect(schemas).toBeDefined();
      expect(schemas).toHaveProperty("createBody");
      expect(schemas).toHaveProperty("response");
    });
  });
});
