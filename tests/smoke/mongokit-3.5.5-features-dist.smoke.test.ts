/**
 * Smoke test: MongoKit 3.5.5 features through Arc's BUILT dist output.
 *
 * Imports from `../../dist/...` (not `../../src/...`) so we exercise exactly
 * what npm consumers will get when they install `@classytic/arc`. If this
 * test passes, the published package supports:
 *
 *   - The geo operator suffixes (`location_near`, `location_withinRadius`,
 *     `location_geoWithin`, `location_nearSphere`) via the MCP integration's
 *     `expandOperatorKeys`
 *   - PermissionResult.scope propagation via `applyPermissionResult`
 *   - Service scope helpers (`isService`, `getClientId`, `getServiceScopes`)
 *
 * No real DB, no real MongoKit instance — pure data-shape assertions against
 * the compiled output. Heavier integration tests live in
 * `tests/integrations/mongokit-*.test.ts` and run against MongoDB.
 */

import { describe, expect, it } from "vitest";

describe("MongoKit 3.5.5 features — built dist smoke test", () => {
  it("resourceToTools (dist) generates an MCP list_* tool whose handler rewrites geo operator keys", async () => {
    // Indirectly validates the dist's expandOperatorKeys via the public
    // surface — feed a list tool a geo operator arg and inspect what the
    // controller receives. If the dist is missing the geo operator suffixes,
    // the controller's `req.query` will contain `location_near` as a flat
    // string instead of `{ location: { near: "..." } }`.
    const { resourceToTools } = await import("../../dist/integrations/mcp/index.mjs");

    const seen: { query?: Record<string, unknown> } = {};
    const fakeController = {
      list: async (req: { query: Record<string, unknown> }) => {
        seen.query = req.query;
        return { success: true, data: [] };
      },
      get: async () => ({ success: true, data: { _id: "1" } }),
      create: async () => ({ success: true, data: {} }),
      update: async () => ({ success: true, data: {} }),
      delete: async () => ({ success: true }),
    };

    const tools = resourceToTools({
      name: "place",
      displayName: "Place",
      tag: "Place",
      prefix: "/places",
      controller: fakeController,
      schemaOptions: {
        fieldRules: { name: { type: "string", required: true } },
        filterableFields: [],
        hiddenFields: [],
        readonlyFields: [],
      },
      permissions: {},
      routes: [],
      middlewares: {},
      disableDefaultRoutes: false,
      disabledRoutes: [],
      customSchemas: {},
      events: {},
      _appliedPresets: [],
      _pendingHooks: [],
    } as unknown as Parameters<typeof resourceToTools>[0]);

    const listTool = tools.find((t: { name: string }) => t.name === "list_places");
    if (!listTool) throw new Error("list_places not generated");

    await listTool.handler(
      {
        location_near: "-122.4,37.7,5000",
        location_withinRadius: "-122.4,37.7,2000",
        location_geoWithin: "-122.45,37.75,-122.40,37.79",
        price_gt: 10,
      },
      { session: null, log: async () => {}, extra: {} },
    );

    expect(seen.query).toEqual({
      location: {
        near: "-122.4,37.7,5000",
        withinRadius: "-122.4,37.7,2000",
        geoWithin: "-122.45,37.75,-122.40,37.79",
      },
      price: { gt: 10 },
    });
  });

  it("applyPermissionResult installs scope + filters from dist", async () => {
    // Re-exported from the permissions barrel for discoverability. The
    // package's `sideEffects: false` lets bundlers tree-shake this away
    // for users who never import it. Internal Arc call sites bypass the
    // barrel and import "./applyPermissionResult.js" directly.
    const { applyPermissionResult, normalizePermissionResult } = await import(
      "../../dist/permissions/index.mjs"
    );

    const req: Record<string, unknown> = {};
    const result = normalizePermissionResult({
      granted: true,
      scope: {
        kind: "service",
        clientId: "client-1",
        organizationId: "org-1",
        scopes: ["jobs:write"],
      },
      filters: { projectId: "proj-1" },
    });

    applyPermissionResult(result, req as Parameters<typeof applyPermissionResult>[1]);

    expect(req.scope).toEqual({
      kind: "service",
      clientId: "client-1",
      organizationId: "org-1",
      scopes: ["jobs:write"],
    });
    expect(req._policyFilters).toEqual({ projectId: "proj-1" });
  });

  it("scope helpers handle service kind from dist", async () => {
    const { isService, getClientId, getOrgId, getServiceScopes } = await import(
      "../../dist/scope/index.mjs"
    );

    const service = {
      kind: "service" as const,
      clientId: "c1",
      organizationId: "o1",
      scopes: ["read"],
    };

    expect(isService(service)).toBe(true);
    expect(getClientId(service)).toBe("c1");
    expect(getOrgId(service)).toBe("o1");
    expect(getServiceScopes(service)).toEqual(["read"]);
  });

  it("MongoKit 3.5.5 QueryParser getters are accessible (peer dep contract)", async () => {
    // Doesn't import from dist — just verifies the peer dep at >=3.5.5
    // exposes the getters Arc's MCP integration auto-derives `filterableFields`
    // from. If this fails, an upstream MongoKit refactor broke our contract.
    const { QueryParser } = await import("@classytic/mongokit");
    const qp = new QueryParser({
      allowedFilterFields: ["x"],
      allowedSortFields: ["y"],
      allowedOperators: ["eq", "gt"],
    });

    expect(qp.allowedFilterFields).toEqual(["x"]);
    expect(qp.allowedSortFields).toEqual(["y"]);
    expect(qp.allowedOperators).toEqual(["eq", "gt"]);
    // schemaIndexes getter — empty when no schema, but the property must exist.
    expect(qp.schemaIndexes).toEqual({ geoFields: [], textFields: [], other: [] });
  });
});
