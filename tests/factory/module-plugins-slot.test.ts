/**
 * `ArcModule.plugins` is a SETUP function, not a Fastify plugin.
 *
 * Arc CALLS it — it is never handed to `fastify.register()`. That makes one
 * specific mistake silent and expensive: a module author returns a plugin
 * expecting arc to register it, arc reads the return value as a disposer,
 * nothing registers at boot, and the plugin is invoked at SHUTDOWN with no
 * arguments. Nothing in the type signature distinguishes the two.
 *
 * So the mistake is detected: certain (`fastify-plugin` markers) throws,
 * probable (a multi-argument function, when disposers take none) warns.
 */

import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineModule } from "../../src/factory/index.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("ArcModule.plugins — returned-value contract", () => {
  it("THROWS when a fastify-plugin is returned instead of registered", async () => {
    const wouldNeverRun = fp(async (instance) => {
      instance.decorate("neverRegistered", true);
    });

    await expect(
      createApp({
        logger: false,
        auth: false,
        modules: [defineModule({ name: "infra", plugins: async () => wouldNeverRun as never })],
      }),
    ).rejects.toThrow(/returned a fastify-plugin from plugins\(\)/);
  });

  it("WARNS on a multi-argument function — disposers are called with none", async () => {
    const warn = vi.fn();
    app = await createApp({
      logger: false,
      auth: false,
      plugins: async (f) => {
        Object.assign(f.log, { warn });
      },
      modules: [
        defineModule({
          name: "infra",
          // The bare-plugin shape: (fastify, opts) — no fp() markers to go on.
          plugins: async () => (async (_fastify: unknown, _opts: unknown) => {}) as never,
        }),
      ],
    });

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/looks like a Fastify plugin/));
  });

  it("a zero-argument disposer is the supported shorthand — no warning, runs at close", async () => {
    const warn = vi.fn();
    const closed = vi.fn();
    app = await createApp({
      logger: false,
      auth: false,
      plugins: async (f) => {
        Object.assign(f.log, { warn });
      },
      modules: [defineModule({ name: "infra", plugins: async () => closed })],
    });

    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/looks like a Fastify plugin/));
    expect(closed).not.toHaveBeenCalled();
    await app.close();
    app = undefined;
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("registering INSIDE plugins() is the correct shape and hits the shared instance", async () => {
    // Documents the encapsulation consequence: no register() wrapper around
    // plugins() means a decorate() lands where every other module sees it.
    app = await createApp({
      logger: false,
      auth: false,
      modules: [
        defineModule({
          name: "infra",
          plugins: async (fastify) => {
            await fastify.register(
              fp(async (instance) => {
                instance.decorate("registeredProperly", true);
              }),
            );
          },
        }),
      ],
    });

    expect(app.hasDecorator("registeredProperly")).toBe(true);
  });

  it("the guard does not disturb an ordinary Fastify plugin registration", async () => {
    // Sanity: fp() plugins registered the normal way are untouched by the
    // marker check — it only inspects what plugins() RETURNS.
    const bare = Fastify({ logger: false });
    await bare.register(fp(async (i) => i.decorate("ok", true)));
    await bare.ready();
    expect(bare.hasDecorator("ok")).toBe(true);
    await bare.close();
  });
});
