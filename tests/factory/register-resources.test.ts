/**
 * registerResources — Unit Tests
 *
 * Tests the resource lifecycle in isolation:
 * plugins → bootstrap → resources → afterResources → lifecycle hooks
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

  // ── v2.11 review fixes ──

  describe("explicit `resources: []` disables auto-discovery from resourceDir", () => {
    // Regression: pre-fix `!config.resources?.length` treated an explicit
    // empty array as absent, so auto-discovery still ran and registered
    // whatever it found. That breaks shared-config patterns where a base
    // config declares `resourceDir: import.meta.url` and a caller overrides
    // with `resources: []` to intentionally disable registration (health
    // check subprocesses, CLI jobs, test shims).
    it("explicit empty array suppresses resourceDir auto-discovery", async () => {
      app = await createBareApp();
      // Point `resourceDir` at the resources/ tree used by the standalone
      // discovery tests — it definitely yields > 0 resources. The test
      // passes only if we see ZERO registrations despite the dir pointing
      // at a populated tree, proving the empty array won.
      const { resolve } = await import("node:path");
      const populatedTree = resolve(process.cwd(), "tests/factory/fixtures/resources-dir");

      // We don't care if the fixture dir exists here — if it does, we'd
      // otherwise discover resources; if it doesn't, loadResources returns
      // [] anyway. Either way, `resources: []` should short-circuit before
      // we ever call loadResources.
      await registerResources(app, {
        resourceDir: populatedTree,
        resources: [],
      });
      await app.ready();
      // Success = no throw. A live resource registration failure would
      // surface as a Fastify boot error.
    });

    it("absent `resources` with `resourceDir` still triggers auto-discovery", async () => {
      // Positive control — the priority fix doesn't break the normal path.
      // A resourceDir that doesn't exist yields zero, which is non-strict
      // behaviour (the final zero-count WARN handles diagnostics).
      app = await createBareApp();
      await registerResources(app, {
        resourceDir: "/does/not/exist/nowhere",
      });
      await app.ready();
    });
  });

  describe("registration failure: cleaner wrapping format (v2.14)", () => {
    // The wrapper used to read like:
    //   "Resource "x" failed to register: Resource "x" aggregation
    //    "byStatus" references field "status"... .. Check the resource
    //    definition, adapter, and permissions."
    // — Russian-doll prefix + double period from the inner ArcError's
    // own period being concatenated with the wrapper's. The cleanup:
    //   - strip the redundant inner `Resource "x" ...` prefix
    //   - drop the trailing dot before joining
    //   - separate with an em-dash (` — `) for readability
    //   - drop the boilerplate "Check the resource definition..." tail
    //
    // `cause` chain still preserves the original.

    it("strips the redundant inner `Resource \"name\" ...` prefix", async () => {
      app = await createBareApp();
      const badResource = {
        name: "support",
        skipGlobalPrefix: false,
        toPlugin: () => {
          // Simulates ArcError shape — inner messages start with the
          // same `Resource "name"` prefix the wrapper would add.
          throw new Error(
            'Resource "support" aggregation "byStatus" references field "status".',
          );
        },
      };

      try {
        await registerResources(app, { resources: [badResource] });
        throw new Error("expected throw");
      } catch (err) {
        const msg = (err as Error).message;
        // The "Resource "support" ..." prefix appears EXACTLY once.
        expect(msg.match(/Resource "support"/g)?.length).toBe(1);
        // No double period.
        expect(msg).not.toMatch(/\.\./);
        // The aggregation context survives.
        expect(msg).toContain("aggregation");
        expect(msg).toContain("status");
      }
    });

    it("uses an em-dash separator (readable on a single line)", async () => {
      app = await createBareApp();
      const badResource = {
        name: "broken",
        skipGlobalPrefix: false,
        toPlugin: () => {
          throw new Error("adapter not configured");
        },
      };

      try {
        await registerResources(app, { resources: [badResource] });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as Error).message).toBe(
          'Resource "broken" failed to register — adapter not configured.',
        );
      }
    });

    it("preserves single trailing period when the inner has none", async () => {
      app = await createBareApp();
      const bad = {
        name: "noPeriod",
        skipGlobalPrefix: false,
        toPlugin: () => {
          throw new Error("nope");
        },
      };
      try {
        await registerResources(app, { resources: [bad] });
        throw new Error("expected throw");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg.endsWith(".")).toBe(true);
        expect(msg.endsWith("..")).toBe(false);
      }
    });

    it("works for non-Error throws (string / object)", async () => {
      app = await createBareApp();
      const stringThrower = {
        name: "weird",
        skipGlobalPrefix: false,
        toPlugin: () => {
          // biome-ignore lint/suspicious/noThenProperty: we want to throw a string
          throw "raw string failure";
        },
      };
      try {
        await registerResources(app, { resources: [stringThrower] });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as Error).message).toContain("raw string failure");
        expect((err as Error).message).toContain('Resource "weird"');
      }
    });
  });

  describe("registration failure preserves the original error via `cause`", () => {
    it("throws an error whose `.cause` is the underlying adapter/plugin throw", async () => {
      // Regression: before v2.11 the catch-and-rethrow stringified the
      // message into a new Error and dropped the original reference.
      // `err.cause` chains stacks and property walkability without losing
      // the surface-level diagnostic the wrapper adds.
      app = await createBareApp();

      const original = new Error("adapter boom: db unreachable") as Error & { code?: string };
      original.code = "ECONNREFUSED";

      const failingResource = {
        name: "flaky",
        toPlugin: () => async () => {
          throw original;
        },
      } as unknown as Parameters<typeof registerResources>[1]["resources"] extends
        | readonly (infer T)[]
        | undefined
        ? T
        : never;

      try {
        await registerResources(app, { resources: [failingResource] });
        await app.ready();
        throw new Error("expected registerResources to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const wrapper = err as Error & { cause?: unknown };
        expect(wrapper.message).toContain('Resource "flaky" failed to register');
        // This is the key invariant: the original throw is preserved on `cause`.
        expect(wrapper.cause).toBe(original);
        expect((wrapper.cause as Error & { code?: string }).code).toBe("ECONNREFUSED");
      }
    });
  });

  describe("zero-discovery emits a single combined diagnostic", () => {
    // Regression: pre-fix emitted one WARN at discovery time AND a second
    // WARN in the final zero-count summary — together they read like two
    // separate problems. Now discovery stashes the flag, and the final
    // summary folds in the same hints, producing ONE WARN.
    it("non-strict resourceDir that yields zero → exactly one WARN", async () => {
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
      app = Fastify({
        // biome-ignore lint/suspicious/noExplicitAny: Fastify logger shape varies
        logger: logger as any,
      });
      const { arcCorePlugin } = await import("../../src/plugins/index.js");
      await app.register(arcCorePlugin, { emitEvents: false });

      await registerResources(app, {
        resourceDir: "/does/not/exist/also/nope",
        strictResourceDir: false,
      });
      await app.ready();

      const zeroWarns = warns.filter((m) => m.includes("0 resources registered"));
      expect(zeroWarns).toHaveLength(1);
      // The single WARN should carry BOTH the raw + resolved path AND the
      // file-naming / layout hint — the fold point.
      expect(zeroWarns[0]).toContain("resourceDir");
      expect(zeroWarns[0]).toContain("resolved to");
      expect(zeroWarns[0]).toMatch(/\*\.resource\.\{ts,js,mts,mjs\}/);
    });

    it("strictResourceDir: true still throws immediately (not folded into the summary)", async () => {
      app = await createBareApp();
      await expect(
        registerResources(app, {
          resourceDir: "/does/not/exist/strict",
          strictResourceDir: true,
        }),
      ).rejects.toThrow(/yielded 0 resources/);
    });
  });
});
