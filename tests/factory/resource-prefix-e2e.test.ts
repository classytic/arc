/**
 * resourcePrefix + skipGlobalPrefix — E2E Tests
 *
 * Tests per-resource prefix override and full production-like boot flow
 * with loadResources(import.meta.url), bootstrap, prefix, and mixed resources.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { loadResources } from "../../src/factory/loadResources.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

const ARC_ROOT = resolve(import.meta.dirname, "../..");

function makeResource(name: string, opts: { skipGlobalPrefix?: boolean; prefix?: string } = {}) {
  const Model = createMockModel(`Pfx${name.charAt(0).toUpperCase()}${name.slice(1)}`);
  const repo = createMockRepository(Model);
  return defineResource({
    name,
    ...opts,
    adapter: createMongooseAdapter({ model: Model, repository: repo }),
    controller: new BaseController(repo, { resourceName: name }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
  });
}

describe("resourcePrefix + skipGlobalPrefix", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  // ============================================================================
  // skipGlobalPrefix
  // ============================================================================

  describe("skipGlobalPrefix", () => {
    it("webhook resource registers at /webhooks, not /api/v1/webhooks", async () => {
      const product = makeResource("product");
      const webhook = makeResource("webhook", {
        prefix: "/webhooks",
        skipGlobalPrefix: true,
      });

      const app = await createApp({
        preset: "testing",
        auth: false,
        resourcePrefix: "/api/v1",
        resources: [product, webhook],
      });
      await app.ready();

      // Product is under prefix
      const products = await app.inject({ method: "GET", url: "/api/v1/products" });
      expect(products.statusCode).toBe(200);

      // Webhook skips prefix — at root
      const webhooks = await app.inject({ method: "GET", url: "/webhooks" });
      expect(webhooks.statusCode).toBe(200);

      // Webhook NOT under prefix
      const wrongPath = await app.inject({ method: "GET", url: "/api/v1/webhooks" });
      expect(wrongPath.statusCode).toBe(404);

      await app.close();
    });

    it("admin resource with custom prefix skips global prefix", async () => {
      const user = makeResource("user");
      const admin = makeResource("admin-panel", {
        prefix: "/admin",
        skipGlobalPrefix: true,
      });

      const app = await createApp({
        preset: "testing",
        auth: false,
        resourcePrefix: "/api",
        resources: [user, admin],
      });
      await app.ready();

      const users = await app.inject({ method: "GET", url: "/api/users" });
      expect(users.statusCode).toBe(200);

      const adminPanel = await app.inject({ method: "GET", url: "/admin" });
      expect(adminPanel.statusCode).toBe(200);

      await app.close();
    });

    it("multiple resources: some prefixed, some at root", async () => {
      const product = makeResource("product");
      const order = makeResource("order");
      const webhook = makeResource("webhook", {
        prefix: "/webhooks",
        skipGlobalPrefix: true,
      });
      const health = makeResource("diagnostic", {
        prefix: "/internal/health",
        skipGlobalPrefix: true,
      });

      const app = await createApp({
        preset: "testing",
        auth: false,
        resourcePrefix: "/api/v1",
        resources: [product, order, webhook, health],
      });
      await app.ready();

      // Prefixed
      expect((await app.inject({ method: "GET", url: "/api/v1/products" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/orders" })).statusCode).toBe(200);

      // Root
      expect((await app.inject({ method: "GET", url: "/webhooks" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/internal/health" })).statusCode).toBe(200);

      // Not mixed up
      expect((await app.inject({ method: "GET", url: "/products" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/v1/webhooks" })).statusCode).toBe(404);

      await app.close();
    });

    it("skipGlobalPrefix with no resourcePrefix is harmless", async () => {
      const product = makeResource("product");
      const webhook = makeResource("webhook", {
        prefix: "/webhooks",
        skipGlobalPrefix: true,
      });

      const app = await createApp({
        preset: "testing",
        auth: false,
        // No resourcePrefix
        resources: [product, webhook],
      });
      await app.ready();

      // Both at root
      expect((await app.inject({ method: "GET", url: "/products" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/webhooks" })).statusCode).toBe(200);

      await app.close();
    });

    it("CRUD works on both prefixed and root resources", async () => {
      const product = makeResource("product");
      const webhook = makeResource("webhook", {
        prefix: "/hooks",
        skipGlobalPrefix: true,
      });

      const app = await createApp({
        preset: "testing",
        auth: false,
        resourcePrefix: "/api",
        resources: [product, webhook],
      });
      await app.ready();

      // CRUD on prefixed resource
      const createProduct = await app.inject({
        method: "POST",
        url: "/api/products",
        payload: { name: "Widget", isActive: true },
      });
      expect(createProduct.statusCode).toBe(201);
      const productId = createProduct.json().data._id;

      const getProduct = await app.inject({ method: "GET", url: `/api/products/${productId}` });
      expect(getProduct.statusCode).toBe(200);

      // CRUD on root resource
      const createHook = await app.inject({
        method: "POST",
        url: "/hooks",
        payload: { name: "order.created", isActive: true },
      });
      expect(createHook.statusCode).toBe(201);
      const hookId = createHook.json().data._id;

      const getHook = await app.inject({ method: "GET", url: `/hooks/${hookId}` });
      expect(getHook.statusCode).toBe(200);

      await app.close();
    });
  });

  // ============================================================================
  // loadResources(import.meta.url) + resourcePrefix — production simulation
  // ============================================================================

  describe("production simulation with loadResources", () => {
    const TMP = join(import.meta.dirname, "__tmp_prefix_prod__");

    afterAll(() => {
      if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    });

    it("loadResources(import.meta.url) + resourcePrefix = full prod flow", async () => {
      // Simulate a production-like project:
      //   src/resources/product/product.resource.ts
      //   src/resources/order/order.resource.ts
      //   src/resources/webhook/webhook.resource.ts (skipGlobalPrefix)
      const base = join(TMP, "prod-sim", "src", "resources");
      mkdirSync(join(base, "product"), { recursive: true });
      mkdirSync(join(base, "order"), { recursive: true });
      mkdirSync(join(base, "webhook"), { recursive: true });

      const resourceFile = (name: string, extra = "") => `
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { defineResource } from '${ARC_ROOT.replace(/\\/g, "/")}/src/core/defineResource.js';
import { createMongooseAdapter } from '${ARC_ROOT.replace(/\\/g, "/")}/src/adapters/mongoose.js';
import { BaseController } from '${ARC_ROOT.replace(/\\/g, "/")}/src/core/BaseController.js';
import { allowPublic } from '${ARC_ROOT.replace(/\\/g, "/")}/src/permissions/index.js';

const S = new mongoose.Schema({ name: String, isActive: Boolean }, { timestamps: true });
const M = mongoose.models.ProdSim${name.charAt(0).toUpperCase()}${name.slice(1)} || mongoose.model('ProdSim${name.charAt(0).toUpperCase()}${name.slice(1)}', S);
const r = new Repository(M);

export default defineResource({
  name: '${name}',
  ${extra}
  adapter: createMongooseAdapter({ model: M, repository: r }),
  controller: new BaseController(r, { resourceName: '${name}' }),
  permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic(), update: allowPublic(), delete: allowPublic() },
});
`;

      writeFileSync(join(base, "product", "product.resource.mjs"), resourceFile("product"));
      writeFileSync(join(base, "order", "order.resource.mjs"), resourceFile("order"));
      writeFileSync(
        join(base, "webhook", "webhook.resource.mjs"),
        resourceFile("webhook", "prefix: '/webhooks', skipGlobalPrefix: true,"),
      );

      // Use pathToFileURL to simulate import.meta.url
      const metaUrl = pathToFileURL(join(base, "index.ts")).href;
      const resources = await loadResources(metaUrl, { silent: true });

      expect(resources).toHaveLength(3);

      const app = await createApp({
        preset: "testing",
        auth: false,
        resourcePrefix: "/api/v1",
        resources,
      });
      await app.ready();

      // API resources under prefix
      expect((await app.inject({ method: "GET", url: "/api/v1/products" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/orders" })).statusCode).toBe(200);

      // Webhook at root (skipGlobalPrefix)
      expect((await app.inject({ method: "GET", url: "/webhooks" })).statusCode).toBe(200);

      // Not mixed
      expect((await app.inject({ method: "GET", url: "/products" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/v1/webhooks" })).statusCode).toBe(404);

      // Full CRUD on prefixed resource
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "Prod Widget", isActive: true },
      });
      expect(created.statusCode).toBe(201);

      const id = created.json().data._id;
      const fetched = await app.inject({ method: "GET", url: `/api/v1/products/${id}` });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json().data.name).toBe("Prod Widget");

      // Full CRUD on root resource
      const hookCreated = await app.inject({
        method: "POST",
        url: "/webhooks",
        payload: { name: "order.created", isActive: true },
      });
      expect(hookCreated.statusCode).toBe(201);

      await app.close();
    });

    it("loadResources + bootstrap + plugins + prefix = full boot", async () => {
      const base = join(TMP, "full-boot", "src", "resources");
      mkdirSync(base, { recursive: true });

      writeFileSync(
        join(base, "task.resource.ts"),
        `export default { name: 'task', toPlugin: () => () => {} };\n`,
      );

      const metaUrl = pathToFileURL(join(base, "loader.ts")).href;
      const resources = await loadResources(metaUrl, { silent: true });

      const bootOrder: string[] = [];

      const app = await createApp({
        preset: "testing",
        auth: false,
        resourcePrefix: "/api",
        plugins: async () => {
          bootOrder.push("plugins");
        },
        bootstrap: [
          async (fastify) => {
            bootOrder.push("bootstrap");
            // Arc core should be ready
            expect(fastify.arc).toBeDefined();
          },
        ],
        resources,
        afterResources: async () => {
          bootOrder.push("afterResources");
        },
        onReady: async () => {
          bootOrder.push("onReady");
        },
      });
      await app.ready();

      expect(bootOrder).toEqual(["plugins", "bootstrap", "afterResources", "onReady"]);

      await app.close();
    });
  });

  // ============================================================================
  // JS-only project simulation
  // ============================================================================

  describe("JS-only project", () => {
    const TMP = join(import.meta.dirname, "__tmp_prefix_js__");

    afterAll(() => {
      if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    });

    it("works with .mjs resources and resourcePrefix", async () => {
      const base = join(TMP, "js-proj", "resources");
      mkdirSync(base, { recursive: true });

      writeFileSync(
        join(base, "item.resource.mjs"),
        "export default { name: 'item', toPlugin: () => () => {} };\n",
      );
      writeFileSync(
        join(base, "admin.resource.mjs"),
        "export default { name: 'admin', prefix: '/admin', skipGlobalPrefix: true, toPlugin: () => () => {} };\n",
      );

      const metaUrl = pathToFileURL(join(base, "index.mjs")).href;
      const resources = await loadResources(metaUrl);

      expect(resources).toHaveLength(2);

      // skipGlobalPrefix should be readable from the loaded resource
      const adminRes = resources.find((r) => (r as { name?: string }).name === "admin");
      expect((adminRes as { skipGlobalPrefix?: boolean }).skipGlobalPrefix).toBe(true);
    });
  });

  // ============================================================================
  // Backward compatibility
  // ============================================================================

  describe("backward compatibility", () => {
    it("no resourcePrefix + no skipGlobalPrefix = same as before", async () => {
      const product = makeResource("product");
      const order = makeResource("order");

      const app = await createApp({
        preset: "testing",
        auth: false,
        resources: [product, order],
      });
      await app.ready();

      expect((await app.inject({ method: "GET", url: "/products" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/orders" })).statusCode).toBe(200);

      await app.close();
    });

    it("plugins callback still runs before resources", async () => {
      const order: string[] = [];

      const app = await createApp({
        preset: "testing",
        auth: false,
        plugins: async () => {
          order.push("plugins");
        },
        resources: [],
      });
      await app.ready();

      expect(order).toEqual(["plugins"]);

      await app.close();
    });

    it("existing resources-option tests still work (no prefix)", async () => {
      const Model = createMockModel("BackCompat");
      const repo = createMockRepository(Model);
      const resource = defineResource({
        name: "compat",
        adapter: createMongooseAdapter({ model: Model, repository: repo }),
        controller: new BaseController(repo, { resourceName: "compat" }),
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
      });

      const app = await createApp({
        preset: "testing",
        auth: false,
        resources: [resource],
      });
      await app.ready();

      const create = await app.inject({
        method: "POST",
        url: "/compats",
        payload: { name: "Test", isActive: true },
      });
      expect(create.statusCode).toBe(201);

      await app.close();
    });
  });
});
