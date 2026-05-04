/**
 * Cross-surface contract test.
 *
 * Pins the invariant that "one `defineResource()` call → matching shapes
 * across every introspection surface arc ships":
 *
 *   1. `ResourceRegistry.enumerateRoutes()` — the single source of truth
 *      for "what wire routes does this resource expose?"
 *   2. `ResourceRegistry.getIntrospection()` — what the `arc introspect`
 *      CLI consumes
 *   3. `buildOpenApiSpec()` — what `/openapi.json` and external doc
 *      consumers see
 *   4. `describeResource()` — what `arc describe` emits per resource
 *      (consumed by AI agents / tooling)
 *   5. `resourceToTools()` — MCP tool surface
 *
 * Every prior round of OpenAI review surfaced a "this surface lags that
 * surface" drift — actions disappearing from describe, aggregations
 * disappearing from OpenAPI, route counts undercounted in stats. Each
 * was fixed structurally in its own commit. This test prevents the
 * whole class of drift from coming back: any new route source, action
 * type, or aggregation type that lands has to satisfy every surface or
 * the contract assertions here fail.
 *
 * The fixture intentionally exercises every concern at once so a future
 * surface that "forgets" about one input is caught without writing 4×
 * separate scenarios.
 */

import { describe, expect, it, vi } from "vitest";
import { describeResource } from "../../src/cli/commands/describe.js";
import { defineAggregation } from "../../src/core/aggregation/index.js";
import type { ResourceDefinition } from "../../src/core/defineResource.js";
import { defineResource } from "../../src/core/defineResource.js";
import { buildOpenApiSpec } from "../../src/docs/openapi.js";
import { resourceToTools } from "../../src/integrations/mcp/resourceToTools.js";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import { ResourceRegistry } from "../../src/registry/ResourceRegistry.js";
import type { RegistryEntry } from "../../src/types/index.js";

// ============================================================================
// Fixture — one resource exercising every introspection input
// ============================================================================

interface OrderDoc {
  _id?: string;
  status: "pending" | "paid" | "refunded";
  totalPrice: number;
}

/**
 * Stub controller — MCP CRUD tool generation requires a controller, but
 * the contract assertions only inspect tool *shape*, never invoke them.
 * The `repository` field is read by `buildAggregationTools` to thread
 * the repo into the aggregation handler; runtime aggregation execution
 * is out of scope here.
 */
function stubController() {
  const noop = vi.fn().mockResolvedValue({ data: null, status: 200 });
  return {
    list: noop,
    get: noop,
    create: noop,
    update: noop,
    delete: noop,
    repository: {},
  };
}

function buildOrderResource(): ResourceDefinition<OrderDoc> {
  return defineResource<OrderDoc>({
    name: "order",
    prefix: "/orders",
    skipValidation: true,
    controller: stubController() as never,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: requireRoles(["customer"]),
      update: requireRoles(["staff"]),
      delete: requireRoles(["admin"]),
    },
    routes: [
      {
        method: "POST",
        path: "/checkout",
        handler: "checkout",
        permissions: requireRoles(["customer"]),
        summary: "Run the checkout flow",
      },
    ],
    actions: {
      approve: {
        handler: vi.fn().mockResolvedValue({ ok: true }),
        permissions: requireRoles(["staff"]),
        description: "Approve a pending order",
      },
      cancel: {
        handler: vi.fn().mockResolvedValue({ ok: true }),
        permissions: requireRoles(["staff"]),
      },
    },
    actionPermissions: requireRoles(["staff"]),
    aggregations: {
      revenueByStatus: defineAggregation({
        groupBy: "status",
        measures: { count: "count", revenue: "sum:totalPrice" },
        permissions: requireRoles(["admin"]),
      }),
      monthlyRevenue: defineAggregation({
        summary: "Monthly revenue rollup",
        groupBy: "status",
        measures: { revenue: "sum:totalPrice" },
        permissions: requireRoles(["admin"]),
        requireDateRange: { field: "createdAt", maxRangeDays: 90 },
      }),
    },
  });
}

/**
 * Build a `RegistryEntry` matching what `ResourceRegistry.register()`
 * produces. We bypass the full `register()` path so the test stays a
 * pure unit test (no plugin wiring, no Fastify boot).
 */
function registerOrder(resource: ResourceDefinition<OrderDoc>): {
  registry: ResourceRegistry;
  entry: RegistryEntry;
} {
  const registry = new ResourceRegistry();
  registry.register(resource as never);
  const entry = registry.get("order");
  if (!entry) throw new Error("fixture failed to register");
  return { registry, entry };
}

// ============================================================================
// Cross-surface assertions
// ============================================================================

describe("Cross-surface contract — registry / OpenAPI / CLI describe / CLI introspect / MCP", () => {
  // --------------------------------------------------------------------------
  // (1) Route surface — every wire route appears in every "wire" surface
  // --------------------------------------------------------------------------

  it("the wire route set is identical across enumerateRoutes / introspection / OpenAPI", () => {
    const fixture = buildOrderResource();
    const { registry, entry } = registerOrder(fixture);

    // OpenAPI emits OAS-3 path syntax (`/orders/{id}`); registry emits
    // Fastify route syntax (`/orders/:id`). Same logical route — normalize
    // to one form before comparing. If a future change drops the `id`
    // placeholder entirely from one surface, this normalization still
    // catches it (different segment count).
    const toFastifyPath = (p: string): string => p.replace(/\{([^}]+)\}/g, ":$1");

    const enumerated = new Set(registry.enumerateRoutes(entry).map((r) => `${r.method} ${r.path}`));
    const introspected = new Set(
      registry.getIntrospection().resources[0].routes.map((r) => `${r.method} ${r.path}`),
    );
    const openapi = new Set<string>();
    const spec = buildOpenApiSpec([entry]);
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        if (item[method]) openapi.add(`${method.toUpperCase()} ${toFastifyPath(path)}`);
      }
    }

    // Pre-flight: the fixture really does exercise CRUD + custom + action +
    // aggregations. If this fails, the fixture has regressed.
    expect(enumerated.size).toBeGreaterThanOrEqual(9);

    // All three wire surfaces describe the same logical route set.
    expect(introspected).toEqual(enumerated);
    expect(openapi).toEqual(enumerated);
  });

  it("aggregation-only routes survive in every surface (closes 2.13 OpenAPI early-return regression)", () => {
    const fixture = defineResource<OrderDoc>({
      name: "metrics",
      prefix: "/metrics",
      skipValidation: true,
      disableDefaultRoutes: true,
      controller: stubController() as never,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      aggregations: {
        dailyRevenue: defineAggregation({
          groupBy: "status",
          measures: { revenue: "sum:totalPrice" },
          permissions: allowPublic(),
        }),
      },
    });

    const registry = new ResourceRegistry();
    registry.register(fixture as never);
    const entry = registry.get("metrics");
    if (!entry) throw new Error("metrics did not register");

    const aggPath = "/metrics/aggregations/dailyRevenue";

    // Registry sees it
    expect(
      registry.enumerateRoutes(entry).some((r) => r.path === aggPath && r.method === "GET"),
    ).toBe(true);

    // OpenAPI emits it (no early-return guard drops it)
    const spec = buildOpenApiSpec([entry]);
    expect(spec.paths[aggPath]).toBeDefined();
    expect(spec.paths[aggPath]?.get).toBeDefined();

    // MCP exposes it
    const tools = resourceToTools(fixture as never);
    expect(tools.find((t) => t.name === "aggregation_dailyRevenue_metrics")).toBeDefined();

    // CLI describe surfaces it
    const described = describeResource(fixture as never);
    expect(described.aggregations.find((a) => a.name === "dailyRevenue")).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // (2) Action parity — every declared action appears in every surface
  // --------------------------------------------------------------------------

  it("every declared action appears across registry / OpenAPI / describe / MCP", () => {
    const fixture = buildOrderResource();
    const { registry, entry } = registerOrder(fixture);
    const declared = Object.keys(fixture.actions ?? {}); // ['approve', 'cancel']
    expect(declared).toEqual(["approve", "cancel"]);

    // Registry — actions surfaced as metadata
    const registryNames = (entry.actions ?? []).map((a) => a.name);
    expect(registryNames.sort()).toEqual([...declared].sort());

    // OpenAPI — single dispatch endpoint POST /:id/action exists when
    // any action is declared. Per-action discrimination lives in the
    // request body schema (oneOf).
    const spec = buildOpenApiSpec([entry]);
    expect(spec.paths["/orders/{id}/action"]?.post).toBeDefined();

    // Describe — full per-action surface (name, perm, schema flag)
    const described = describeResource(fixture as never);
    expect(described.actions.map((a) => a.name).sort()).toEqual([...declared].sort());

    // MCP — one tool per action, named `${action}_${resource}`
    const tools = resourceToTools(fixture as never);
    const toolNames = new Set(tools.map((t) => t.name));
    for (const action of declared) {
      expect(toolNames).toContain(`${action}_order`);
    }
  });

  // --------------------------------------------------------------------------
  // (3) Aggregation parity — every declared aggregation appears in every surface
  // --------------------------------------------------------------------------

  it("every declared aggregation appears across registry / OpenAPI / describe / MCP", () => {
    const fixture = buildOrderResource();
    const { registry, entry } = registerOrder(fixture);
    const declared = Object.keys(fixture.aggregations ?? {});
    expect(declared).toEqual(["revenueByStatus", "monthlyRevenue"]);

    // Registry — aggregation metadata is surfaced
    const registryNames = (entry.aggregations ?? []).map((a) => a.name);
    expect(registryNames.sort()).toEqual([...declared].sort());

    // OpenAPI — one GET /:resource/aggregations/:name path per aggregation
    const spec = buildOpenApiSpec([entry]);
    for (const name of declared) {
      expect(spec.paths[`/orders/aggregations/${name}`]?.get).toBeDefined();
    }

    // Describe — full per-aggregation surface (name, summary, measures, perm)
    const described = describeResource(fixture as never);
    expect(described.aggregations.map((a) => a.name).sort()).toEqual([...declared].sort());

    // MCP — one tool per aggregation, named `aggregation_${name}_${resource}`
    const tools = resourceToTools(fixture as never);
    const toolNames = new Set(tools.map((t) => t.name));
    for (const name of declared) {
      expect(toolNames).toContain(`aggregation_${name}_order`);
    }
  });

  // --------------------------------------------------------------------------
  // (4) Permission parity — auth requirement is consistent across surfaces
  // --------------------------------------------------------------------------

  it("auth requirements for the same operation match across OpenAPI / describe / MCP", () => {
    const fixture = buildOrderResource();
    const { entry } = registerOrder(fixture);

    // OpenAPI: `security` array set ⇔ auth required
    const spec = buildOpenApiSpec([entry]);
    const openapiListAuth = !!spec.paths["/orders"]?.get?.security?.length;
    const openapiCreateAuth = !!spec.paths["/orders"]?.post?.security?.length;
    expect(openapiListAuth).toBe(false); // allowPublic
    expect(openapiCreateAuth).toBe(true); // requireRoles

    // Describe: per-op permission shape carries the type
    const described = describeResource(fixture as never);
    expect(described.permissions.list?.type).toBe("public");
    expect(described.permissions.create?.type).toBe("requireRoles");
    expect(described.permissions.create?.roles).toEqual(["customer"]);

    // MCP: list_orders is a CRUD tool — its handler enforces the same
    // permission chain at invocation time. The contract here is that
    // the tool exists for both public and authed ops; runtime enforcement
    // is unit-tested in tests/integrations/mcp/mcp-permissions.test.ts.
    const tools = resourceToTools(fixture as never);
    expect(tools.find((t) => t.name === "list_orders")).toBeDefined();
    expect(tools.find((t) => t.name === "create_order")).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // (5) Stat parity — getStats().totalRoutes matches enumerateRoutes().length
  // --------------------------------------------------------------------------

  it("getStats().totalRoutes equals the sum of enumerateRoutes() across all resources", () => {
    const fixture = buildOrderResource();
    const { registry, entry } = registerOrder(fixture);

    const expected = registry.enumerateRoutes(entry).length;
    expect(registry.getStats().totalRoutes).toBe(expected);
  });

  // --------------------------------------------------------------------------
  // (6) Custom-route parity — host `routes:` declarations are first-class
  // --------------------------------------------------------------------------

  it("custom routes declared via `routes:` appear in every wire surface", () => {
    const fixture = buildOrderResource();
    const { registry, entry } = registerOrder(fixture);

    // Wire path the host declared
    const customPath = "/orders/checkout";

    expect(
      registry.enumerateRoutes(entry).some((r) => r.path === customPath && r.method === "POST"),
    ).toBe(true);

    const spec = buildOpenApiSpec([entry]);
    expect(spec.paths[customPath]?.post).toBeDefined();

    const intro = registry.getIntrospection();
    expect(
      intro.resources[0].routes.some((r) => r.path === customPath && r.method === "POST"),
    ).toBe(true);

    const described = describeResource(fixture as never);
    expect(described.routes.some((r) => r.path === customPath && r.method === "POST")).toBe(true);

    // MCP — POST custom routes become tools (named by `operation` or
    // slugified path). The `checkout` handler is a string handler, so
    // MCP requires a controller (we provided one in the fixture).
    const tools = resourceToTools(fixture as never);
    expect(tools.find((t) => t.name.includes("checkout"))).toBeDefined();
  });
});
