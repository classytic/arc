import { describe, expect, it } from "vitest";
import { ResourceRegistry } from "../../src/registry/ResourceRegistry.js";

/** Minimal mock resource definition */
function mockResource(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    displayName: name,
    tag: name,
    prefix: `/${name}`,
    adapter: { type: "memory", name: "mock" },
    permissions: {},
    _appliedPresets: [],
    routes: [],
    events: {},
    disableDefaultRoutes: false,
    updateMethod: "PATCH",
    disabledRoutes: [],
    fields: {},
    toPlugin: () => async () => {},
    ...overrides,
  } as never;
}

describe("ResourceRegistry", () => {
  it("registers and retrieves a resource", () => {
    const registry = new ResourceRegistry();
    registry.register(mockResource("users"));
    expect(registry.has("users")).toBe(true);
    expect(registry.get("users")).toBeDefined();
    expect(registry.get("users")?.name).toBe("users");
  });

  it("prevents duplicate registration", () => {
    const registry = new ResourceRegistry();
    registry.register(mockResource("users"));
    expect(() => registry.register(mockResource("users"))).toThrow("already registered");
  });

  it("returns undefined for unregistered resource", () => {
    const registry = new ResourceRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("getAll returns all registered resources", () => {
    const registry = new ResourceRegistry();
    registry.register(mockResource("users"));
    registry.register(mockResource("posts"));
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.name).sort()).toEqual(["posts", "users"]);
  });

  it("getByModule filters by module", () => {
    const registry = new ResourceRegistry();
    registry.register(mockResource("users"), { module: "core" });
    registry.register(mockResource("posts"), { module: "blog" });
    registry.register(mockResource("comments"), { module: "blog" });
    const blogResources = registry.getByModule("blog");
    expect(blogResources).toHaveLength(2);
  });

  it("getByPreset filters by applied preset", () => {
    const registry = new ResourceRegistry();
    registry.register(mockResource("users", { _appliedPresets: ["softDelete", "audited"] }));
    registry.register(mockResource("posts", { _appliedPresets: ["softDelete"] }));
    registry.register(mockResource("logs", { _appliedPresets: [] }));
    expect(registry.getByPreset("softDelete")).toHaveLength(2);
    expect(registry.getByPreset("audited")).toHaveLength(1);
  });

  it("freeze prevents further registrations", () => {
    const registry = new ResourceRegistry();
    registry.register(mockResource("users"));
    registry.freeze();
    expect(() => registry.register(mockResource("posts"))).toThrow("frozen");
  });

  it("supports chaining on register", () => {
    const registry = new ResourceRegistry();
    const result = registry.register(mockResource("users"));
    expect(result).toBe(registry);
  });

  it("tracks additional routes", () => {
    const registry = new ResourceRegistry();
    registry.register(
      mockResource("users", {
        routes: [{ method: "POST", path: "/approve", handler: "approve", raw: false }],
      }),
    );
    const entry = registry.get("users")!;
    expect(entry.customRoutes).toHaveLength(1);
    expect(entry.customRoutes?.[0].method).toBe("POST");
  });

  it("records events from resource definition", () => {
    const registry = new ResourceRegistry();
    registry.register(
      mockResource("orders", {
        events: { "order.created": {}, "order.shipped": {} },
      }),
    );
    const entry = registry.get("orders")!;
    expect(entry.events).toEqual(["order.created", "order.shipped"]);
  });

  // ==========================================================================
  // 2.13 — single source of truth for "what routes does this resource expose?"
  //
  // Pre-2.13, getStats() and getIntrospection() each rolled their own route
  // enumeration:
  //   - getStats() counted CRUD + custom + a synthetic action route, but
  //     contributed 0 for aggregations.
  //   - getIntrospection() emitted CRUD + custom routes, but omitted both
  //     declarative actions and aggregations entirely.
  // Both paths are now backed by enumerateRoutes() so the surface stays in
  // lockstep with OpenAPI / Fastify mounting. Adding a new route source
  // (e.g. future webhook routes) only needs one edit there.
  // ==========================================================================

  it("enumerateRoutes lists CRUD + custom + actions + aggregations as a single list", () => {
    const registry = new ResourceRegistry();
    registry.register(
      mockResource("orders", {
        routes: [{ method: "POST", path: "/checkout", handler: "checkout" }],
        actions: { approve: () => undefined, cancel: () => undefined },
        aggregations: {
          revenueByStatus: { permissions: () => true, measures: { count: "count" } },
          monthlyRevenue: { permissions: () => true, measures: { revenue: "sum:totalPrice" } },
        },
      }),
    );

    const entry = registry.get("orders")!;
    const rows = registry.enumerateRoutes(entry);

    // 5 CRUD + 1 custom + 1 unified action + 2 aggregations = 9
    expect(rows).toHaveLength(9);
    expect(rows.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        "GET /orders",
        "GET /orders/:id",
        "POST /orders",
        "PATCH /orders/:id",
        "DELETE /orders/:id",
        "POST /orders/checkout",
        "POST /orders/:id/action",
        "GET /orders/aggregations/revenueByStatus",
        "GET /orders/aggregations/monthlyRevenue",
      ]),
    );
  });

  it("getStats().totalRoutes counts every route source — including aggregations", () => {
    const registry = new ResourceRegistry();
    registry.register(
      mockResource("plain", {}), // 5 CRUD
    );
    registry.register(
      mockResource("withAgg", {
        disableDefaultRoutes: true,
        aggregations: {
          a: { permissions: () => true, measures: { count: "count" } },
          b: { permissions: () => true, measures: { count: "count" } },
          c: { permissions: () => true, measures: { count: "count" } },
        },
      }),
    );

    // 5 (plain CRUD) + 3 (aggregations on a route-disabled resource) = 8
    expect(registry.getStats().totalRoutes).toBe(8);
  });

  it("getIntrospection().resources[].routes surfaces actions + aggregations", () => {
    const registry = new ResourceRegistry();
    registry.register(
      mockResource("orders", {
        actions: { approve: () => undefined },
        aggregations: {
          revenueByStatus: { permissions: () => true, measures: { count: "count" } },
        },
      }),
    );

    const intro = registry.getIntrospection();
    const orderRoutes = intro.resources[0].routes.map((r) => `${r.method} ${r.path}`);

    expect(orderRoutes).toContain("POST /orders/:id/action");
    expect(orderRoutes).toContain("GET /orders/aggregations/revenueByStatus");
  });

  it("aggregation-only resource (disableDefaultRoutes) is NOT dropped from introspection", () => {
    // Pairs with the OpenAPI fix in src/docs/openapi.ts — a resource that
    // exposes only aggregations must remain visible to every introspection
    // consumer (CLI describe, MCP, OpenAPI, registry getIntrospection).
    const registry = new ResourceRegistry();
    registry.register(
      mockResource("metrics", {
        disableDefaultRoutes: true,
        aggregations: {
          dailyRevenue: { permissions: () => true, measures: { revenue: "sum:price" } },
        },
      }),
    );

    const intro = registry.getIntrospection();
    expect(intro.resources).toHaveLength(1);
    expect(intro.resources[0].routes).toEqual([
      {
        method: "GET",
        path: "/metrics/aggregations/dailyRevenue",
        operation: "aggregation:dailyRevenue",
        summary: undefined,
      },
    ]);
  });
});
