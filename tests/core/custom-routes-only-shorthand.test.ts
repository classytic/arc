/**
 * `customRoutesOnly: true` shorthand on `defineResource`.
 *
 * Pins:
 *   - Expands to disableDefaultRoutes + skipValidation + skipRegistry.
 *   - Explicit narrow flags win over the shorthand (no clobber).
 *   - Service resource (no adapter, no controller, only custom routes)
 *     boots cleanly under the shorthand — previously required all three
 *     flags set in lockstep or boot failed with confusing errors.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";

describe("customRoutesOnly shorthand", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  it("expands to disableDefaultRoutes + skipValidation + skipRegistry", () => {
    const r = defineResource({
      name: "health",
      customRoutesOnly: true,
      routes: [
        {
          method: "GET",
          path: "/ping",
          permissions: allowPublic(),
          handler: async () => ({ ok: true }),
        },
      ],
    });

    expect(r.disableDefaultRoutes).toBe(true);
    expect(r.routes).toHaveLength(1);
    // Registry skip means no `_registryMeta` populated.
    expect(r._registryMeta).toBeUndefined();
  });

  it("lets explicit narrow flags override the shorthand", () => {
    const r = defineResource({
      name: "audit-view",
      customRoutesOnly: true,
      // Power user wants OpenAPI docs despite the shorthand.
      skipRegistry: false,
      routes: [
        {
          method: "GET",
          path: "/log",
          permissions: allowPublic(),
          handler: async () => ({ entries: [] }),
        },
      ],
    });
    expect(r.disableDefaultRoutes).toBe(true);
    expect(r._registryMeta).toBeDefined();
  });

  it("boots a service resource with no adapter/controller", async () => {
    const r = defineResource({
      name: "health",
      customRoutesOnly: true,
      routes: [
        {
          method: "GET",
          path: "/ping",
          permissions: allowPublic(),
          handler: async () => ({ ok: true }),
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(r.toPlugin());
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/healths/ping" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });

  it("does not affect resources that omit the shorthand", () => {
    const r = defineResource({
      name: "noop",
      disableDefaultRoutes: true, // explicit
      skipValidation: true,
      skipRegistry: true,
    });
    expect(r.disableDefaultRoutes).toBe(true);
  });
});
