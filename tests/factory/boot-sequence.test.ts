/**
 * createApp() Boot Sequence Tests
 *
 * Tests the enhanced boot order:
 *   1. Arc core (security, auth, events)
 *   2. plugins()      ← infra (DB, SSE, docs)
 *   3. bootstrap[]    ← domain init (singletons, event handlers)
 *   4. resources[]    ← auto-discovered routes
 *   5. afterResources ← post-registration wiring
 *
 * Also tests: resourcePrefix, loadResources({ logger })
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

// ── Helpers ──

function makeResource(name: string) {
  const Model = createMockModel(`Boot${name.charAt(0).toUpperCase()}${name.slice(1)}`);
  const repo = createMockRepository(Model);
  return defineResource({
    name,
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

describe("createApp — boot sequence", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  // ============================================================================
  // resourcePrefix
  // ============================================================================

  describe("resourcePrefix", () => {
    it("prefixes all resource routes under /api/v1", async () => {
      const product = makeResource("product");
      const order = makeResource("order");

      const app = await createApp({
        preset: "testing",
        auth: false,
        resourcePrefix: "/api/v1",
        resources: [product, order],
      });
      await app.ready();

      // Prefixed routes work
      const products = await app.inject({ method: "GET", url: "/api/v1/products" });
      expect(products.statusCode).toBe(200);

      const orders = await app.inject({ method: "GET", url: "/api/v1/orders" });
      expect(orders.statusCode).toBe(200);

      // Root routes don't exist
      const rootProducts = await app.inject({ method: "GET", url: "/products" });
      expect(rootProducts.statusCode).toBe(404);

      await app.close();
    });

    it("full CRUD works under prefix", async () => {
      const item = makeResource("item");

      const app = await createApp({
        preset: "testing",
        auth: false,
        resourcePrefix: "/api",
        resources: [item],
      });
      await app.ready();

      // Create
      const create = await app.inject({
        method: "POST",
        url: "/api/items",
        payload: { name: "Widget", isActive: true },
      });
      expect(create.statusCode).toBe(201);
      const id = create.json().data._id;

      // Get
      const get = await app.inject({ method: "GET", url: `/api/items/${id}` });
      expect(get.statusCode).toBe(200);
      expect(get.json().data.name).toBe("Widget");

      // Update
      const update = await app.inject({
        method: "PATCH",
        url: `/api/items/${id}`,
        payload: { name: "Super Widget" },
      });
      expect(update.statusCode).toBe(200);

      // List
      const list = await app.inject({ method: "GET", url: "/api/items" });
      expect(list.statusCode).toBe(200);
      expect(list.json().docs.length).toBeGreaterThanOrEqual(1);

      // Delete
      const del = await app.inject({ method: "DELETE", url: `/api/items/${id}` });
      expect(del.statusCode).toBe(200);

      await app.close();
    });

    it("no prefix (default) registers at root", async () => {
      const thing = makeResource("thing");

      const app = await createApp({
        preset: "testing",
        auth: false,
        resources: [thing],
      });
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/things" });
      expect(res.statusCode).toBe(200);

      await app.close();
    });

    it("prefix with trailing slash is normalized", async () => {
      const widget = makeResource("widget");

      const app = await createApp({
        preset: "testing",
        auth: false,
        resourcePrefix: "/api/v2/",
        resources: [widget],
      });
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/api/v2/widgets" });
      expect(res.statusCode).toBe(200);

      await app.close();
    });
  });

  // ============================================================================
  // bootstrap
  // ============================================================================

  describe("bootstrap", () => {
    it("runs bootstrap functions before resources", async () => {
      const order: string[] = [];

      const app = await createApp({
        preset: "testing",
        auth: false,
        plugins: async () => {
          order.push("plugins");
        },
        bootstrap: [
          async () => {
            order.push("bootstrap-1");
          },
          async () => {
            order.push("bootstrap-2");
          },
        ],
        resources: [],
      });
      await app.ready();

      expect(order).toEqual(["plugins", "bootstrap-1", "bootstrap-2"]);

      await app.close();
    });

    it("bootstrap has access to fastify instance (DB, events ready)", async () => {
      let hasFastify = false;
      let hasArc = false;

      const app = await createApp({
        preset: "testing",
        auth: false,
        bootstrap: [
          async (fastify) => {
            hasFastify = !!fastify.inject; // Fastify methods available
            hasArc = !!fastify.arc; // Arc core registered
          },
        ],
      });
      await app.ready();

      expect(hasFastify).toBe(true);
      expect(hasArc).toBe(true);

      await app.close();
    });

    it("bootstrap runs in order (sequential)", async () => {
      const results: number[] = [];

      const app = await createApp({
        preset: "testing",
        auth: false,
        bootstrap: [
          async () => {
            await new Promise((r) => setTimeout(r, 10));
            results.push(1);
          },
          async () => {
            results.push(2);
          },
          async () => {
            results.push(3);
          },
        ],
      });
      await app.ready();

      // Sequential — 1 finishes before 2 starts
      expect(results).toEqual([1, 2, 3]);

      await app.close();
    });

    it("bootstrap error gives clear message", async () => {
      await expect(
        createApp({
          preset: "testing",
          auth: false,
          bootstrap: [
            async () => {
              throw new Error("Redis connection failed");
            },
          ],
        }),
      ).rejects.toThrow("Redis connection failed");
    });

    it("no bootstrap is fine (backward compat)", async () => {
      const app = await createApp({
        preset: "testing",
        auth: false,
      });
      await app.ready();
      await app.close();
    });
  });

  // ============================================================================
  // afterResources
  // ============================================================================

  describe("afterResources", () => {
    it("runs after resources are registered", async () => {
      const order: string[] = [];
      const res = makeResource("post");

      const app = await createApp({
        preset: "testing",
        auth: false,
        bootstrap: [
          async () => {
            order.push("bootstrap");
          },
        ],
        resources: [res],
        afterResources: async (fastify) => {
          order.push("afterResources");
          // Routes should already be registered at this point
          const result = await fastify.inject({ method: "GET", url: "/posts" });
          order.push(`routes-status:${result.statusCode}`);
        },
      });
      await app.ready();

      expect(order[0]).toBe("bootstrap");
      expect(order[1]).toBe("afterResources");
      // Routes are registered by the time afterResources runs
      expect(order[2]).toBe("routes-status:200");

      await app.close();
    });
  });

  // ============================================================================
  // Full boot order verification
  // ============================================================================

  describe("full boot order", () => {
    it("executes in correct sequence: plugins → bootstrap → resources → afterResources → onReady", async () => {
      const order: string[] = [];
      const res = makeResource("task");

      const app = await createApp({
        preset: "testing",
        auth: false,
        plugins: async () => {
          order.push("plugins");
        },
        bootstrap: [
          async () => {
            order.push("bootstrap");
          },
        ],
        resources: [res],
        afterResources: async () => {
          order.push("afterResources");
        },
        onReady: async () => {
          order.push("onReady");
        },
      });
      await app.ready();

      expect(order).toEqual(["plugins", "bootstrap", "afterResources", "onReady"]);

      await app.close();
    });
  });
});

// ============================================================================
// loadResources — logger injection (silent default; 2.11.1+)
// ============================================================================

describe("loadResources — logger fallback to arcLog", () => {
  const TMP = join(import.meta.dirname, "__tmp_boot_silent__");

  afterAll(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it("omitted logger — falls back to arcLog (warnings reach console.warn by default)", async () => {
    mkdirSync(TMP, { recursive: true });

    // File that matches pattern but has no toPlugin
    writeFileSync(
      join(TMP, "factory.resource.ts"),
      "export default function createAccountResource() { return {}; };\n",
    );
    // Valid resource
    writeFileSync(
      join(TMP, "valid.resource.ts"),
      "export default { name: 'valid', toPlugin: () => () => {} };\n",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // No logger injected → arcLog handles it (canonical arc behavior:
    // warnings visible by default, suppressible via ARC_SUPPRESS_WARNINGS=1
    // or routable via configureArcLogger({ writer })).
    const loaded = await loadResources(TMP);

    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("valid");

    // arcLog defaults to console.warn — the factory-failure messages
    // should have surfaced (with `[arc:loadResources]` prefix).
    const arcWarn = warnSpy.mock.calls.find((c) => String(c[0]).includes("[arc:loadResources]"));
    expect(arcWarn).toBeDefined();

    warnSpy.mockRestore();
  });

  it("injected logger — overrides arcLog fallback, warnings flow through `warn(msg)`", async () => {
    const dir = join(TMP, "noisy");
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "bad.resource.ts"), "export default { notAResource: true };\n");

    const warnSpy = vi.fn();
    await loadResources(dir, { logger: { warn: warnSpy } });

    const skipMsg = warnSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes("skipped"));
    expect(skipMsg).toBeDefined();
  });

  it("no-op logger — callable shape, output discarded, nothing leaks to console", async () => {
    const dir = join(TMP, "noop");
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "broken.resource.ts"),
      "import { nope } from '@nonexistent/pkg';\nexport default { name: 'broken', toPlugin: () => () => {} };\n",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const noopWarn = vi.fn();

    // Pass `{ warn: () => {} }` to fully suppress per-call (overrides
    // arcLog fallback). For global suppression use ARC_SUPPRESS_WARNINGS=1.
    const loaded = await loadResources(dir, { logger: { warn: noopWarn } });

    expect(loaded).toHaveLength(0);
    expect(noopWarn).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
