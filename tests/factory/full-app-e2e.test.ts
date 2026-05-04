/**
 * Full App E2E — Production-like simulation
 *
 * Tests the complete createApp flow as a real user would use it:
 * - loadResources(import.meta.url) with mixed prefix/root resources
 * - bootstrap functions for domain init
 * - resourcePrefix for API versioning
 * - afterResources for post-registration wiring
 * - Duplicate resource detection
 * - JSON parser security (prototype poisoning protection)
 * - Graceful shutdown disabled in testing preset
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  const Model = createMockModel(`E2E${name.charAt(0).toUpperCase()}${name.slice(1)}`);
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

describe("Full App E2E — production simulation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("complete boot: loadResources + bootstrap + prefix + CRUD", async () => {
    // ── Setup fixture directory ──
    const TMP = join(import.meta.dirname, "__tmp_full_e2e__");
    mkdirSync(join(TMP, "product"), { recursive: true });
    mkdirSync(join(TMP, "order"), { recursive: true });
    mkdirSync(join(TMP, "webhook"), { recursive: true });

    const resourceFile = (name: string, extra = "") => `
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { defineResource } from '${ARC_ROOT.replace(/\\/g, "/")}/src/core/defineResource.js';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { BaseController } from '${ARC_ROOT.replace(/\\/g, "/")}/src/core/BaseController.js';
import { allowPublic } from '${ARC_ROOT.replace(/\\/g, "/")}/src/permissions/index.js';

const S = new mongoose.Schema({ name: String, isActive: Boolean }, { timestamps: true });
const M = mongoose.models.E2EFull${name.charAt(0).toUpperCase()}${name.slice(1)} || mongoose.model('E2EFull${name.charAt(0).toUpperCase()}${name.slice(1)}', S);
const r = new Repository(M);

export default defineResource({
  name: '${name}',
  ${extra}
  adapter: createMongooseAdapter({ model: M, repository: r }),
  controller: new BaseController(r, { resourceName: '${name}' }),
  permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic(), update: allowPublic(), delete: allowPublic() },
});
`;

    writeFileSync(join(TMP, "product", "product.resource.mjs"), resourceFile("product"));
    writeFileSync(join(TMP, "order", "order.resource.mjs"), resourceFile("order"));
    writeFileSync(
      join(TMP, "webhook", "webhook.resource.mjs"),
      resourceFile("webhook", "prefix: '/hooks', skipGlobalPrefix: true,"),
    );

    try {
      // ── Load resources ──
      const metaUrl = pathToFileURL(join(TMP, "index.ts")).href;
      const resources = await loadResources(metaUrl);
      expect(resources).toHaveLength(3);

      // ── Boot app ──
      const bootLog: string[] = [];
      let engineReady = false;

      app = await createApp({
        preset: "testing",
        auth: false,
        resourcePrefix: "/api/v1",

        plugins: async () => {
          bootLog.push("plugins:db-connected");
        },

        bootstrap: [
          async (fastify) => {
            // Simulate engine init that needs DB ready
            expect(fastify.arc).toBeDefined();
            engineReady = true;
            bootLog.push("bootstrap:engine-init");
          },
          async () => {
            // Second bootstrap — verify order
            expect(engineReady).toBe(true);
            bootLog.push("bootstrap:cache-warm");
          },
        ],

        resources,

        afterResources: async () => {
          bootLog.push("afterResources:event-subscriptions");
        },

        onReady: async () => {
          bootLog.push("onReady");
        },
      });

      await app.ready();

      // ── Verify boot order ──
      expect(bootLog).toEqual([
        "plugins:db-connected",
        "bootstrap:engine-init",
        "bootstrap:cache-warm",
        "afterResources:event-subscriptions",
        "onReady",
      ]);

      // ── Verify routes ──
      // API resources under prefix
      expect((await app.inject({ method: "GET", url: "/api/v1/products" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/orders" })).statusCode).toBe(200);

      // Webhook at root (skipGlobalPrefix)
      expect((await app.inject({ method: "GET", url: "/hooks" })).statusCode).toBe(200);

      // Not at wrong paths
      expect((await app.inject({ method: "GET", url: "/products" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/v1/hooks" })).statusCode).toBe(404);

      // ── Full CRUD ──
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/products",
        payload: { name: "E2E Widget", isActive: true },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json()._id;

      const fetched = await app.inject({ method: "GET", url: `/api/v1/products/${id}` });
      expect(fetched.json().name).toBe("E2E Widget");

      const updated = await app.inject({
        method: "PATCH",
        url: `/api/v1/products/${id}`,
        payload: { name: "Updated Widget" },
      });
      expect(updated.json().name).toBe("Updated Widget");

      const deleted = await app.inject({ method: "DELETE", url: `/api/v1/products/${id}` });
      expect(deleted.statusCode).toBe(200);
    } finally {
      if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    }
  });

  it("duplicate resource name throws with descriptive error", async () => {
    const product1 = makeResource("product");
    const product2 = makeResource("product"); // duplicate name

    // Fastify rejects duplicate routes — Arc's duplicate detection warns BEFORE
    // the route conflict, giving a more actionable error message.
    await expect(
      createApp({
        preset: "testing",
        auth: false,
        logger: { level: "warn" },
        resources: [product1, product2],
      }),
    ).rejects.toThrow(/product.*failed to register/i);
  });

  it("JSON parser rejects prototype poisoning", async () => {
    app = await createApp({ preset: "testing", auth: false });
    app.post("/echo", async (req) => ({ body: req.body }));
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      body: '{"__proto__": {"isAdmin": true}}',
    });
    // secure-json-parse rejects __proto__
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("empty JSON body on DELETE does not crash", async () => {
    app = await createApp({ preset: "testing", auth: false });
    app.delete("/item/:id", async () => ({ deleted: true }));
    await app.ready();

    const res = await app.inject({
      method: "DELETE",
      url: "/item/123",
      headers: { "content-type": "application/json" },
      body: "",
    });
    expect(res.statusCode).toBe(200);
  });

  it("testing preset does not register gracefulShutdown (no listener buildup)", async () => {
    const initialListeners = process.listenerCount("SIGTERM");

    app = await createApp({ preset: "testing", auth: false });
    await app.ready();

    // No new SIGTERM listeners added
    expect(process.listenerCount("SIGTERM")).toBe(initialListeners);

    await app.close();
    app = null!;
  });

  it("bootstrap error prevents resource registration", async () => {
    await expect(
      createApp({
        preset: "testing",
        auth: false,
        bootstrap: [
          async () => {
            throw new Error("Redis connection refused");
          },
        ],
        resources: [makeResource("product")],
      }),
    ).rejects.toThrow("Redis connection refused");
  });

  it("explicit resources + loadResources can be combined", async () => {
    const TMP = join(import.meta.dirname, "__tmp_combined_e2e__");
    mkdirSync(TMP, { recursive: true });

    writeFileSync(
      join(TMP, "auto.resource.ts"),
      "export default { name: 'auto', toPlugin: () => () => {} };\n",
    );

    try {
      const autoResources = await loadResources(TMP);
      const manual = makeResource("manual");

      app = await createApp({
        preset: "testing",
        auth: false,
        resources: [...autoResources, manual],
      });
      await app.ready();

      // Manual resource has CRUD routes
      expect((await app.inject({ method: "GET", url: "/manuals" })).statusCode).toBe(200);
    } finally {
      if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    }
  });
});
