import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { requireRoles } from "../../src/permissions/index.js";
import { introspectRegistry } from "../../src/permissions/matrix.js";

/**
 * Custom-route gates in the permission matrix.
 *
 * ## The defect this closes
 *
 * `introspectRegistry` walked `permissions`, `actions` and `aggregations` — each
 * of which has a stable name — and SKIPPED `routes`. A resource whose gates live
 * entirely on `routes[]` therefore published nothing and, because a module with
 * an empty map is dropped, was ABSENT from the matrix altogether.
 *
 * The consequence was not a missing feature, it was an invisible one: every
 * `can(module, verb)` against it answers `false`, so a UI that gates on it hides
 * the capability from EVERYONE including admins. That presents as "my permissions
 * are broken" rather than "this key was never published" — and the two are
 * indistinguishable from the client, which is why four screens shipped ungated
 * rather than wrongly gated.
 *
 * Found in `@classytic/commerce-ui`: `integration`, `stock-move-group`,
 * `sku-classification` and `sku-slot-assignment` all declare route-only gates.
 */
const registry = (
  entries: Parameters<typeof introspectRegistry>[0] extends { getAll(): infer R } ? R : never,
) => ({ getAll: () => entries });

describe("introspectRegistry — route capabilities", () => {
  it("publishes a route gate that OPTED IN via `capability`", () => {
    const modules = introspectRegistry(
      registry([
        {
          name: "sku-classification",
          permissions: { list: requireRoles(["staff"]), get: requireRoles(["staff"]) },
          customRoutes: [
            {
              method: "POST",
              path: "/recompute",
              capability: "recompute",
              permissions: requireRoles(["admin"]),
            },
          ],
        },
      ] as never),
    );

    // BARE key, alongside the CRUD slots — a consumer asks `can(mod, 'recompute')`
    // and never needs to know the verb is implemented as a route.
    expect(Object.keys(modules["sku-classification"] ?? {}).sort()).toEqual([
      "get",
      "list",
      "recompute",
    ]);
    expect(modules["sku-classification"]?.recompute).toBeDefined();
  });

  it("a routes-ONLY resource is now present in the matrix at all", () => {
    /**
     * The exact shape that produced the bug: `disableDefaultRoutes`, no
     * `permissions` map, no `actions`. It contributed zero keys, so the module was
     * dropped and every gate against it resolved to denied.
     */
    const modules = introspectRegistry(
      registry([
        {
          name: "integration",
          customRoutes: [
            {
              method: "POST",
              path: "/:id/test",
              capability: "test",
              permissions: requireRoles(["admin"]),
            },
          ],
        },
      ] as never),
    );

    expect(modules.integration).toBeDefined();
    expect(modules.integration?.test).toBeDefined();
  });

  it("SKIPS a route that did not opt in — a path is not an identity", () => {
    /**
     * Deliberately opt-in: keying automatically off `method + path` would mean a
     * path rename silently breaks every client gating on it. A route with no
     * `capability` is still ENFORCED; it is simply not advertised.
     */
    const modules = introspectRegistry(
      registry([
        {
          name: "thing",
          permissions: { list: requireRoles(["staff"]) },
          customRoutes: [{ method: "GET", path: "/health", permissions: requireRoles(["admin"]) }],
        },
      ] as never),
    );

    expect(Object.keys(modules.thing ?? {})).toEqual(["list"]);
  });

  it("THROWS on a collision rather than letting one gate answer for another verb", () => {
    const build = () =>
      introspectRegistry(
        registry([
          {
            name: "thing",
            permissions: { create: requireRoles(["staff"]) },
            customRoutes: [
              {
                method: "POST",
                path: "/bulk",
                // Collides with the CRUD slot above.
                capability: "create",
                permissions: requireRoles(["admin"]),
              },
            ],
          },
        ] as never),
      );

    // Silent overwrite would publish the ADMIN gate as the answer for `create`,
    // which staff actually hold — a wrong answer indistinguishable from a right one.
    expect(build).toThrow(/collision on resource "thing"/);
    expect(build).toThrow(/capability "create"/);
  });

  it("also refuses a collision with an `action:` key", () => {
    expect(() =>
      introspectRegistry(
        registry([
          {
            name: "thing",
            actions: [{ name: "approve", permissions: requireRoles(["manager"]) }],
            customRoutes: [
              {
                method: "POST",
                path: "/approve-all",
                capability: "action:approve",
                permissions: requireRoles(["staff"]),
              },
            ],
          },
        ] as never),
      ),
    ).toThrow(/collision/);
  });
});

/**
 * The collision must be refused at BOOT, not at introspection.
 *
 * `introspectRegistry` is a HOST api — nothing inside arc calls it — and hosts
 * call it from a permission-matrix endpoint. So a duplicate `capability` used to
 * surface only as a 500 on that endpoint, at request time, in production. Because
 * a UI reads its whole permission map from there, one static config typo took
 * every client's gates out at once instead of failing the deploy.
 *
 * The key is decidable from the config alone, so `defineResource` decides it.
 */
describe("route `capability` collisions — refused at boot", () => {
  const route = (path: string, capability: string) => ({
    method: "POST" as const,
    path,
    capability,
    permissions: requireRoles(["admin"]),
    rawHandler: async () => ({ ok: true }),
  });

  it("throws when a route capability collides with a CRUD slot", () => {
    expect(() =>
      defineResource({
        name: "sku",
        disableDefaultRoutes: true,
        permissions: { list: requireRoles(["admin"]) },
        routes: [route("/recompute", "list")],
      }),
    ).toThrow(/capability 'list'.*already published by a CRUD slot/s);
  });

  it("throws when two routes claim the same capability", () => {
    expect(() =>
      defineResource({
        name: "sku",
        disableDefaultRoutes: true,
        routes: [route("/recompute", "recompute"), route("/rebuild", "recompute")],
      }),
    ).toThrow(/capability 'recompute'.*already published by a route POST \/recompute/s);
  });

  it("allows distinct capabilities, and routes that do not opt in", () => {
    expect(() =>
      defineResource({
        name: "sku",
        disableDefaultRoutes: true,
        permissions: { list: requireRoles(["admin"]) },
        routes: [
          route("/recompute", "recompute"),
          route("/rebuild", "rebuild"),
          {
            method: "GET" as const,
            path: "/health",
            permissions: requireRoles(["admin"]),
            rawHandler: async () => ({ ok: true }),
          },
        ],
      }),
    ).not.toThrow();
  });
});
