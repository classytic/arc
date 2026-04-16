/**
 * Search Preset — backend-agnostic search / vector / embed routes
 *
 * Arc doesn't ship a search engine. It ships the **routes** that front one.
 * The preset mounts up to three standard routes on a resource:
 *
 *   POST /search           → full-text / engine-backed search (ES, OpenSearch, Algolia, Typesense, …)
 *   POST /search-similar   → vector / semantic similarity (Atlas, Pinecone, Qdrant, Milvus, …)
 *   POST /embed            → text / media → vector embedding
 *
 * Each route is OFF by default. You opt in by providing a `handler` that calls
 * whatever backend you use. The preset contributes:
 *   - Default path + method + permissions (customisable)
 *   - OpenAPI description + MCP tool naming
 *   - Arc envelope + pipeline (permissions, audit, hooks)
 *   - Sensible Fastify route schema defaults
 *
 * Paths are fully customisable — if your product wants `/abc/search` or a
 * GET-based autocomplete, pass `path`/`method` overrides or use `routes` for
 * fully bespoke endpoints.
 *
 * @example MongoKit wiring (elasticSearchPlugin + vectorPlugin)
 * ```typescript
 * import { Repository, methodRegistryPlugin, elasticSearchPlugin } from '@classytic/mongokit';
 * import { vectorPlugin } from '@classytic/mongokit/ai';
 * import { searchPreset } from '@classytic/arc/presets/search';
 *
 * const productRepo = new Repository(Product, [
 *   methodRegistryPlugin(),
 *   elasticSearchPlugin({ client: esClient, indexName: 'products' }),
 *   vectorPlugin({ fields: [{ path: 'embedding', dimensions: 1536 }], embedFn }),
 * ]);
 *
 * defineResource({
 *   name: 'product',
 *   adapter: createMongooseAdapter({ model: Product, repository: productRepo }),
 *   presets: [
 *     searchPreset({
 *       search:  { handler: (req) => productRepo.search(req.body.query, req.body) },
 *       similar: { handler: (req) => productRepo.searchSimilar(req.body.query, req.body) },
 *     }),
 *   ],
 * });
 * ```
 *
 * @example Custom vector backend (Pinecone)
 * ```typescript
 * searchPreset({
 *   similar: {
 *     path: '/vector-search',                 // custom path
 *     handler: async (req) => {
 *       const hits = await pinecone.query({
 *         vector: req.body.vector,
 *         topK: req.body.topK ?? 10,
 *       });
 *       return hits.matches;
 *     },
 *     schema: { body: { type: 'object', properties: { vector: { type: 'array' }, topK: { type: 'integer' } } } },
 *     mcp: false,                             // no MCP tool for this one
 *   },
 *   // Extra app-specific route
 *   routes: [
 *     {
 *       method: 'GET',
 *       path: '/autocomplete',
 *       handler: async (req) => algolia.suggest(req.query.q as string),
 *       permissions: allowPublic(),
 *     },
 *   ],
 * });
 * ```
 */

import { allowPublic, requireAuth } from "../permissions/index.js";
import type { ControllerHandler, IControllerResponse } from "../types/handlers.js";
import type {
  PermissionCheck,
  PresetResult,
  ResourcePermissions,
  RouteDefinition,
  RouteMcpConfig,
} from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Handler contract — receives arc's `IRequestContext` (same as any `actions` or
 * non-raw route handler) and returns either the raw result (wrapped into
 * `{ success: true, data }` by arc) or an explicit `IControllerResponse`.
 */
export type SearchHandler = ControllerHandler;

export interface SearchRouteConfig {
  /** User-supplied handler. Required — if omitted, the route is NOT mounted. */
  handler?: SearchHandler;
  /** HTTP path relative to the resource prefix. Defaults per-kind: `/search`, `/search-similar`, `/embed`. */
  path?: string;
  /** HTTP method. Default: `POST`. */
  method?: "GET" | "POST";
  /** Permission check. Defaults: search/similar fall back to `permissions.list ?? allowPublic()`; embed → `requireAuth()`. */
  permissions?: PermissionCheck;
  /** Fastify/AJV route schema (body/querystring/params/headers/response). */
  schema?: RouteDefinition["schema"];
  /**
   * MCP tool generation.
   * - omitted/true (default): auto-generate the tool from the route
   * - false: skip MCP
   * - object: explicit MCP config
   */
  mcp?: boolean | RouteMcpConfig;
  /** OpenAPI summary. Defaults per-kind. */
  summary?: string;
  /** OpenAPI description. Defaults per-kind. */
  description?: string;
  /** Operation name. Defaults per-kind (`search`, `searchSimilar`, `embed`). */
  operation?: string;
  /** OpenAPI tags. */
  tags?: string[];
}

export interface SearchPresetOptions {
  /** Full-text / engine-backed search route. Opt-in — provide `handler` to mount. */
  search?: SearchRouteConfig;
  /** Vector / semantic similarity route. Opt-in. */
  similar?: SearchRouteConfig;
  /** Embedding route (text/media → vector). Opt-in. */
  embed?: SearchRouteConfig;
  /**
   * Fully custom routes — merged as-is into the resource's route table.
   * Use this for endpoints that don't fit search/similar/embed naming,
   * e.g. `/autocomplete`, `/reindex`, `/facets`, `/more-like-this`.
   *
   * You are responsible for permissions + schema on each entry.
   */
  routes?: RouteDefinition[];
}

// ============================================================================
// Factory
// ============================================================================

interface BuiltinSpec {
  readonly key: "search" | "similar" | "embed";
  readonly defaultPath: string;
  readonly defaultOperation: string;
  readonly defaultSummary: string;
  readonly defaultDescription: string;
  /** Which resource-level permission to fall back to when the user hasn't set `permissions` on the route config. */
  readonly permissionFallback: (resourcePerms: ResourcePermissions) => PermissionCheck;
}

const BUILTINS: readonly BuiltinSpec[] = [
  {
    key: "search",
    defaultPath: "/search",
    defaultOperation: "search",
    defaultSummary: "Search",
    defaultDescription: "Full-text / engine-backed search. Delegates to the configured backend.",
    permissionFallback: (p) => p.list ?? allowPublic(),
  },
  {
    key: "similar",
    defaultPath: "/search-similar",
    defaultOperation: "searchSimilar",
    defaultSummary: "Semantic search",
    defaultDescription: "Vector / similarity search. Delegates to the configured backend.",
    permissionFallback: (p) => p.list ?? allowPublic(),
  },
  {
    key: "embed",
    defaultPath: "/embed",
    defaultOperation: "embed",
    defaultSummary: "Embed",
    defaultDescription: "Return the vector embedding for a text / media input.",
    permissionFallback: () => requireAuth(),
  },
];

/**
 * Wrap the user handler to normalise the return shape into arc's envelope.
 * If the handler already returns `{ success, data }`, arc passes it through;
 * otherwise we wrap the raw return value so callers don't have to.
 */
function wrapEnvelope(handler: SearchHandler): ControllerHandler {
  return async (req) => {
    const out = (await handler(req)) as unknown;
    if (out !== null && typeof out === "object" && "success" in out) {
      return out as IControllerResponse;
    }
    return { success: true, data: out };
  };
}

/**
 * Create a search preset bound to a resource.
 *
 * The preset mounts routes lazily — ONLY the sections with a `handler` produce
 * routes. This keeps the surface minimal and makes DB-agnosticism explicit:
 * you bring the backend, arc brings the HTTP + permissions + docs.
 */
export function searchPreset(options: SearchPresetOptions = {}): PresetResult {
  const sections: Record<"search" | "similar" | "embed", SearchRouteConfig | undefined> = {
    search: options.search,
    similar: options.similar,
    embed: options.embed,
  };

  const extraRoutes: readonly RouteDefinition[] = options.routes ?? [];

  return {
    name: "search",
    routes: (permissions: ResourcePermissions): RouteDefinition[] => {
      const mounted: RouteDefinition[] = [];

      for (const spec of BUILTINS) {
        const cfg = sections[spec.key];
        if (!cfg?.handler) continue; // opt-in only

        const route: RouteDefinition = {
          method: cfg.method ?? "POST",
          path: cfg.path ?? spec.defaultPath,
          operation: cfg.operation ?? spec.defaultOperation,
          summary: cfg.summary ?? spec.defaultSummary,
          description: cfg.description ?? spec.defaultDescription,
          tags: cfg.tags,
          permissions: cfg.permissions ?? spec.permissionFallback(permissions),
          schema: cfg.schema,
          mcp: cfg.mcp,
          handler: wrapEnvelope(cfg.handler),
        };
        mounted.push(route);
      }

      // Append user-supplied custom routes last so app-specific paths can
      // override preset defaults (Fastify picks the first registration by
      // default — apps control order by listing them here).
      for (const r of extraRoutes) mounted.push(r);

      return mounted;
    },
  };
}
