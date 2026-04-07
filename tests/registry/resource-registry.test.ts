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
    additionalRoutes: [],
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
        additionalRoutes: [
          { method: "POST", path: "/approve", handler: "approve", wrapHandler: true },
        ],
      }),
    );
    const entry = registry.get("users")!;
    expect(entry.additionalRoutes).toHaveLength(1);
    expect(entry.additionalRoutes[0].method).toBe("POST");
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
});
