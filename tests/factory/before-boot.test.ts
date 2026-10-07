/**
 * `beforeBoot` — the pre-boot lifecycle slot (2.21).
 *
 * Pins the load-bearing ordering contract: beforeBoot resolves BEFORE module
 * thunks, before `plugins()`, before `bootstrap[]`, and before the
 * `resources` factory — so a host's DB connection is provably open by the
 * time any engine-owning module code evaluates. This replaces the
 * hand-orchestrated `await connectDatabase()` + dynamic-import tricks hosts
 * carried in their composition roots.
 */

import { describe, expect, it } from "vitest";
import { createApp, defineModule } from "../../src/factory/index.js";

describe("createApp — beforeBoot lifecycle slot", () => {
  it("runs before module thunk resolution, plugins(), bootstrap[], and the resources factory", async () => {
    const order: string[] = [];

    const app = await createApp({
      auth: false,
      logger: false,
      beforeBoot: async () => {
        // Simulate an async DB connect — anything after must observe it.
        await new Promise((r) => setImmediate(r));
        order.push("beforeBoot");
      },
      modules: [
        () => {
          order.push("module-thunk");
          return Promise.resolve(defineModule({ name: "probe", bootstrap: () => ({}) }));
        },
      ],
      plugins: async () => {
        order.push("plugins");
      },
      bootstrap: [
        () => {
          order.push("bootstrap");
        },
      ],
      resources: () => {
        order.push("resources-factory");
        return [];
      },
    });

    expect(order[0]).toBe("beforeBoot");
    expect(order.indexOf("beforeBoot")).toBeLessThan(order.indexOf("module-thunk"));
    expect(order.indexOf("beforeBoot")).toBeLessThan(order.indexOf("plugins"));
    expect(order.indexOf("plugins")).toBeLessThan(order.indexOf("bootstrap"));
    expect(order.indexOf("bootstrap")).toBeLessThan(order.indexOf("resources-factory"));

    await app.close();
  });

  it("a throwing beforeBoot aborts boot before any Fastify instance work", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        beforeBoot: () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toThrow("db down");
  });

  it("a returned disposer runs once on close, AFTER every plugin's onClose", async () => {
    const order: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      beforeBoot: () => () => void order.push("dispose"),
      plugins: async (f) => {
        f.addHook("onClose", async () => void order.push("plugin-close"));
      },
    });
    await app.close();
    await app.close();
    expect(order).toEqual(["plugin-close", "dispose"]);
  });

  it("a boot that fails BEFORE Fastify exists still runs the disposer", async () => {
    let disposed = 0;
    await expect(
      createApp({
        auth: false,
        logger: false,
        beforeBoot: () => () => void disposed++,
        modules: [defineModule({ name: "a", dependsOn: ["missing"] })],
      }),
    ).rejects.toThrow(/missing/);
    expect(disposed).toBe(1);
  });

  it("a boot that fails AFTER Fastify exists runs the disposer exactly once", async () => {
    let disposed = 0;
    await expect(
      createApp({
        auth: false,
        logger: false,
        beforeBoot: () => () => void disposed++,
        plugins: async () => {
          throw new Error("plugin boom");
        },
      }),
    ).rejects.toThrow("plugin boom");
    expect(disposed).toBe(1);
  });

  it("boots normally when beforeBoot is omitted", async () => {
    const app = await createApp({ auth: false, logger: false });
    expect(app).toBeDefined();
    await app.close();
  });
});
