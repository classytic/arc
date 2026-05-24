/**
 * `tryRegisterRoute` — FST_ERR_DUPLICATED_ROUTE friendly rewrap
 *
 * Boot-time `validateRouteCrudCollisions()` already prevents the common
 * cause (custom-route vs auto-CRUD), but Fastify itself can still surface
 * `FST_ERR_DUPLICATED_ROUTE` when:
 *   - Two presets emit the same custom route
 *   - Two resources mount at the same prefix
 *   - A custom plugin pre-registered the URL
 *
 * In all of those, the operator's first instinct should be
 * `disabledRoutes: ['<op>']` — this test pins that the rewrap names that
 * fix and preserves the FST_ERR_DUPLICATED_ROUTE code for callers that
 * branch on `err.code`.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { tryRegisterRoute } from "../../src/core/routerShared.js";
import type { FastifyWithDecorators } from "../../src/types/index.js";

describe("tryRegisterRoute — duplicate route hint", () => {
  it("rewraps FST_ERR_DUPLICATED_ROUTE with a `disabledRoutes` hint when op is a CRUD slot", async () => {
    const fastify = Fastify({ logger: false });
    fastify.route({
      method: "GET",
      url: "/widgets",
      handler: async () => ({ data: [] }),
    });

    expect(() =>
      tryRegisterRoute(
        fastify as unknown as FastifyWithDecorators,
        {
          method: "GET",
          url: "/widgets",
          handler: async () => ({ data: [] }),
        },
        { resourceName: "widget", op: "list" },
      ),
    ).toThrow(/disabledRoutes:\s*\['list'\]/);

    await fastify.close();
  });

  it("preserves the FST_ERR_DUPLICATED_ROUTE code on the rewrapped error", async () => {
    const fastify = Fastify({ logger: false });
    fastify.route({
      method: "POST",
      url: "/items",
      handler: async () => ({}),
    });

    let caught: unknown;
    try {
      tryRegisterRoute(
        fastify as unknown as FastifyWithDecorators,
        { method: "POST", url: "/items", handler: async () => ({}) },
        { resourceName: "item", op: "create" },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("FST_ERR_DUPLICATED_ROUTE");
    expect((caught as { cause?: unknown }).cause).toBeDefined();

    await fastify.close();
  });

  it("names the resource and method+path in the message", async () => {
    const fastify = Fastify({ logger: false });
    fastify.route({
      method: "PATCH",
      url: "/orders/:id",
      handler: async () => ({}),
    });

    expect(() =>
      tryRegisterRoute(
        fastify as unknown as FastifyWithDecorators,
        { method: "PATCH", url: "/orders/:id", handler: async () => ({}) },
        { resourceName: "order", op: "update" },
      ),
    ).toThrow(/PATCH \/orders\/:id.*"order".*update/s);

    await fastify.close();
  });

  it("falls back to a generic disabledRoutes hint for non-CRUD op names", async () => {
    const fastify = Fastify({ logger: false });
    fastify.route({
      method: "POST",
      url: "/cart/checkout",
      handler: async () => ({}),
    });

    expect(() =>
      tryRegisterRoute(
        fastify as unknown as FastifyWithDecorators,
        { method: "POST", url: "/cart/checkout", handler: async () => ({}) },
        { resourceName: "cart", op: "checkout" },
      ),
    ).toThrow(/disabledRoutes:\s*\['list'\s*\|\s*'get'/);

    await fastify.close();
  });

  it("rethrows non-duplicate errors unchanged", () => {
    const fastify = {
      route: () => {
        throw new TypeError("schema is invalid");
      },
    } as unknown as FastifyWithDecorators;

    expect(() =>
      tryRegisterRoute(
        fastify,
        { method: "GET", url: "/x", handler: async () => ({}) },
        { resourceName: "x" },
      ),
    ).toThrow(TypeError);
    expect(() =>
      tryRegisterRoute(
        fastify,
        { method: "GET", url: "/x", handler: async () => ({}) },
        { resourceName: "x" },
      ),
    ).toThrow(/schema is invalid/);
  });
});
