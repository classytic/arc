/**
 * ResourceDefinition leaf-config immutability
 *
 * Once `defineResource()` returns, the resulting `ResourceDefinition` is
 * the framework's view of the contract — every downstream surface (CRUD
 * router, action router, OpenAPI builder, MCP tool generator, registry)
 * reads from the same instance. Hosts have no business mutating those
 * slots after the fact: a runtime `myResource.permissions.create =
 * bypass` would silently downgrade authz, and the existing `readonly`
 * markers protect only the *property* slot, not the underlying object.
 *
 * The constructor freezes the leaf config slots after a fresh shallow
 * copy, so:
 *   1. The host's original config object is never frozen (we own the copy).
 *   2. Strict-mode mutation throws — silent authz downgrades become loud
 *      programmer errors.
 *
 * Frozen slots are the security-relevant ones: `permissions`, `routes`,
 * `events`, `disabledRoutes`, `customSchemas`, `schemaOptions`. Nested
 * objects beyond one level (`permissions.create.someProperty`) are not
 * frozen — that's an explicit cost/value choice, since deep-freezing
 * every config tree at boot is expensive and the surface area worth
 * protecting is exactly the top-level "what gates apply / what routes
 * exist" decisions.
 */

import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";

describe("ResourceDefinition leaf-config immutability", () => {
  it("freezes `permissions` so post-define mutation throws in strict mode", () => {
    const resource = defineResource({
      name: "widget",
      disableDefaultRoutes: true,
      skipValidation: true,
      permissions: {
        create: requireRoles(["admin"]),
        list: allowPublic(),
      },
    });

    expect(Object.isFrozen(resource.permissions)).toBe(true);
    // ESM modules run in strict mode — assignment to a frozen object throws.
    expect(() => {
      (resource.permissions as Record<string, unknown>).create = allowPublic();
    }).toThrow(TypeError);
  });

  it("freezes `routes` so the array can't be mutated after define", () => {
    const resource = defineResource({
      name: "widget",
      disableDefaultRoutes: true,
      skipValidation: true,
      routes: [
        {
          method: "GET",
          path: "/ping",
          handler: () => ({ pong: true }),
          permissions: allowPublic(),
        },
      ],
    });

    expect(Object.isFrozen(resource.routes)).toBe(true);
    expect(() => {
      (resource.routes as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it("deep-freezes each route object so `routes[0].permissions = bypass` throws", () => {
    // A shallow array freeze stops `routes.push()` but still lets a
    // host mutate `routes[0].permissions = allowPublic()` and silently
    // downgrade authz on a registered route. Each route entry is
    // frozen too — the "framework owns the contract once define()
    // returns" guarantee covers the full registered surface.
    const resource = defineResource({
      name: "widget",
      disableDefaultRoutes: true,
      skipValidation: true,
      routes: [
        {
          method: "POST",
          path: "/charge",
          handler: () => ({ ok: true }),
          permissions: requireRoles(["admin"]),
        },
      ],
    });

    const route = resource.routes[0]!;
    expect(Object.isFrozen(route)).toBe(true);
    expect(() => {
      (route as { permissions: unknown }).permissions = allowPublic();
    }).toThrow(TypeError);
    expect(() => {
      (route as { handler: unknown }).handler = () => ({ bypass: true });
    }).toThrow(TypeError);
  });

  it("freezes `actions` map AND each ActionDefinition entry", () => {
    const resource = defineResource({
      name: "order",
      disableDefaultRoutes: true,
      skipValidation: true,
      permissions: { update: requireRoles(["admin"]) },
      actions: {
        // Object-form: full ActionDefinition with permissions
        approve: {
          handler: async (id) => ({ id, approved: true }),
          permissions: requireRoles(["admin"]),
        },
        // Function-shorthand: closure reference is immutable in
        // practice; only the map slot needs freezing.
        ping: async (id) => ({ id, pong: true }),
      },
    });

    expect(Object.isFrozen(resource.actions)).toBe(true);
    expect(() => {
      (resource.actions as Record<string, unknown>).newAction = async () => undefined;
    }).toThrow(TypeError);

    const approve = resource.actions?.approve as { permissions: unknown };
    expect(Object.isFrozen(approve)).toBe(true);
    expect(() => {
      approve.permissions = allowPublic();
    }).toThrow(TypeError);
  });

  it("freezes `events`, `disabledRoutes`, `customSchemas`, `schemaOptions`", () => {
    const resource = defineResource({
      name: "widget",
      disableDefaultRoutes: true,
      skipValidation: true,
      events: { created: { schema: { type: "object" } } },
      disabledRoutes: ["delete"],
      customSchemas: { create: { body: { type: "object" } } },
      schemaOptions: { stripFields: ["secret"] },
    });

    expect(Object.isFrozen(resource.events)).toBe(true);
    expect(Object.isFrozen(resource.disabledRoutes)).toBe(true);
    expect(Object.isFrozen(resource.customSchemas)).toBe(true);
    expect(Object.isFrozen(resource.schemaOptions)).toBe(true);
  });

  it("does NOT freeze the host's original config object", () => {
    const userPermissions = {
      create: requireRoles(["admin"]),
    };
    const userRoutes: unknown[] = [];

    defineResource({
      name: "widget",
      disableDefaultRoutes: true,
      skipValidation: true,
      permissions: userPermissions,
      routes: userRoutes as never,
    });

    // The host must remain free to keep evolving its own config object —
    // arc's freeze applies to its internal copy, not the caller's reference.
    expect(Object.isFrozen(userPermissions)).toBe(false);
    expect(Object.isFrozen(userRoutes)).toBe(false);
  });
});
