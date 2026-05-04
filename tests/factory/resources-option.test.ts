/**
 * createApp({ resources }) — E2E Test
 *
 * Verifies that passing resources directly to createApp() registers them
 * correctly with working CRUD endpoints, same as manual toPlugin() registration.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

describe("createApp({ resources })", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    const ProductModel = createMockModel("ResOptProduct");
    const productRepo = createMockRepository(ProductModel);

    const OrderModel = createMockModel("ResOptOrder");
    const orderRepo = createMockRepository(OrderModel);

    const productResource = defineResource({
      name: "product",
      adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
      controller: new BaseController(productRepo, { resourceName: "product" }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const orderResource = defineResource({
      name: "order",
      adapter: createMongooseAdapter({ model: OrderModel, repository: orderRepo }),
      controller: new BaseController(orderRepo, { resourceName: "order" }),
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
      resources: [productResource, orderResource],
    });

    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDatabase();
  });

  // ── Registration ──

  it("registers all resource routes", async () => {
    const productList = await app.inject({ method: "GET", url: "/products" });
    expect(productList.statusCode).toBe(200);

    const orderList = await app.inject({ method: "GET", url: "/orders" });
    expect(orderList.statusCode).toBe(200);
  });

  // ── Full CRUD on first resource ──

  it("creates a product via POST", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Widget", isActive: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("Widget");
  });

  it("lists products via GET", async () => {
    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].name).toBe("Widget");
  });

  it("gets a product by ID", async () => {
    const list = await app.inject({ method: "GET", url: "/products" });
    const id = list.json().data[0]._id;

    const res = await app.inject({ method: "GET", url: `/products/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Widget");
  });

  it("updates a product", async () => {
    const list = await app.inject({ method: "GET", url: "/products" });
    const id = list.json().data[0]._id;

    const res = await app.inject({
      method: "PATCH",
      url: `/products/${id}`,
      payload: { name: "Super Widget" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Super Widget");
  });

  it("deletes a product", async () => {
    const list = await app.inject({ method: "GET", url: "/products" });
    const id = list.json().data[0]._id;

    const res = await app.inject({ method: "DELETE", url: `/products/${id}` });
    expect(res.statusCode).toBe(200);
  });

  // ── Second resource works independently ──

  it("creates and lists orders independently", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { name: "Order-001", isActive: true },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/orders" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.length).toBeGreaterThanOrEqual(1);
  });

  // ── Works alongside plugins callback ──

  it("supports resources + plugins callback together", async () => {
    const ProductModel = createMockModel("ResOptProduct2");
    const productRepo = createMockRepository(ProductModel);

    const resource = defineResource({
      name: "item",
      adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
      controller: new BaseController(productRepo, { resourceName: "item" }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    let pluginsCalled = false;

    const app2 = await createApp({
      preset: "testing",
      auth: false,
      resources: [resource],
      plugins: async (_fastify) => {
        pluginsCalled = true;
      },
    });

    await app2.ready();

    expect(pluginsCalled).toBe(true);

    const res = await app2.inject({ method: "GET", url: "/items" });
    expect(res.statusCode).toBe(200);

    await app2.close();
  });

  // ── Empty resources array is safe ──

  it("handles empty resources array gracefully", async () => {
    const app3 = await createApp({
      preset: "testing",
      auth: false,
      resources: [],
    });
    await app3.ready();
    // App works, just has no resource routes
    const res = await app3.inject({ method: "GET", url: "/nonexistent" });
    expect(res.statusCode).toBe(404);
    await app3.close();
  });

  // ── Omitting resources still works (backward compat) ──

  it("works without resources option (backward compatible)", async () => {
    const app4 = await createApp({
      preset: "testing",
      auth: false,
    });
    await app4.ready();
    const res = await app4.inject({ method: "GET", url: "/health" });
    // Health or 404, both fine — just shouldn't crash
    expect([200, 404]).toContain(res.statusCode);
    await app4.close();
  });
});
