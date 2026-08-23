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

import Fastify from "fastify";
import fp from "fastify-plugin";
import { describe, expect, it, vi } from "vitest";
import { defineModule } from "../../src/factory/index.js";
import { arcApp, arcAppRefuses } from "../_harness/index.js";

describe("ArcModule.plugins — returned-value contract", () => {
  it("THROWS when a fastify-plugin is returned instead of registered", async () => {
    const wouldNeverRun = fp(async (instance) => {
      instance.decorate("neverRegistered", true);
    });

    await arcAppRefuses(
      { modules: [defineModule({ name: "infra", plugins: async () => wouldNeverRun as never })] },
      /returned a fastify-plugin from plugins\(\)/,
    );
  });

  it("WARNS on a multi-argument function — disposers are called with none", async () => {
    const warn = vi.fn();
    const app = await arcApp({
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
    const app = await arcApp({
      plugins: async (f) => {
        Object.assign(f.log, { warn });
      },
      modules: [defineModule({ name: "infra", plugins: async () => closed })],
    });

    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/looks like a Fastify plugin/));
    expect(closed).not.toHaveBeenCalled();
    // Closing EARLY is the point of this test. No `app = undefined` needed:
    // the harness's teardown tolerates an already-closed app, which is what
    // the old mutable-`let` pattern was working around.
    await app.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("registering INSIDE plugins() is the correct shape and hits the shared instance", async () => {
    // Documents the encapsulation consequence: no register() wrapper around
    // plugins() means a decorate() lands where every other module sees it.
    const app = await arcApp({
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
