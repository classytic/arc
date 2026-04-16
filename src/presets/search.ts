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

import type { RepositoryLike } from "../adapters/interface.js";
import { allowPublic, requireAuth } from "../permissions/index.js";
import type { ControllerHandler, IControllerResponse, IRequestContext } from "../types/handlers.js";
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
  /**
   * User-supplied handler. When omitted, the preset auto-synthesises a handler
   * from `options.repository` (calling `repo.search` / `repo.searchSimilar` /
   * `repo.embed` respectively). If `repository` is also absent — or the repo
   * doesn't expose the matching method — the route is NOT mounted.
   */
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

/**
 * Shorthand shape for `search` / `similar` / `embed` sections:
 *   - `undefined`           → route not mounted
 *   - `true`                → mount with defaults, auto-wire from `repository`
 *   - `SearchRouteConfig`   → explicit config (and optional handler override)
 */
export type SearchSection = true | SearchRouteConfig;

export interface SearchPresetOptions {
  /**
   * Repository exposing `search`/`searchSimilar`/`embed`. When provided,
   * any section without an explicit `handler` is auto-wired to the matching
   * repo method. Mongokit's `elasticSearchPlugin` + `vectorPlugin` register
   * exactly these methods — pass the repo once and the handlers are synthesised.
   *
   * Sections set to `true` REQUIRE `repository` (otherwise the route is
   * skipped silently). Sections with an explicit `handler` ignore this field.
   */
  repository?: Pick<RepositoryLike, "search" | "searchSimilar" | "embed">;

  /** Full-text / engine-backed search route. Opt-in. */
  search?: SearchSection;
  /** Vector / semantic similarity route. Opt-in. */
  similar?: SearchSection;
  /** Embedding route (text/media → vector). Opt-in. */
  embed?: SearchSection;
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
function wrapEnvelope(
  handler: SearchHandler | ((req: IRequestContext) => Promise<unknown>),
): ControllerHandler {
  return async (req) => {
    const out = (await handler(req)) as unknown;
    if (out !== null && typeof out === "object" && "success" in out) {
      return out as IControllerResponse;
    }
    return { success: true, data: out };
  };
}

/**
 * Normalise a section value — `true` → empty config, `undefined` → undefined,
 * object → passthrough. Lets callers write `search: true` to mount with
 * defaults + auto-wire.
 */
function normaliseSection(value: SearchSection | undefined): SearchRouteConfig | undefined {
  if (value === undefined) return undefined;
  if (value === true) return {};
  return value;
}

/**
 * Internal handler shape returned by the auto-wire synthesiser. Returns raw
 * data which `wrapEnvelope` later coerces into `IControllerResponse`. The
 * looser return type is deliberate — `SearchHandler` requires `IControllerResponse`,
 * but auto-wired handlers proxy directly to repo methods that return arbitrary
 * shapes (arrays of docs, scored hits, vectors, …).
 */
type RawSearchHandler = (req: IRequestContext) => Promise<unknown>;

/**
 * Build an auto-synthesised handler that proxies the request body to
 * `repo[method]` using each kit's native calling convention. Returns
 * `undefined` when the method isn't present so the caller can fall back to
 * an explicit `cfg.handler` or skip the route.
 *
 * Conventions (verified against mongokit 3.6):
 *
 * - **`search`** (mongokit `elasticSearchPlugin`):
 *   `search(query, { limit?, from?, mongoOptions? })` — positional. `query`
 *   is the engine-native DSL (e.g. ES `match` clause). Arc passes
 *   `(body.query, body)` so the rest of the body flows into options.
 *
 * - **`searchSimilar`** (mongokit `vectorPlugin`):
 *   `searchSimilar(params: VectorSearchParams)` — **single object**. `params`
 *   carries `query` (vector, text, or multimodal), `limit`, `filter`,
 *   `numCandidates`, `exact`, `field`, `minScore`, etc. Arc passes `body`
 *   directly so the shapes align. Passing positional args here would
 *   silently break (first arg becomes the whole `params`, second arg
 *   is ignored).
 *
 * - **`embed`** (mongokit `vectorPlugin`):
 *   `embed(input: string | EmbeddingInput)` — single arg. Arc passes
 *   `body.input ?? body`, so callers may wrap as `{ input: "…" }` or send
 *   the `EmbeddingInput` shape directly.
 */
function autoHandlerFor(
  repo: SearchPresetOptions["repository"] | undefined,
  method: "search" | "searchSimilar" | "embed",
): RawSearchHandler | undefined {
  if (!repo) return undefined;
  const fn = repo[method];
  if (typeof fn !== "function") return undefined;

  if (method === "embed") {
    return async (req) => {
      const body = (req.body ?? {}) as { input?: unknown };
      return (fn as (input: unknown) => Promise<unknown>)(body.input ?? body);
    };
  }

  if (method === "searchSimilar") {
    // Single-object call — matches mongokit's VectorSearchParams contract.
    return async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return (fn as (params: unknown) => Promise<unknown>)(body);
    };
  }

  // Full-text search — positional `(query, options)` per elasticSearchPlugin.
  return async (req) => {
    const body = (req.body ?? {}) as { query?: unknown; [k: string]: unknown };
    return (fn as (q: unknown, o?: unknown) => Promise<unknown>)(body.query, body);
  };
}

/**
 * Create a search preset bound to a resource.
 *
 * Mounts routes only for sections the caller opts into. A section's handler
 * is either:
 *   1. explicit `cfg.handler` — always wins,
 *   2. `options.repository` auto-wire — if the repo exposes the matching
 *      method (`search` / `searchSimilar` / `embed`),
 *   3. otherwise the route is silently skipped.
 *
 * The preset itself stays DB-agnostic: nothing is imported from mongokit —
 * it only feature-detects the optional methods on whatever repo you pass.
 */
export function searchPreset(options: SearchPresetOptions = {}): PresetResult {
  const sections: Record<"search" | "similar" | "embed", SearchRouteConfig | undefined> = {
    search: normaliseSection(options.search),
    similar: normaliseSection(options.similar),
    embed: normaliseSection(options.embed),
  };

  const extraRoutes: readonly RouteDefinition[] = options.routes ?? [];

  const repoMethodFor: Record<
    "search" | "similar" | "embed",
    "search" | "searchSimilar" | "embed"
  > = {
    search: "search",
    similar: "searchSimilar",
    embed: "embed",
  };

  return {
    name: "search",
    routes: (permissions: ResourcePermissions): RouteDefinition[] => {
      const mounted: RouteDefinition[] = [];

      for (const spec of BUILTINS) {
        const cfg = sections[spec.key];
        if (!cfg) continue;

        const handler = cfg.handler ?? autoHandlerFor(options.repository, repoMethodFor[spec.key]);
        if (!handler) continue; // no explicit handler AND no matching repo method

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
          handler: wrapEnvelope(handler),
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
