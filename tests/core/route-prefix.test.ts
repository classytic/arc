/**
 * Route Prefix Tests
 *
 * Verifies that resource prefixes, custom prefixes, and root-level
 * mounting work correctly without conflicts or 404s.
 */

import { Repository } from "@classytic/mongokit";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

function makeResource(name: string, prefix?: string) {
  const S = new mongoose.Schema({ name: String, isActive: Boolean }, { timestamps: true });
  const modelName = `RP_${name.replace(/-/g, "_")}`;
  const M = mongoose.models[modelName] || mongoose.model(modelName, S);
  const r = new Repository(M);
  return defineResource({
    name,
    ...(prefix ? { prefix } : {}),
    adapter: createMongooseAdapter({ model: M, repository: r }),
    controller: new BaseController(r, { resourceName: name, tenantField: false }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });
}

describe("Route Prefix Handling", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    // Default prefix (auto-pluralized): /products
    const productResource = makeResource("product");

    // Custom prefix: /api/v2/items
    const itemResource = makeResource("item", "/api/v2/items");

    // Hyphenated name: /account-types (pluralize handles it)
    const accountTypeResource = makeResource("account-type");

    // Root-adjacent: /health-checks
    const healthCheckResource = makeResource("health-check");

    app = await createApp({
      preset: "testing",
      auth: false,
      resources: [productResource, itemResource, accountTypeResource, healthCheckResource],
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDatabase();
  });

  // ── Auto-pluralized prefix ──

  it("default prefix: GET /products works", async () => {
    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(200);
  });

  it("default prefix: POST /products works", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Widget" },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── Custom prefix ──

  it("custom prefix: GET /api/v2/items works", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v2/items" });
    expect(res.statusCode).toBe(200);
  });

  it("custom prefix: POST /api/v2/items works", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v2/items",
      payload: { name: "Custom Item" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("custom prefix: GET /api/v2/items/:id works", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/items",
      payload: { name: "Fetch Me" },
    });
    const id = create.json().data._id;
    const res = await app.inject({ method: "GET", url: `/api/v2/items/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe("Fetch Me");
  });

  // ── Hyphenated names ──

  it("hyphenated name auto-pluralizes: GET /account-types works", async () => {
    const res = await app.inject({ method: "GET", url: "/account-types" });
    expect(res.statusCode).toBe(200);
  });

  it("hyphenated name CRUD lifecycle", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/account-types",
      payload: { name: "Revenue" },
    });
    expect(create.statusCode).toBe(201);

    const id = create.json().data._id;
    const get = await app.inject({ method: "GET", url: `/account-types/${id}` });
    expect(get.statusCode).toBe(200);

    const update = await app.inject({
      method: "PATCH",
      url: `/account-types/${id}`,
      payload: { name: "Updated Revenue" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.name).toBe("Updated Revenue");

    const del = await app.inject({ method: "DELETE", url: `/account-types/${id}` });
    expect(del.statusCode).toBe(200);
  });

  // ── No conflicts between resources ──

  it("resources with different prefixes don't conflict", async () => {
    const products = await app.inject({ method: "GET", url: "/products" });
    const items = await app.inject({ method: "GET", url: "/api/v2/items" });
    const types = await app.inject({ method: "GET", url: "/account-types" });
    const health = await app.inject({ method: "GET", url: "/health-checks" });

    expect(products.statusCode).toBe(200);
    expect(items.statusCode).toBe(200);
    expect(types.statusCode).toBe(200);
    expect(health.statusCode).toBe(200);
  });

  // ── 404 on wrong paths ──

  it("wrong prefix returns 404", async () => {
    const res = await app.inject({ method: "GET", url: "/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("singular name (not pluralized) returns 404", async () => {
    const res = await app.inject({ method: "GET", url: "/product" });
    expect(res.statusCode).toBe(404);
  });
});
