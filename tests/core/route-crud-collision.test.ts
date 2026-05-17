/**
 * Custom route ↔ auto-CRUD path collision detection.
 *
 * Before 2.17, declaring `routes: [{ method: 'POST', path: '/', ... }]` on a
 * resource that hadn't disabled `create` produced a cryptic
 * `FST_ERR_DUPLICATED_ROUTE` at `app.register()` time — Fastify's error
 * doesn't mention arc's `disabledRoutes` option, doesn't distinguish
 * "collided with auto-CRUD" from "collided with another custom route",
 * and forces the consumer to grep arc's source to discover the fix.
 *
 * 2.17 moves the detection to `defineResource()` validation so the
 * error fires inline at definition time with a message naming the
 * conflicting CRUD op and the literal fix to add.
 */

import { describe, expect, it } from "vitest";
import { allowPublic, defineResource } from "../../src/index.js";
import { createMockRepositoryMock } from "../setup.js";

function mockAdapter() {
  return {
    type: "mock",
    name: "test",
    repository: createMockRepositoryMock(),
    // biome-ignore lint/suspicious/noExplicitAny: adapter shape varies; the validator only reads `.repository`.
  } as any;
}

describe("defineResource — route ↔ auto-CRUD collision detection", () => {
  it("throws when a custom POST / collides with auto-CRUD `create`", () => {
    expect(() =>
      defineResource({
        name: "stat",
        prefix: "/stats",
        adapter: mockAdapter(),
        permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic() },
        routes: [
          {
            method: "POST",
            path: "/",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      }),
    ).toThrow(/collides with auto-CRUD "create"/);
  });

  it("error message names the exact `disabledRoutes` line to add", () => {
    try {
      defineResource({
        name: "stat",
        prefix: "/stats",
        adapter: mockAdapter(),
        permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic() },
        routes: [
          {
            method: "POST",
            path: "/",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      });
      expect.fail("should have thrown");
    } catch (err) {
      // The actionable fix must be in the message so the dev doesn't grep
      // arc's source.
      expect((err as Error).message).toContain("disabledRoutes: ['create']");
    }
  });

  it("throws when a custom GET /:id collides with auto-CRUD `get`", () => {
    expect(() =>
      defineResource({
        name: "report",
        prefix: "/reports",
        adapter: mockAdapter(),
        permissions: { list: allowPublic(), get: allowPublic() },
        routes: [
          {
            method: "GET",
            path: "/:id",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      }),
    ).toThrow(/collides with auto-CRUD "get"/);
  });

  it("throws when a custom DELETE /:id collides with auto-CRUD `delete`", () => {
    expect(() =>
      defineResource({
        name: "doc",
        prefix: "/docs",
        adapter: mockAdapter(),
        permissions: { list: allowPublic(), get: allowPublic(), delete: allowPublic() },
        routes: [
          {
            method: "DELETE",
            path: "/:id",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      }),
    ).toThrow(/collides with auto-CRUD "delete"/);
  });

  it("respects `updateMethod: 'PUT'` (custom PUT /:id collides, custom PATCH /:id does not)", () => {
    expect(() =>
      defineResource({
        name: "doc",
        prefix: "/docs",
        adapter: mockAdapter(),
        permissions: { list: allowPublic(), get: allowPublic(), update: allowPublic() },
        updateMethod: "PUT",
        routes: [
          {
            method: "PUT",
            path: "/:id",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      }),
    ).toThrow(/collides with auto-CRUD "update"/);

    // PATCH /:id is free when updateMethod is 'PUT' — no collision.
    expect(() =>
      defineResource({
        name: "doc2",
        prefix: "/docs2",
        adapter: mockAdapter(),
        permissions: { list: allowPublic(), get: allowPublic(), update: allowPublic() },
        updateMethod: "PUT",
        routes: [
          {
            method: "PATCH",
            path: "/:id",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      }),
    ).not.toThrow();
  });

  it("respects `updateMethod: 'both'` — both PUT and PATCH on /:id collide", () => {
    for (const method of ["PUT", "PATCH"] as const) {
      expect(() =>
        defineResource({
          name: `doc-${method.toLowerCase()}`,
          prefix: `/docs-${method.toLowerCase()}`,
          adapter: mockAdapter(),
          permissions: { list: allowPublic(), get: allowPublic(), update: allowPublic() },
          updateMethod: "both",
          routes: [
            {
              method,
              path: "/:id",
              handler: async () => ({ ok: true }),
              permissions: allowPublic(),
            },
          ],
        }),
      ).toThrow(/collides with auto-CRUD "update"/);
    }
  });

  it("does NOT throw when the colliding CRUD op is in `disabledRoutes`", () => {
    // The documented fix — opt out of the auto-CRUD `create` so the custom POST owns `/`.
    expect(() =>
      defineResource({
        name: "stat",
        prefix: "/stats",
        adapter: mockAdapter(),
        permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic() },
        disabledRoutes: ["create"],
        routes: [
          {
            method: "POST",
            path: "/",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      }),
    ).not.toThrow();
  });

  it("does NOT throw when `disableDefaultRoutes: true` (no auto-CRUD at all)", () => {
    expect(() =>
      defineResource({
        name: "stat",
        prefix: "/stats",
        permissions: { list: allowPublic() },
        disableDefaultRoutes: true,
        routes: [
          {
            method: "POST",
            path: "/",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
          {
            method: "GET",
            path: "/:id",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      }),
    ).not.toThrow();
  });

  it("does NOT throw when paths differ — custom GET /search alongside auto-CRUD list", () => {
    // The auto-CRUD list is GET /, custom is GET /search — disjoint paths.
    expect(() =>
      defineResource({
        name: "post",
        prefix: "/posts",
        adapter: mockAdapter(),
        permissions: { list: allowPublic(), get: allowPublic() },
        routes: [
          {
            method: "GET",
            path: "/search",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      }),
    ).not.toThrow();
  });

  it("does NOT throw when methods differ on the same path — auto-CRUD POST + custom PUT on /", () => {
    // POST / is `create`; PUT / is a custom path with no CRUD counterpart.
    expect(() =>
      defineResource({
        name: "ping",
        prefix: "/pings",
        adapter: mockAdapter(),
        permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic() },
        routes: [
          {
            method: "PUT",
            path: "/",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      }),
    ).not.toThrow();
  });

  it("reports BOTH collisions when a single resource declares two colliding routes", () => {
    try {
      defineResource({
        name: "stat",
        prefix: "/stats",
        adapter: mockAdapter(),
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          delete: allowPublic(),
        },
        routes: [
          {
            method: "POST",
            path: "/",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
          {
            method: "DELETE",
            path: "/:id",
            handler: async () => ({ ok: true }),
            permissions: allowPublic(),
          },
        ],
      });
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      // Both collisions surface in a single throw — the dev sees the
      // complete fix list, not a one-at-a-time peel.
      expect(msg).toMatch(/collides with auto-CRUD "create"/);
      expect(msg).toMatch(/collides with auto-CRUD "delete"/);
    }
  });
});
