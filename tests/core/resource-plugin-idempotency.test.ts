/**
 * Resource plugin idempotency
 *
 * `resource.toPlugin()` mutates shared instance state on every Fastify
 * registration: `arc.hooks.register(...)` for each pending preset hook,
 * `arc.registry.register(...)` for the resource itself, and
 * `registerCacheInvalidationRule(...)` for each invalidate-on entry.
 *
 * If the same resource is mounted at multiple prefixes (multi-version APIs
 * `/v1`/`/v2`, multi-tenant subpath mounts, hot-reload test setups), the
 * outer plugin closure runs once per registration. Without an idempotency
 * guard each pass appends to the shared registries — a 2-prefix mount
 * doubles every preset hook, fires every event/cache invalidation rule
 * twice, and registers the resource twice.
 *
 * The fix tracks "this Fastify instance has already absorbed this resource's
 * shared-state writes" via a `WeakSet` on the resource. Routes still
 * register inside their per-prefix encapsulation (Fastify owns that — and
 * a same-prefix collision is a programmer error we want to surface, not
 * silence).
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { defineResource } from "../../src/core/defineResource.js";

describe("Resource plugin idempotency", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it("registers preset hooks exactly once even when mounted at multiple prefixes", async () => {
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);

    // Build a resource with no controller / no routes so the plugin focuses
    // on the shared-state writes (hooks, registry, cache rules).
    const resource = defineResource({
      name: "widget",
      disableDefaultRoutes: true,
      skipValidation: true,
    });

    // Manually push a hook into `_pendingHooks` — same shape that presets
    // produce. Avoids pulling in a real preset (which would couple the
    // test to schema metadata).
    resource._pendingHooks.push({
      operation: "create",
      phase: "before",
      handler: () => undefined,
      priority: 10,
    });

    // Mount at two distinct prefixes — Fastify allows this; route
    // encapsulation keeps them independent. The outer plugin closure
    // (which writes to `arc.hooks`) runs twice.
    await app.register(resource.toPlugin(), { prefix: "/v1" });
    await app.register(resource.toPlugin(), { prefix: "/v2" });
    await app.ready();

    const hooks = app.arc.hooks.getForResource("widget");
    expect(hooks).toHaveLength(1);
  });

  it("registers cache invalidation rules exactly once across multiple mounts", async () => {
    app = Fastify({ logger: false });

    const recordedRules: Array<{ pattern: string; tags: string[] }> = [];
    app.decorate("registerCacheInvalidationRule", (rule: { pattern: string; tags: string[] }) => {
      recordedRules.push(rule);
    });

    await app.register(arcCorePlugin);

    const resource = defineResource({
      name: "post",
      disableDefaultRoutes: true,
      skipValidation: true,
      cache: {
        invalidateOn: {
          "user:*": ["author"],
        },
      },
    });

    await app.register(resource.toPlugin(), { prefix: "/v1" });
    await app.register(resource.toPlugin(), { prefix: "/v2" });
    await app.ready();

    expect(recordedRules).toHaveLength(1);
    expect(recordedRules[0]).toEqual({ pattern: "user:*", tags: ["author"] });
  });

  it("preserves per-instance isolation — separate Fastify apps each register their own hooks", async () => {
    const appA = Fastify({ logger: false });
    const appB = Fastify({ logger: false });
    try {
      await appA.register(arcCorePlugin);
      await appB.register(arcCorePlugin);

      const resource = defineResource({
        name: "thing",
        disableDefaultRoutes: true,
        skipValidation: true,
      });
      resource._pendingHooks.push({
        operation: "create",
        phase: "before",
        handler: () => undefined,
        priority: 10,
      });

      // Same resource instance, different Fastify apps — the WeakSet keyed
      // on the host instance must NOT short-circuit registration on appB.
      await appA.register(resource.toPlugin());
      await appB.register(resource.toPlugin());
      await appA.ready();
      await appB.ready();

      expect(appA.arc.hooks.getForResource("thing")).toHaveLength(1);
      expect(appB.arc.hooks.getForResource("thing")).toHaveLength(1);
    } finally {
      await appA.close().catch(() => {});
      await appB.close().catch(() => {});
    }
  });
});
