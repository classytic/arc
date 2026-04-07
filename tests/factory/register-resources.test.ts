/**
 * registerResources — Unit Tests
 *
 * Tests the resource lifecycle in isolation:
 * plugins → bootstrap → resources → afterResources → lifecycle hooks
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { registerResources } from "../../src/factory/registerResources.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

function makeResource(name: string, opts: { skipGlobalPrefix?: boolean; prefix?: string } = {}) {
  const Model = createMockModel(`RegRes${name.charAt(0).toUpperCase()}${name.slice(1)}`);
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

/** Create a bare Fastify with arc core (no security, no auth) */
async function createBareApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { arcCorePlugin } = await import("../../src/plugins/index.js");
  await app.register(arcCorePlugin, { emitEvents: false });
  return app;
}

describe("registerResources — unit", () => {
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

  // ── Boot order ──

  it("executes in correct order: plugins → bootstrap → resources → after → lifecycle", async () => {
    app = await createBareApp();
    const order: string[] = [];

    await registerResources(app, {
      plugins: async () => {
        order.push("plugins");
      },
      bootstrap: [async () => order.push("bootstrap-1"), async () => order.push("bootstrap-2")],
      resources: [],
      afterResources: async () => order.push("afterResources"),
      onReady: async () => order.push("onReady"),
    });
    await app.ready();

    expect(order).toEqual(["plugins", "bootstrap-1", "bootstrap-2", "afterResources", "onReady"]);
  });

  // ── Resources ──

  it("registers resources at root when no prefix", async () => {
    app = await createBareApp();
    const product = makeResource("product");

    await registerResources(app, { resources: [product] });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(200);
  });

  it("registers resources under resourcePrefix", async () => {
    app = await createBareApp();
    const product = makeResource("product");

    await registerResources(app, {
      resourcePrefix: "/api/v1",
      resources: [product],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/api/v1/products" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/products" })).statusCode).toBe(404);
  });

  it("skipGlobalPrefix: true registers at root despite resourcePrefix", async () => {
    app = await createBareApp();
    const product = makeResource("product");
    const webhook = makeResource("webhook", { prefix: "/hooks", skipGlobalPrefix: true });

    await registerResources(app, {
      resourcePrefix: "/api",
      resources: [product, webhook],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/api/products" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/hooks" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/hooks" })).statusCode).toBe(404);
  });

  it("multiple root + prefixed resources work together", async () => {
    app = await createBareApp();
    const a = makeResource("alpha");
    const b = makeResource("beta");
    const c = makeResource("gamma", { prefix: "/internal", skipGlobalPrefix: true });

    await registerResources(app, {
      resourcePrefix: "/v2",
      resources: [a, b, c],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/v2/alphas" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v2/betas" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/internal" })).statusCode).toBe(200);
  });

  it("resource registration failure gives descriptive error", async () => {
    app = await createBareApp();
    const badResource = {
      name: "broken",
      skipGlobalPrefix: false,
      toPlugin: () => {
        throw new Error("adapter not configured");
      },
    };

    await expect(registerResources(app, { resources: [badResource] })).rejects.toThrow(
      'Resource "broken" failed to register',
    );
  });

  // ── Bootstrap ──

  it("bootstrap has access to fastify.arc", async () => {
    app = await createBareApp();
    let hasArc = false;

    await registerResources(app, {
      bootstrap: [
        async (fastify) => {
          hasArc = !!fastify.arc;
        },
      ],
    });
    await app.ready();

    expect(hasArc).toBe(true);
  });

  it("bootstrap runs sequentially (not parallel)", async () => {
    app = await createBareApp();
    const results: number[] = [];

    await registerResources(app, {
      bootstrap: [
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          results.push(1);
        },
        async () => results.push(2),
      ],
    });

    expect(results).toEqual([1, 2]);
  });

  it("bootstrap error propagates", async () => {
    app = await createBareApp();

    await expect(
      registerResources(app, {
        bootstrap: [
          async () => {
            throw new Error("DB connection failed");
          },
        ],
      }),
    ).rejects.toThrow("DB connection failed");
  });

  // ── Lifecycle ──

  it("onClose fires on shutdown", async () => {
    app = await createBareApp();
    let closed = false;

    await registerResources(app, {
      onClose: async () => {
        closed = true;
      },
    });
    await app.ready();
    await app.close();

    expect(closed).toBe(true);
    app = null!; // already closed
  });

  // ── Edge cases ──

  it("empty resources array is fine", async () => {
    app = await createBareApp();
    await registerResources(app, { resources: [] });
    await app.ready();
  });

  it("no config at all is fine", async () => {
    app = await createBareApp();
    await registerResources(app, {});
    await app.ready();
  });
});
