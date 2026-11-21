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
 * @example
 * ```typescript
 * searchPreset({
 *   search:  { handler: (req) => repo.search(req.body.query, req.body) },
 *   similar: {
 *     path: '/vector-search',   // override the default path
 *     mcp: false,               // and skip the MCP tool for this one
 *     handler: (req) => pinecone.query({ vector: req.body.vector }),
 *   },
 *   routes: [{ method: 'GET', path: '/autocomplete', handler, permissions }],
 * })
 * ```
 */

/**
 * Feature-detected search surface. Arc's `RepositoryLike` is the cross-kit
 * minimum (repo-core's `MinimalRepo & Partial<StandardRepo>`) and does not
 * declare search/vector/embed methods — those are kit-specific (mongokit's
 * `elasticSearchPlugin` + `vectorPlugin`, pgkit's `pgvector` extension,
 * sqlitekit FTS5, or a standalone Pinecone/Algolia adapter). We type the
 * `repository` option locally so the preset can auto-wire handlers when a
 * kit happens to ship these methods, without forcing every repo to declare
 * them.
 */
export interface SearchableRepository {
  search?(query: unknown, options?: unknown): Promise<unknown>;
  searchSimilar?(query: unknown, options?: unknown): Promise<unknown>;
  embed?(input: unknown): Promise<number[]>;
}

import { conjoinPolicyFilters } from "../permissions/filter-merge.js";
import { requireAuth } from "../permissions/index.js";
import type { ControllerHandler, IControllerResponse, IRequestContext } from "../types/handlers.js";
import type {
  PermissionCheck,
  PresetController,
  PresetResult,
  ResourcePermissions,
  RouteDefinition,
  RouteMcpConfig,
} from "../types/index.js";
import { presetPermission } from "./presetPermission.js";

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
  /** Permission check. Defaults: search/similar inherit `permissions.list` (unset: boot error under strict permissions); embed → `requireAuth()`. */
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
  repository?: SearchableRepository;

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
  /** The CRUD slot whose tenant middlewares the route shares under multiTenant. */
  readonly tenantSlot?: "list";
}

const BUILTINS: readonly BuiltinSpec[] = [
  {
    key: "search",
    defaultPath: "/search",
    defaultOperation: "search",
    tenantSlot: "list",
    defaultSummary: "Search",
    defaultDescription: "Full-text / engine-backed search. Delegates to the configured backend.",
    permissionFallback: (p) =>
      presetPermission(p.list, {
        preset: "search",
        inherits: "list",
        option: "searchPreset({ search: { permissions } })",
      }),
  },
  {
    key: "similar",
    defaultPath: "/search-similar",
    defaultOperation: "searchSimilar",
    tenantSlot: "list",
    defaultSummary: "Semantic search",
    defaultDescription: "Vector / similarity search. Delegates to the configured backend.",
    permissionFallback: (p) =>
      presetPermission(p.list, {
        preset: "search",
        inherits: "list",
        option: "searchPreset({ similar: { permissions } })",
      }),
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
 * If the handler already returns an `IControllerResponse` envelope (carrying
 * a `data` slot), arc passes it through; otherwise we wrap the raw return
 * value so callers don't have to.
 */
function wrapEnvelope(
  handler: SearchHandler | ((req: IRequestContext) => Promise<unknown>),
): ControllerHandler {
  return async (req) => {
    const out = (await handler(req)) as unknown;
    if (out !== null && typeof out === "object" && "data" in out) {
      return out as IControllerResponse;
    }
    return { data: out };
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
 * shapes (arrays of data, scored hits, vectors, …).
 */
type RawSearchHandler = (req: IRequestContext) => Promise<unknown>;

/**
 * Build an auto-synthesised handler that proxies the request body to
 * `repo[method]` using each kit's native calling convention. Returns
 * `undefined` when the method isn't present so the caller can fall back to
 * an explicit `cfg.handler` or skip the route.
 *
 * Row scope: the reads run under the scope `list` applies (`controller.listScope`:
 * permission filters, tenant filter, tenant repo options), so a member never sees
 * another organisation's rows.
 *
 * - **`search`** (mongokit `elasticSearchPlugin`): `search(query, options)`. The
 *   contract takes no filter (mongokit hydrates the engine's ids by `_id` only), so the
 *   returned rows are POST-filtered with `allows(doc)`, the check `getBySlug` uses;
 *   `total` drops by the rows removed. Scope options are spread last.
 * - **`searchSimilar`** (mongokit `vectorPlugin`): one `VectorSearchParams` object.
 *   The scope filter is AND-ed into `filter` (the `$vectorSearch` pre-filter: each path
 *   must be a filter field on the index) and the tenant options are spread last.
 * - **`embed`**: `embed(body.input ?? body)`; reads no rows, so no scope.
 */
interface ListScope {
  filter: Record<string, unknown>;
  options: Record<string, unknown>;
  allows: (doc: unknown) => boolean;
}
type ScopeOf = (req: IRequestContext) => Promise<ListScope>;

function postFilter(result: unknown, allows: (doc: unknown) => boolean): unknown {
  if (Array.isArray(result)) return result.filter(allows);
  if (
    result !== null &&
    typeof result === "object" &&
    Array.isArray((result as { data?: unknown }).data)
  ) {
    const page = result as { data: unknown[]; total?: unknown };
    const data = page.data.filter(allows);
    const removed = page.data.length - data.length;
    return {
      ...page,
      data,
      ...(typeof page.total === "number" ? { total: Math.max(0, page.total - removed) } : {}),
    };
  }
  return result;
}

function autoHandlerFor(
  repo: SearchPresetOptions["repository"] | undefined,
  method: "search" | "searchSimilar" | "embed",
  scopeOf: () => ScopeOf,
): RawSearchHandler | undefined {
  if (!repo) return undefined;
  const fn = repo[method];
  if (typeof fn !== "function") return undefined;

  if (method === "embed") {
    return async (req) => {
      const body = (req.body ?? {}) as { input?: unknown };
      return (fn as (input: unknown) => Promise<unknown>).call(repo, body.input ?? body);
    };
  }

  const scope = scopeOf();
  if (method === "searchSimilar") {
    return async (req) => {
      const { filter: callerFilter, ...body } = (req.body ?? {}) as Record<string, unknown>;
      const { filter, options } = await scope(req);
      return (fn as (params: unknown) => Promise<unknown>).call(repo, {
        ...body,
        filter: conjoinPolicyFilters(callerFilter as Record<string, unknown> | undefined, filter),
        ...options,
      });
    };
  }

  return async (req) => {
    const body = (req.body ?? {}) as { query?: unknown; [k: string]: unknown };
    const { options, allows } = await scope(req);
    const result = await (fn as (q: unknown, o?: unknown) => Promise<unknown>).call(
      repo,
      body.query,
      { ...body, ...options },
    );
    return postFilter(result, allows);
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
    routes: (
      permissions: ResourcePermissions,
      controller: PresetController<"listScope">,
    ): RouteDefinition[] => {
      const mounted: RouteDefinition[] = [];
      // Read while the routes are built, so a resource with no controller (or one
      // without `listScope`) fails boot instead of serving unscoped rows.
      let listScope: ScopeOf | undefined;
      const scopeOf = (): ScopeOf => {
        listScope ??= controller.listScope as unknown as ScopeOf;
        return listScope;
      };

      for (const spec of BUILTINS) {
        const cfg = sections[spec.key];
        if (!cfg) continue;

        const handler =
          cfg.handler ?? autoHandlerFor(options.repository, repoMethodFor[spec.key], scopeOf);
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
          ...(spec.tenantSlot ? { _tenantSlot: spec.tenantSlot } : {}),
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
