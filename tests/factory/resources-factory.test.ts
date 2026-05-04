/**
 * `resources` factory form — integration scenarios.
 *
 * Locks in the 2.11 lifecycle extension: `resources` can be a function
 * (sync or async) that runs AFTER `bootstrap[]` but BEFORE Fastify route
 * wiring. The canonical use case is engine-backed adapters that need
 * `await ensureEngine()` before `defineResource(...)` can be called —
 * previously hosts had to write per-resource lazy-bridge adapters that
 * awaited the engine on every CRUD call (pure boilerplate).
 *
 * Scenarios covered:
 *   1. Sync factory returning an array
 *   2. Async factory resolving after an engine bootstrap
 *   3. Factory receives the Fastify instance (symmetric with `plugins`)
 *   4. Factory returns `[]` suppresses `resourceDir` auto-discovery
 *      (matches the array-form contract — explicit beats convention)
 *   5. Factory throws → boot fails with wrapped error + `{ cause }`
 *   6. Factory + `resourceDir` → factory wins (explicit beats convention)
 *   7. Lifecycle order: plugins → bootstrap → factory → resources registered → afterResources
 *   8. Factory delegating to `loadResources` (matches the documented pattern)
 */

import * as path from "node:path";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

describe("createApp — resources factory form", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  function makeResource(name: string, prefix?: string) {
    const Model = createMockModel(`Rf${name.charAt(0).toUpperCase()}${name.slice(1)}`);
    const repo = createMockRepository(Model);
    return defineResource({
      name,
      prefix,
      adapter: createMongooseAdapter({ model: Model, repository: repo }),
      controller: new BaseController(repo, { resourceName: name, tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });
  }

  // ── 1. Sync factory ──────────────────────────────────────────────────────

  it("sync factory returning an array registers resources normally", async () => {
    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      resources: () => [makeResource("rfSyncA", "/rf-sync-a")],
    });
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/rf-sync-a" });
    expect(res.statusCode).toBe(200);
  });

  // ── 2. Async factory awaiting a "bootstrap" engine ───────────────────────

  it("async factory resolves after bootstrap completes — engine-backed adapter pattern", async () => {
    // Simulated engine: a singleton that's `undefined` until bootstrap
    // populates it. Before 2.11.0 this was the crux of the be-prod
    // boilerplate problem — you couldn't pass `engine.repo` into
    // `createMongooseAdapter` at import time because the engine hadn't
    // booted. Now the factory resolves AFTER bootstrap, so `engine` is
    // live by the time `defineResource(...)` runs.
    let engine: { ready: boolean; name: string } | undefined;

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      bootstrap: [
        async () => {
          // Simulate async engine creation (e.g. Mongoose model registration,
          // index builds, warm-up queries).
          await new Promise((r) => setTimeout(r, 5));
          engine = { ready: true, name: "catalog" };
        },
      ],
      resources: async () => {
        expect(engine).toBeDefined();
        expect(engine?.ready).toBe(true);
        // `engine` is live — in a real app this is where you'd pass
        // engine.models.Product / engine.repositories.product into
        // createMongooseAdapter.
        return [makeResource("rfAsyncEngine", "/rf-async-engine")];
      },
    });
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/rf-async-engine" });
    expect(res.statusCode).toBe(200);
  });

  // ── 3. Factory receives Fastify instance (symmetric with `plugins`) ──────

  it("factory receives the Fastify instance as a single positional arg", async () => {
    let receivedFastify: FastifyInstance | undefined;

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      resources: (f) => {
        receivedFastify = f;
        return [makeResource("rfFastifyArg", "/rf-fastify-arg")];
      },
    });
    apps.push(app);
    await app.ready();

    expect(receivedFastify).toBeDefined();
    // Symmetric with plugins/bootstrap — same fastify instance flows through.
    expect(receivedFastify).toBe(app);
  });

  // ── 4. Factory returning [] suppresses resourceDir auto-discovery ────────

  it("factory returning [] disables resourceDir auto-discovery (explicit > convention)", async () => {
    // Regression guard: the empty-array contract must hold for BOTH the
    // array form and the factory form. A factory that deliberately returns
    // [] (e.g. test / CLI / health-check subprocess) must not trigger
    // discovery from a resourceDir that would otherwise populate.
    const warns: string[] = [];
    const logger = {
      level: "warn",
      stream: {
        write: (line: string) => {
          const parsed = JSON.parse(line);
          if (parsed.level === 40) warns.push(String(parsed.msg));
        },
      },
    };

    const app = await createApp({
      preset: "testing",
      auth: false,
      // biome-ignore lint/suspicious/noExplicitAny: Fastify logger shape varies
      logger: logger as any,
      resourceDir: "tests/utils",
      resources: () => [], // empty array via factory — explicit disable
    });
    apps.push(app);
    await app.ready();

    // The final zero-count WARN should fire (no resources), but NOT carry
    // the "discovery scanned" hint — discovery never ran.
    const zeroWarn = warns.find((m) => m.includes("0 resources registered"));
    expect(zeroWarn).toBeDefined();
    expect(zeroWarn).not.toContain("resolved to");
  });

  // ── 5. Factory throw → wrapped error + cause preserved ───────────────────

  it("factory throw wraps with descriptive prefix and preserves original via `cause`", async () => {
    const originalError = Object.assign(new Error("engine boot failed: connection refused"), {
      code: "ECONNREFUSED",
    });

    try {
      const app = await createApp({
        preset: "testing",
        auth: false,
        logger: false,
        resources: async () => {
          throw originalError;
        },
      });
      apps.push(app);
      await app.ready();
      throw new Error("expected createApp to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const wrapper = err as Error & { cause?: unknown };
      // Descriptive prefix from registerResources.
      expect(wrapper.message).toContain("resources factory threw");
      expect(wrapper.message).toContain("engine boot failed: connection refused");
      // Original preserved — callers can walk back to the real throw site,
      // including custom error properties like .code.
      expect(wrapper.cause).toBe(originalError);
      expect((wrapper.cause as Error & { code?: string }).code).toBe("ECONNREFUSED");
    }
  });

  // ── 6. Factory wins over resourceDir ─────────────────────────────────────

  it("factory + resourceDir — factory wins (explicit beats convention)", async () => {
    // Same priority rule as the array form: if `resources` is set
    // (including as a function), `resourceDir` auto-discovery is skipped.
    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      resourceDir: "/does/not/exist/nowhere", // would WARN if discovery ran
      resources: () => [makeResource("rfFactoryWins", "/rf-factory-wins")],
    });
    apps.push(app);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/rf-factory-wins" });
    expect(res.statusCode).toBe(200);
  });

  // ── 7. Lifecycle order ──────────────────────────────────────────────────

  it("lifecycle: plugins → bootstrap → resources-factory → resources-registered → afterResources", async () => {
    const order: string[] = [];

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
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
      resources: async () => {
        order.push("resources-factory");
        return [makeResource("rfOrder", "/rf-order")];
      },
      afterResources: async () => {
        order.push("afterResources");
      },
    });
    apps.push(app);
    await app.ready();

    // Exercising the route proves the resource registered successfully.
    const res = await app.inject({ method: "GET", url: "/rf-order" });
    expect(res.statusCode).toBe(200);

    // Strict ordering — factory runs between bootstrap and afterResources.
    expect(order).toEqual([
      "plugins",
      "bootstrap-1",
      "bootstrap-2",
      "resources-factory",
      "afterResources",
    ]);
  });

  // ── 8. Factory delegating to loadResources ──────────────────────────────

  it("factory can delegate to loadResources(import.meta.url)", async () => {
    // The documented pattern: use the factory slot to run bootstrap first,
    // then hand off to loadResources for auto-discovery. This works today
    // because the factory is just async — you can do anything inside.
    const { loadResources } = await import("../../src/factory/loadResources.js");

    // We point at an empty fixture dir — the important thing is the
    // delegation WORKS, not that it finds specific resources. The behaviour
    // under zero-yield is governed by the existing empty-resources path.
    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      resources: async () => {
        const dir = path.resolve(process.cwd(), "tests/factory/fixtures/non-existent");
        return loadResources(dir);
      },
    });
    apps.push(app);
    await app.ready();
  });

  // ── Type-level: factory form is assignable where array form is ──────────

  it("sync factory returning mixed prefixed + skipGlobalPrefix resources works", async () => {
    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      resourcePrefix: "/api",
      resources: () => [
        // Prefixed — mounts under /api
        makeResource("rfPrefixed", "/rf-prefixed"),
        // Root — skipGlobalPrefix, not affected by /api
        defineResource({
          name: "rfWebhook",
          prefix: "/rf-webhook",
          skipGlobalPrefix: true,
          disableDefaultRoutes: true,
          routes: [
            {
              method: "POST",
              path: "/",
              handler: async (_req, reply) => reply.send({ success: true }),
              raw: true,
              permissions: allowPublic(),
            },
          ],
        }),
      ],
    });
    apps.push(app);
    await app.ready();

    // Prefixed resource lands under /api
    const prefixed = await app.inject({ method: "GET", url: "/api/rf-prefixed" });
    expect(prefixed.statusCode).toBe(200);
    // Root resource skips the /api prefix
    const root = await app.inject({ method: "POST", url: "/rf-webhook" });
    expect(root.statusCode).toBe(200);
    // And /api/rf-webhook does NOT exist
    const collision = await app.inject({ method: "POST", url: "/api/rf-webhook" });
    expect(collision.statusCode).toBe(404);
  });
});
