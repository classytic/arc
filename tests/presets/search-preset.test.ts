/**
 * Search preset — route wiring + flexibility
 *
 * Validates the preset's contract:
 *   1. Only sections with a `handler` mount routes (opt-in)
 *   2. Default paths are `/search`, `/search-similar`, `/embed`
 *   3. Custom paths, methods, permissions, schemas, operations all override
 *   4. `routes` array appends fully custom routes
 *   5. Handlers receive the request context (body/params/query)
 *   6. Return values are wrapped in `{ success, data }` envelope unless the
 *      handler already returns an envelope
 *   7. End-to-end through `defineResource` → Fastify, the routes actually serve
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, requireAuth } from "../../src/permissions/index.js";
import { searchPreset } from "../../src/presets/search.js";
import type { ResourcePermissions, RouteDefinition } from "../../src/types/index.js";

function extractRoutes(preset: ReturnType<typeof searchPreset>): RouteDefinition[] {
  const perms: ResourcePermissions = {};
  return typeof preset.routes === "function" ? preset.routes(perms) : (preset.routes ?? []);
}

describe("searchPreset — route definitions", () => {
  it("mounts zero routes when no sections are provided", () => {
    const routes = extractRoutes(searchPreset());
    expect(routes).toEqual([]);
  });

  it("mounts only sections with a handler", () => {
    const routes = extractRoutes(
      searchPreset({
        search: { handler: async () => [] },
        // similar: omitted → no route
        // embed: omitted → no route
      }),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe("/search");
    expect(routes[0]?.method).toBe("POST");
  });

  it("uses default paths, methods, and operations for each built-in", () => {
    const routes = extractRoutes(
      searchPreset({
        search: { handler: async () => [] },
        similar: { handler: async () => [] },
        embed: { handler: async () => [0] },
      }),
    );
    const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));
    expect(byPath["/search"]?.operation).toBe("search");
    expect(byPath["/search-similar"]?.operation).toBe("searchSimilar");
    expect(byPath["/embed"]?.operation).toBe("embed");
    expect(routes.every((r) => r.method === "POST")).toBe(true);
  });

  it("custom path, method, operation, schema, mcp override the defaults", () => {
    const schema = { body: { type: "object", properties: { q: { type: "string" } } } };
    const routes = extractRoutes(
      searchPreset({
        search: {
          path: "/abc/search",
          method: "GET",
          operation: "fullText",
          schema,
          mcp: false,
          permissions: requireAuth(),
          handler: async () => [],
        },
      }),
    );
    const r = routes[0];
    expect(r?.path).toBe("/abc/search");
    expect(r?.method).toBe("GET");
    expect(r?.operation).toBe("fullText");
    expect(r?.schema).toBe(schema);
    expect(r?.mcp).toBe(false);
  });

  it("permissions fall back: search/similar → list perm; embed → requireAuth()", () => {
    // Build a PresetResult and pass a realistic `permissions` snapshot
    const preset = searchPreset({
      search: { handler: async () => [] },
      similar: { handler: async () => [] },
      embed: { handler: async () => [0] },
    });
    if (typeof preset.routes !== "function") throw new Error("expected function-form routes");

    const listGate = allowPublic();
    const routes = preset.routes({ list: listGate });
    const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));

    expect(byPath["/search"]?.permissions).toBe(listGate);
    expect(byPath["/search-similar"]?.permissions).toBe(listGate);
    // No explicit permission override → embed gets requireAuth()
    expect(typeof byPath["/embed"]?.permissions).toBe("function");
  });

  it("appends the `routes` array after built-ins, preserving order", () => {
    const extra: RouteDefinition = {
      method: "GET",
      path: "/autocomplete",
      handler: async () => ({ success: true, data: [] }),
      permissions: allowPublic(),
    };
    const routes = extractRoutes(
      searchPreset({
        search: { handler: async () => [] },
        routes: [extra],
      }),
    );
    expect(routes.map((r) => r.path)).toEqual(["/search", "/autocomplete"]);
  });
});

describe("searchPreset — auto-wire from `repository`", () => {
  it("synthesises handlers from repo.search / searchSimilar / embed when section is `true`", async () => {
    const search = vi.fn(async (query: unknown) => [{ id: "s", q: query }]);
    const searchSimilar = vi.fn(async (query: unknown) => [{ id: "v", q: query }]);
    const embed = vi.fn(async (input: unknown) => [0.1, 0.2, Number(`${input}`.length) || 0]);

    const preset = searchPreset({
      repository: { search, searchSimilar, embed },
      search: true,
      similar: true,
      embed: true,
    });
    const routes = extractRoutes(preset);
    expect(routes.map((r) => r.path).sort()).toEqual(["/embed", "/search", "/search-similar"]);

    const callRoute = async (path: string, body: unknown) => {
      const route = routes.find((r) => r.path === path);
      if (!route) throw new Error(`route ${path} not found`);
      const fn = route.handler as (r: unknown) => Promise<unknown>;
      return fn({ body, params: {}, query: {} });
    };

    const sOut = (await callRoute("/search", { query: "widget", limit: 5 })) as {
      success: boolean;
      data: unknown;
    };
    expect(sOut.success).toBe(true);
    expect(search).toHaveBeenCalledWith("widget", { query: "widget", limit: 5 });

    const simOut = (await callRoute("/search-similar", { query: [0.1, 0.2] })) as {
      success: boolean;
    };
    expect(simOut.success).toBe(true);
    expect(searchSimilar).toHaveBeenCalledWith([0.1, 0.2], { query: [0.1, 0.2] });

    const eOut = (await callRoute("/embed", { input: "hello" })) as {
      success: boolean;
      data: number[];
    };
    expect(eOut.success).toBe(true);
    expect(embed).toHaveBeenCalledWith("hello");
    expect(eOut.data[2]).toBe(5);
  });

  it("explicit `handler` on a section wins over the repository method", async () => {
    const repoSearch = vi.fn(async () => "repo-result");
    const override = vi.fn(async () => "override-result");

    const preset = searchPreset({
      repository: { search: repoSearch },
      search: { handler: override },
    });
    const routes = extractRoutes(preset);
    const fn = routes[0]?.handler as (r: unknown) => Promise<unknown>;
    const out = (await fn({ body: {}, params: {}, query: {} })) as {
      success: boolean;
      data: string;
    };
    expect(out.data).toBe("override-result");
    expect(override).toHaveBeenCalledTimes(1);
    expect(repoSearch).not.toHaveBeenCalled();
  });

  it("section `true` without a matching repo method skips the route silently", () => {
    const preset = searchPreset({
      repository: { search: async () => [] }, // no searchSimilar, no embed
      search: true,
      similar: true,
      embed: true,
    });
    const routes = extractRoutes(preset);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe("/search");
  });

  it("custom path + schema still apply when handler is auto-wired", () => {
    const preset = searchPreset({
      repository: { search: async () => [] },
      search: {
        path: "/full-text",
        schema: { body: { type: "object", required: ["query"] } },
      },
    });
    const routes = extractRoutes(preset);
    expect(routes[0]?.path).toBe("/full-text");
    expect(routes[0]?.schema).toBeDefined();
  });
});

describe("searchPreset — per-path MCP opt-out", () => {
  it("mcp: false on a section excludes only that path from MCP tool generation", () => {
    const preset = searchPreset({
      search: { handler: async () => [] /* mcp omitted → default (auto) */ },
      similar: { handler: async () => [], mcp: false },
      embed: { handler: async () => [0] },
    });
    const routes = extractRoutes(preset);
    const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));

    // The preset passes the flag through unchanged so resourceToTools /
    // openapi / mcpPlugin can honour it downstream.
    expect(byPath["/search"]?.mcp).toBeUndefined(); // default → auto
    expect(byPath["/search-similar"]?.mcp).toBe(false); // explicit opt-out
    expect(byPath["/embed"]?.mcp).toBeUndefined();
  });

  it("mcp: false on a route inside `routes` excludes it too", () => {
    const preset = searchPreset({
      routes: [
        {
          method: "POST",
          path: "/reindex",
          handler: async () => ({ success: true, data: null }),
          permissions: allowPublic(),
          mcp: false, // admin route — don't expose to MCP
        },
        {
          method: "POST",
          path: "/facets",
          handler: async () => ({ success: true, data: [] }),
          permissions: allowPublic(),
          // mcp omitted → stays in MCP surface
        },
      ],
    });
    const routes = extractRoutes(preset);
    expect(routes.find((r) => r.path === "/reindex")?.mcp).toBe(false);
    expect(routes.find((r) => r.path === "/facets")?.mcp).toBeUndefined();
  });

  it("mcp accepts a RouteMcpConfig object for per-path description + annotations", () => {
    const mcpConfig = {
      description: "Catalog full-text search",
      annotations: { readOnlyHint: true, openWorldHint: true },
    };
    const preset = searchPreset({
      search: { handler: async () => [], mcp: mcpConfig },
    });
    const routes = extractRoutes(preset);
    expect(routes[0]?.mcp).toBe(mcpConfig);
  });
});

describe("searchPreset — envelope wrapping", () => {
  it("wraps a raw return value into { success, data }", async () => {
    const hit = [{ id: "a" }];
    const handler = vi.fn(async () => hit);
    const routes = extractRoutes(searchPreset({ search: { handler } }));

    type Ctx = Parameters<(typeof routes)[number]["handler"] & object>[0];
    const req = { body: { query: "hello" }, params: {}, query: {} } as unknown as Ctx;
    const fn = routes[0]?.handler as (r: Ctx) => Promise<unknown>;
    const out = await fn(req);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ success: true, data: hit });
  });

  it("passes through an IControllerResponse shape the handler already emits", async () => {
    const response = { success: true, data: ["x"], meta: { total: 1 } };
    const routes = extractRoutes(searchPreset({ search: { handler: async () => response } }));
    const fn = routes[0]?.handler as (r: unknown) => Promise<unknown>;
    const out = await fn({ body: {}, params: {}, query: {} });
    expect(out).toBe(response); // same reference — not re-wrapped
  });

  it("surfaces handler errors to the caller (no swallowing)", async () => {
    const boom = new Error("backend offline");
    const routes = extractRoutes(
      searchPreset({
        search: {
          handler: async () => {
            throw boom;
          },
        },
      }),
    );
    const fn = routes[0]?.handler as (r: unknown) => Promise<unknown>;
    await expect(fn({ body: {}, params: {}, query: {} })).rejects.toBe(boom);
  });
});

describe("searchPreset — end-to-end via createApp", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("serves a custom-backend search at /products/abc/search", async () => {
    // Simulate a bespoke backend — could be Pinecone, ES, Algolia, whatever.
    const backend = vi.fn(async (query: string, limit: number) => ({
      hits: [{ id: "1", title: `match for ${query}`, limit }],
    }));

    const productResource = defineResource({
      name: "product",
      prefix: "/products",
      disableDefaultRoutes: true,
      permissions: { list: allowPublic() },
      presets: [
        searchPreset({
          search: {
            path: "/abc/search",
            handler: async (req) => {
              const body = req.body as { query: string; limit?: number };
              return backend(body.query, body.limit ?? 20);
            },
            schema: {
              body: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  limit: { type: "integer" },
                },
                required: ["query"],
              },
            },
          },
        }),
      ],
    });

    app = await createApp({
      resources: [productResource],
      auth: "none",
      helmet: false,
      cors: false,
      rateLimit: false,
    });

    const good = await app.inject({
      method: "POST",
      url: "/products/abc/search",
      headers: { "content-type": "application/json" },
      payload: { query: "widget", limit: 5 },
    });

    expect(good.statusCode).toBe(200);
    const body = good.json() as { success: boolean; data: { hits: Array<{ title: string }> } };
    expect(body.success).toBe(true);
    expect(body.data.hits[0]?.title).toBe("match for widget");

    expect(backend).toHaveBeenCalledWith("widget", 5);

    // Schema enforcement: missing required `query` → 400, backend NOT called again.
    backend.mockClear();
    const bad = await app.inject({
      method: "POST",
      url: "/products/abc/search",
      headers: { "content-type": "application/json" },
      payload: { limit: 5 },
    });
    expect(bad.statusCode).toBe(400);
    expect(backend).not.toHaveBeenCalled();
  });

  it("accepts a Zod v4 schema and converts it for Fastify validation + OpenAPI", async () => {
    // Arc's convertRouteSchema auto-converts Zod → JSON Schema (draft-7 for
    // Fastify AJV validation, openapi-3.0 for docs). Users can pass
    // `z.object(...)` directly to searchPreset and get both HTTP validation
    // and OpenAPI path entries without calling zod.toJSONSchema() themselves.
    const Fastify = (await import("fastify")).default;
    const { arcCorePlugin } = await import("../../src/core/arcCorePlugin.js");
    const { openApiPlugin } = await import("../../src/docs/openapi.js");

    const backend = vi.fn(async () => [{ id: "z1" }]);

    const searchBody = z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
      filters: z
        .object({
          category: z.string().optional(),
          inStock: z.boolean().optional(),
        })
        .optional(),
    });

    const resource = defineResource({
      name: "product",
      prefix: "/products",
      disableDefaultRoutes: true,
      permissions: { list: allowPublic() },
      presets: [
        searchPreset({
          search: {
            schema: { body: searchBody },
            handler: async () => backend(),
          },
        }),
      ],
    });

    app = Fastify({ logger: false });
    await app.register(arcCorePlugin);
    await app.register(resource.toPlugin());
    await app.register(openApiPlugin, { title: "Test API", version: "1.0.0" });
    await app.ready();

    // 1) Valid body → 200
    const good = await app.inject({
      method: "POST",
      url: "/products/search",
      headers: { "content-type": "application/json" },
      payload: { query: "widget", limit: 10 },
    });
    expect(good.statusCode).toBe(200);
    expect(backend).toHaveBeenCalledTimes(1);

    // 2) Invalid body (empty query) → 400 from Fastify/AJV, handler NOT called
    backend.mockClear();
    const bad = await app.inject({
      method: "POST",
      url: "/products/search",
      headers: { "content-type": "application/json" },
      payload: { query: "" },
    });
    expect(bad.statusCode).toBe(400);
    expect(backend).not.toHaveBeenCalled();

    // 3) OpenAPI document includes the converted schema at the preset path
    const docs = await app.inject({ method: "GET", url: "/_docs/openapi.json" });
    expect(docs.statusCode).toBe(200);
    const spec = docs.json() as {
      paths: Record<
        string,
        Record<string, { requestBody?: { content: Record<string, { schema: unknown }> } }>
      >;
    };
    const postOp = spec.paths["/products/search"]?.post;
    expect(postOp).toBeDefined();
    const bodySchema = postOp?.requestBody?.content?.["application/json"]?.schema as {
      type?: string;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(bodySchema?.type).toBe("object");
    expect(bodySchema?.required).toContain("query");
    expect(bodySchema?.properties).toHaveProperty("query");
    expect(bodySchema?.properties).toHaveProperty("limit");
  });

  it("multiple resources with searchPreset register cleanly on one mcpPlugin endpoint", async () => {
    // Proves the common multi-resource pattern: product + order + ticket
    // each get their own searchPreset, one mcpPlugin exposes them all,
    // tool names are automatically per-resource-namespaced via resourceName
    // so there's no collision.
    const { mcpPlugin } = await import("../../src/integrations/mcp/index.js");

    const makeResource = (name: string, prefix: string) =>
      defineResource({
        name,
        prefix,
        disableDefaultRoutes: true,
        permissions: { list: allowPublic() },
        presets: [
          searchPreset({
            search: { handler: async () => [] },
            similar: { handler: async () => [] },
          }),
        ],
      });

    const product = makeResource("product", "/products");
    const order = makeResource("order", "/orders");
    const ticket = makeResource("ticket", "/tickets");

    const Fastify = (await import("fastify")).default;
    app = Fastify({ logger: false });
    await app.register(product.toPlugin());
    await app.register(order.toPlugin());
    await app.register(ticket.toPlugin());

    // Single MCP endpoint hosting all three resources
    await app.register(mcpPlugin, {
      resources: [product, order, ticket],
      prefix: "/mcp",
    });
    await app.ready();

    // Each resource registers under its own name — `mcpPlugin` namespaces
    // tools as `{operation}_{resource}` so multiple resources can share the
    // same search/similar routes without colliding.
    expect(app.mcp?.resourceNames.sort()).toEqual(["order", "product", "ticket"]);
    // NOTE: resourceToTools requires a resource.adapter (for its CRUD
    // controller path) before it emits tools from preset routes. Resources
    // in this test are adapter-less — `resourceNames` is enough to prove
    // multi-resource registration works; real apps bring an adapter and
    // get `{operation}_{resource}` tools automatically.
  });

  it("mcpPlugin `exclude` filters out resources even when they have search routes", async () => {
    const { mcpPlugin } = await import("../../src/integrations/mcp/index.js");

    const makeResource = (name: string, prefix: string) =>
      defineResource({
        name,
        prefix,
        disableDefaultRoutes: true,
        permissions: { list: allowPublic() },
        presets: [searchPreset({ search: { handler: async () => [] } })],
      });

    const pub = makeResource("product", "/products");
    const admin = makeResource("admin", "/admin-items");

    const Fastify = (await import("fastify")).default;
    app = Fastify({ logger: false });
    await app.register(pub.toPlugin());
    await app.register(admin.toPlugin());
    await app.register(mcpPlugin, {
      resources: [pub, admin],
      prefix: "/mcp",
      exclude: ["admin"], // admin resource gets zero MCP tools
    });
    await app.ready();

    expect(app.mcp?.resourceNames).toEqual(["product"]);
    const toolNames = app.mcp?.toolNames ?? [];
    expect(toolNames.every((t) => !t.includes("admin"))).toBe(true);
  });

  it("mounts multiple sections and a bespoke route in one preset", async () => {
    const similarBackend = vi.fn(async () => [{ id: "s1", score: 0.92 }]);
    const autocompleteBackend = vi.fn(async () => ["widget", "widgets"]);

    const resource = defineResource({
      name: "doc",
      prefix: "/docs",
      disableDefaultRoutes: true,
      permissions: { list: allowPublic() },
      presets: [
        searchPreset({
          similar: {
            handler: async (req) => {
              const body = req.body as { vector: number[] };
              return similarBackend();
            },
          },
          routes: [
            {
              method: "GET",
              path: "/autocomplete",
              permissions: allowPublic(),
              handler: async (req) => {
                const q = (req.query as { q?: string }).q ?? "";
                return { success: true, data: await autocompleteBackend() };
              },
            },
          ],
        }),
      ],
    });

    app = await createApp({
      resources: [resource],
      auth: "none",
      helmet: false,
      cors: false,
      rateLimit: false,
    });

    const similar = await app.inject({
      method: "POST",
      url: "/docs/search-similar",
      headers: { "content-type": "application/json" },
      payload: { vector: [0.1, 0.2] },
    });
    expect(similar.statusCode).toBe(200);
    expect((similar.json() as { data: unknown[] }).data).toHaveLength(1);

    const ac = await app.inject({
      method: "GET",
      url: "/docs/autocomplete?q=wid",
    });
    expect(ac.statusCode).toBe(200);
    expect((ac.json() as { data: string[] }).data).toEqual(["widget", "widgets"]);

    expect(similarBackend).toHaveBeenCalledTimes(1);
    expect(autocompleteBackend).toHaveBeenCalledTimes(1);
  });
});
