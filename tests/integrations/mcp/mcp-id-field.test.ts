/**
 * MCP integration with custom idField — REAL Mongoose + MongoKit
 *
 * Verifies that when a resource declares `idField: 'sku'` (or any custom field),
 * the auto-generated MCP tools (`get_product`, `update_product`, `delete_product`)
 * route through BaseController using the custom field, NOT _id.
 *
 * This is the same fix path as REST routes, but exercised through the MCP
 * pipeline (`buildRequestContext` → `BaseController.get/update/delete` →
 * `AccessControl.fetchWithAccessControl` → `repository.getOne({ [idField]: id })`).
 */

import { buildCrudSchemasFromModel, QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../../src/core/BaseController.js";
import { defineResource } from "../../../src/core/defineResource.js";
import { createTestMcpClient } from "../../../src/integrations/mcp/testing.js";
import { allowPublic } from "../../../src/permissions/index.js";

interface IProduct {
  sku: string;
  name: string;
  price: number;
  status: "draft" | "published";
}

const ProductSchema = new Schema<IProduct>(
  {
    sku: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ["draft", "published"], default: "draft" },
  },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let ProductModel: Model<IProduct>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ProductModel =
    mongoose.models.McpIdFieldProduct ||
    mongoose.model<IProduct>("McpIdFieldProduct", ProductSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

function buildResource() {
  const repo = new Repository<IProduct>(ProductModel);
  const parser = new QueryParser({
    allowedFilterFields: ["status", "sku", "price"],
  });
  return defineResource<IProduct>({
    name: "product",
    // biome-ignore lint: generic
    adapter: createMongooseAdapter({
      model: ProductModel,
      repository: repo,
      schemaGenerator: buildCrudSchemasFromModel,
    }),
    queryParser: parser,
    idField: "sku",
    tenantField: false,
    controller: new BaseController(repo, {
      queryParser: parser,
      resourceName: "product",
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
}

describe("MCP tools with idField: 'sku' (real Mongoose + MongoKit)", () => {
  beforeAll(async () => {
    await ProductModel.deleteMany({});
    await ProductModel.create([
      { sku: "WIDGET-001", name: "Widget Classic", price: 50, status: "published" },
      { sku: "WIDGET-002", name: "Widget Pro", price: 150, status: "published" },
      { sku: "GADGET-XYZ", name: "Gadget", price: 299, status: "draft" },
    ]);
  });

  it("list_products tool returns all products via MCP", async () => {
    const resource = buildResource();
    const client = await createTestMcpClient({
      pluginOptions: { resources: [resource] },
    });
    try {
      const result = await client.callTool("list_products", {});
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? "";
      const parsed = JSON.parse(text);
      // BaseController returns { data, total, page, ... }
      expect(parsed.data ?? parsed.data?.data).toBeDefined();
      const data = parsed.data ?? parsed.data?.data;
      expect(data.length).toBe(3);
    } finally {
      await client.close();
    }
  });

  it("get_product tool fetches by sku (custom idField, not _id)", async () => {
    const resource = buildResource();
    const client = await createTestMcpClient({
      pluginOptions: { resources: [resource] },
    });
    try {
      const result = await client.callTool("get_product", { id: "WIDGET-001" });
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? "";
      const parsed = JSON.parse(text);
      const doc = parsed.data ?? parsed;
      expect(doc.sku).toBe("WIDGET-001");
      expect(doc.name).toBe("Widget Classic");
      expect(doc.price).toBe(50);
    } finally {
      await client.close();
    }
  });

  it("get_product with hyphenated sku works", async () => {
    const resource = buildResource();
    const client = await createTestMcpClient({
      pluginOptions: { resources: [resource] },
    });
    try {
      const result = await client.callTool("get_product", { id: "GADGET-XYZ" });
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? "";
      const parsed = JSON.parse(text);
      const doc = parsed.data ?? parsed;
      expect(doc.sku).toBe("GADGET-XYZ");
      expect(doc.status).toBe("draft");
    } finally {
      await client.close();
    }
  });

  it("update_product tool updates by sku (real DB write)", async () => {
    const resource = buildResource();
    const client = await createTestMcpClient({
      pluginOptions: { resources: [resource] },
    });
    try {
      const result = await client.callTool("update_product", {
        id: "WIDGET-002",
        price: 199,
      });
      expect(result.isError).toBeFalsy();

      // Verify directly in DB
      const doc = await ProductModel.findOne({ sku: "WIDGET-002" }).lean();
      expect(doc?.price).toBe(199);
    } finally {
      await client.close();
    }
  });

  it("delete_product tool removes by sku", async () => {
    // Seed a fresh deletable product so we don't disrupt other tests
    await ProductModel.create({
      sku: "DELETABLE-001",
      name: "Will Be Deleted",
      price: 1,
      status: "draft",
    });

    const resource = buildResource();
    const client = await createTestMcpClient({
      pluginOptions: { resources: [resource] },
    });
    try {
      const result = await client.callTool("delete_product", { id: "DELETABLE-001" });
      expect(result.isError).toBeFalsy();

      const doc = await ProductModel.findOne({ sku: "DELETABLE-001" });
      expect(doc).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("get_product with unknown sku returns error/not-found (not 500)", async () => {
    const resource = buildResource();
    const client = await createTestMcpClient({
      pluginOptions: { resources: [resource] },
    });
    try {
      const result = await client.callTool("get_product", { id: "DOES-NOT-EXIST" });
      // Either isError=true or content is "not found" — both are acceptable
      const text = result.content[0]?.text ?? "";
      const isNotFound =
        result.isError === true || text.toLowerCase().includes("not found") || text.includes("404");
      expect(isNotFound).toBe(true);
    } finally {
      await client.close();
    }
  });
});
