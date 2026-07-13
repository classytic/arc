/**
 * Resource Types — everything about defining a resource.
 *
 * `ResourceConfig`, route + action shapes, JSON schemas, middleware
 * config, presets, hooks, events. The big domain file.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import type { TenantPurgeStrategy } from "@classytic/repo-core/repository";
import type {
  FieldRule as RepoCoreFieldRule,
  SchemaBuilderOptions,
} from "@classytic/repo-core/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import type { PermissionCheck, UserBase } from "../permissions/types.js";
import type { AnyRecord } from "./base.js";
import type { MiddlewareHandler, RequestWithExtras } from "./fastify.js";
import type { ControllerHandler, ControllerLike, IController } from "./handlers.js";

// ──────────────────────────────────────────────────────────────────────
// Controller alias
// ──────────────────────────────────────────────────────────────────────

/** Standard controller type alias for CRUD operations. */
export type CrudController<TDoc> = IController<TDoc>;

// ──────────────────────────────────────────────────────────────────────
// Resource cache + rate-limit config
// ──────────────────────────────────────────────────────────────────────

/**
 * Tenant-cleanup declaration on a resource — compliance-grade strategy
 * for what happens to this resource's rows when the owning organization
 * is deleted. Surfaces in arc's org-delete cascade runner and in
 * registry introspection (audit scripts ask "what happens to this
 * resource on org delete?").
 *
 * Strategy variants:
 *   - `hard` — permanent removal (GDPR right-to-be-forgotten).
 *   - `soft` — recoverable; pair with TTL for eventual hard-purge.
 *   - `anonymize` — keep the row (legal retention) but clear PII
 *     (HIPAA / PCI / SOX-compatible).
 *   - `skip` — explicit opt-out with mandatory `reason`.
 *
 * See {@link ResourceConfig.onTenantDelete} for the full decision tree.
 */
export interface OnTenantDeleteConfig {
  /**
   * What to do with rows whose `tenantField` matches the deleted org.
   * Discriminated union from `@classytic/repo-core/repository` — every
   * kit's `purgeByField` consumes the same shape.
   */
  strategy: TenantPurgeStrategy;
  /**
   * Resources are processed in ascending `priority` order. Use to land
   * leaf data (logs, events) before aggregate references. Default `100`.
   */
  priority?: number;
  /**
   * Rows per chunk for the underlying `purgeByField` call — bounds
   * lock contention + replication-log pressure on very large tenants.
   * Default kit-specific (~1000).
   */
  batchSize?: number;
}

/**
 * Resolved tenant-purge declaration — what arc actually runs when
 * `cascadeDeleteForOrganization` fires. Computed once at boot from the
 * resource's `onTenantDelete` declaration.
 *
 * Exposed via `ResourceDefinition.resolvedTenantPurge` and
 * `getCascadingResourcesWithMetadata(registry)` so audit tooling can
 * answer "is this resource really going to hard-delete?" without
 * reading the source.
 */
export interface ResolvedTenantPurge {
  readonly strategy: TenantPurgeStrategy;
  readonly priority: number;
  readonly batchSize?: number;
  /**
   * Where the strategy came from — `'declared'` (host wrote
   * `onTenantDelete` explicitly) or `'disabled'` (no declaration —
   * runner skips this resource).
   */
  readonly source: "declared" | "disabled";
}

/**
 * Per-resource cache configuration for QueryCache. Enables
 * stale-while-revalidate, auto-invalidation on mutations, and
 * cross-resource tag-based invalidation.
 */

export interface ResourceCacheConfig {
  /** Seconds data is "fresh" (no revalidation). Default: 0 */
  staleTime?: number;
  /** Seconds stale data stays cached (SWR window). Default: 60 */
  gcTime?: number;
  /** Per-operation overrides */
  list?: { staleTime?: number; gcTime?: number };
  byId?: { staleTime?: number; gcTime?: number };
  /** Tags for cross-resource invalidation grouping */
  tags?: string[];
  /**
   * Cross-resource invalidation: event pattern → tag targets.
   * @example { 'category.*': ['catalog'] }
   */
  invalidateOn?: Record<string, string[]>;
  /** Disable caching for this resource */
  disabled?: boolean;
}

export interface RateLimitConfig {
  /** Maximum number of requests allowed within the time window */
  max: number;
  /** Time window for rate limiting (e.g., '1 minute', '15 seconds') */
  timeWindow: string;
}

// ──────────────────────────────────────────────────────────────────────
// Schema types — RouteSchemaOptions, FieldRule, CrudSchemas, OpenApiSchemas
// ──────────────────────────────────────────────────────────────────────

/**
 * Per-field rule — arc's extension of repo-core's 4-field `FieldRule` floor
 * (`immutable`, `immutableAfterCreate`, `systemManaged`, `optional`) with
 * the constraint / UI / security bits arc layers on top.
 *
 * Kept structurally compatible with `@classytic/repo-core/schema`'s
 * `FieldRule` so arc's `fieldRules: Record<string, ArcFieldRule>` flows
 * into mongokit's / sqlitekit's `buildCrudSchemasFromModel(..., options)`
 * without a cast. See `RouteSchemaOptions` JSDoc for the full rationale.
 */
export interface ArcFieldRule extends RepoCoreFieldRule {
  /**
   * When `true`, bypass the `systemManaged` / `readonly` / `immutable`
   * strip in `BodySanitizer` for callers whose request scope is
   * `elevated`. Lets platform admins stamp the value from the request
   * body — needed for cross-tenant admin writes where the tenant field
   * is the only way to pick a target org.
   *
   * Auto-set by `defineResource` on the configured `tenantField`. Hosts
   * can set it manually on other fields (e.g. `createdBy`) if they want
   * elevation-only override semantics for those too.
   *
   * Has no effect when `isElevated(scope)` is false — member and
   * service callers continue to have the field stripped.
   */
  preserveForElevated?: boolean;
  hidden?: boolean;
  /**
   * Aggregation visibility override. By default, only `hidden: true`
   * blocks a field from `groupBy` / `measures.field` / `sort` / `dateBuckets`
   * — that's the genuine cardinality-leak guard (the value is omitted from
   * list/get responses, so exposing it via aggregation would reveal data
   * the client can't otherwise see).
   *
   * `systemManaged: true` does **not** block aggregation — it's a write
   * rule, not a visibility rule. Server-stamped fields like `createdAt`,
   * `status`, or plugin-generated handles are visible in every list
   * response and should aggregate freely.
   *
   * Use this flag to override the default:
   *
   * - `aggregable: false` — explicit deny, even on visible fields. Useful
   *   when a value is exposed per-row but the cardinality across rows is
   *   itself sensitive (e.g. `email` is visible in `get/:id` to admins
   *   but you don't want a public-readable agg of email distributions).
   * - `aggregable: true` — escape hatch on `hidden` fields. Lets you
   *   aggregate a hidden column when you're sure cardinality leakage
   *   isn't a concern (e.g. `internalScore` hidden from list, but a
   *   committee-only `byScore` agg is fine).
   *
   * Defaults to `undefined` (use the `hidden`-only rule).
   */
  aggregable?: boolean;
  /** String minimum length — auto-maps to OpenAPI `minLength` and MCP tool schema */
  minLength?: number;
  /** String maximum length — auto-maps to OpenAPI `maxLength` and MCP tool schema */
  maxLength?: number;
  /** Number minimum — auto-maps to OpenAPI `minimum` and MCP tool schema */
  min?: number;
  /** Number maximum — auto-maps to OpenAPI `maximum` and MCP tool schema */
  max?: number;
  /** Regex pattern — auto-maps to OpenAPI `pattern` and MCP tool schema */
  pattern?: string;
  /** Allowed values — auto-maps to OpenAPI `enum` and MCP tool schema */
  enum?: ReadonlyArray<string | number>;
  /**
   * When `true`, widen the JSON Schema `type` of this field to also
   * accept `null`. Mirrors Zod's `.nullable()` at the arc config layer
   * for kit-generated schemas that don't carry the flag end-to-end
   * (e.g. Zod → Mongoose → mongokit drops `.nullable()` because
   * Mongoose has no first-class nullable marker unless `default: null`
   * is also set).
   *
   * Applied post-kit by `mergeFieldRuleConstraints`: if the adapter
   * emitted `{ type: 'string', enum: [...] }` for a field arc should
   * accept null for, the merge widens it to
   * `{ type: ['string', 'null'], enum: [...] }` — draft-7 tuple form
   * AJV 8 validates natively.
   *
   * No-op when the property already declares `type: [...,'null']` or
   * an `anyOf: [..., { type: 'null' }]` branch — arc never fights the
   * kit's own output.
   */
  nullable?: boolean;
  /** Human-readable description — auto-maps to OpenAPI `description` */
  description?: string;
  [key: string]: unknown;
}

/**
 * Schema-shaping options for a resource.
 *
 * Extends `@classytic/repo-core/schema`'s `SchemaBuilderOptions` so every
 * kit-generator callback typed against the repo-core contract
 * (mongokit's `buildCrudSchemasFromModel`, sqlitekit's
 * `buildCrudSchemasFromTable`, prismakit's equivalent) accepts arc's
 * options bag directly — no `as SchemaBuilderOptions` / `Parameters<...>[1]`
 * cast at the host wiring site.
 *
 * Inherited from `SchemaBuilderOptions`:
 *   - `strictAdditionalProperties` — emit `additionalProperties: false`
 *   - `dateAs` — `'date'` vs `'datetime'` ISO rendering
 *   - `softRequiredFields` — stay in `properties`, drop from `required[]`
 *   - `create: { omitFields, requiredOverrides, optionalOverrides, schemaOverrides }`
 *   - `update: { omitFields, requireAtLeastOne }`
 *   - `query: { filterableFields }` (kit-native filter declaration)
 *   - `openApiExtensions` — emit `x-*` vendor keywords for docgen
 *
 * Arc adds:
 *   - `fieldRules` with the richer `ArcFieldRule` per-entry shape
 *     (preserveForElevated, minLength/maxLength/min/max/pattern, enum,
 *     nullable, description) — arc's extensions are applied post-kit by
 *     `mergeFieldRuleConstraints`; the kit only sees the repo-core floor.
 *   - `hiddenFields` / `readonlyFields` / `requiredFields` / `optionalFields`
 *     / `excludeFields` — arc-only convenience lists that predate fieldRules.
 *     Keep using them if they're already in place; new code should prefer
 *     `fieldRules` for per-field control.
 *   - `filterableFields: string[]` — top-level list arc's MCP layer auto-
 *     derives from `QueryParser.allowedFilterFields`. Distinct from the
 *     inherited `query.filterableFields: Record<...>` which feeds the kit's
 *     list-query schema; nothing stops a resource from using both.
 *
 * **Why extend rather than duplicate**: mongokit's
 * `buildCrudSchemasFromModel(model, options: SchemaBuilderOptions)` is the
 * canonical callback shape. Before the extension, hosts wrote
 * `Parameters<typeof buildCrudSchemasFromModel>[1]` or
 * `as SchemaBuilderOptions` at every wiring site — a defensive cast with
 * no runtime effect. Extension locks the structural relationship at the
 * type layer so the cast is compile-verified gone.
 */
export interface RouteSchemaOptions extends SchemaBuilderOptions {
  hiddenFields?: string[];
  readonlyFields?: string[];
  requiredFields?: string[];
  optionalFields?: string[];
  excludeFields?: string[];
  /**
   * Fields allowed for filtering in list operations. MCP auto-derives
   * from `QueryParser.allowedFilterFields` when not set explicitly.
   *
   * Distinct from the inherited `query.filterableFields: Record<...>`
   * from `SchemaBuilderOptions` — that entry feeds the kit's list-query
   * JSON Schema; this one is arc's MCP-auto-derivation list.
   */
  filterableFields?: string[];
  /**
   * Per-field rules. Richer than repo-core's `FieldRules` — arc adds
   * `preserveForElevated`, constraint hints (`minLength`, `enum`,
   * `nullable`, etc.), and `description` on top of the four-flag floor
   * (`immutable`, `immutableAfterCreate`, `systemManaged`, `optional`).
   *
   * Structurally compatible: `Record<string, ArcFieldRule>` is assignable
   * to repo-core's `Record<string, FieldRule>` since `ArcFieldRule extends
   * FieldRule`. Kits see only the floor; arc's extensions are applied
   * post-kit by `mergeFieldRuleConstraints`.
   */
  fieldRules?: Record<string, ArcFieldRule>;
  /**
   * Query-time security whitelists + the kit's `filterableFields`.
   *
   * Extends repo-core's `SchemaBuilderOptions['query']` with arc-specific
   * runtime features that `QueryResolver` reads at request time:
   *
   * - **`allowedPopulate`** — populate-path whitelist consumed by
   *   `QueryResolver.sanitizePopulate` / `sanitizeAdvancedPopulate`.
   *   When set, only paths in the list pass through; everything else is
   *   stripped silently. Shrinks the auto-wired `?populate=` attack surface.
   *
   * - **`allowedLookups`** — lookup-collection whitelist consumed by
   *   `QueryResolver.sanitizeLookups`. When set, only the listed
   *   collections may be `$lookup`'d into the pipeline.
   *
   * Both are pre-2.11.2 runtime features — the type was missing them, so
   * hosts wrote `as Record<string, unknown>` at every call site. Arc's own
   * `QueryResolver` had to cast its own input via `as AnyRecord` for the
   * same reason. Adding the type dropped both casts.
   */
  query?: SchemaBuilderOptions["query"] & {
    /**
     * Populate-path whitelist. When set, `QueryResolver.sanitizePopulate`
     * strips any `?populate=<path>` not in this list. Omit to allow all
     * paths the kit recognizes.
     */
    allowedPopulate?: string[];
    /**
     * Lookup-collection whitelist for `QueryResolver.sanitizeLookups`.
     * When set, only the listed collections may be `$lookup`'d. Omit to
     * disable the whitelist (kit-level rules still apply).
     */
    allowedLookups?: string[];
  };
}

export interface FieldRule {
  field: string;
  required?: boolean;
  readonly?: boolean;
  hidden?: boolean;
}

/**
 * CRUD route schemas (Fastify native format). Each slot accepts a plain
 * JSON Schema object **or** a Zod v4 schema — Arc's `convertRouteSchema`
 * feature-detects at runtime. Slot values are typed `unknown` so
 * class-based Zod schemas assign without casts.
 */
export interface CrudSchemas {
  /** GET / — list */
  list?: {
    querystring?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };
  /** GET /:id — get one */
  get?: {
    params?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };
  /** POST / — create */
  create?: {
    body?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };
  /** PATCH /:id — update */
  update?: {
    params?: unknown;
    body?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };
  /** DELETE /:id — delete */
  delete?: {
    params?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenApiSchemas {
  entity?: unknown;
  createBody?: unknown;
  updateBody?: unknown;
  params?: unknown;
  listQuery?: unknown;
  /**
   * Explicit response schema for OpenAPI documentation. Auto-generated
   * from `createBody` if omitted. Does NOT affect Fastify serialization.
   */
  response?: unknown;
  [key: string]: unknown;
}

export type CrudRouteKey = "list" | "get" | "create" | "update" | "delete";

export interface MiddlewareConfig {
  list?: MiddlewareHandler[];
  get?: MiddlewareHandler[];
  create?: MiddlewareHandler[];
  update?: MiddlewareHandler[];
  delete?: MiddlewareHandler[];
  [key: string]: MiddlewareHandler[] | undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Route Definition — the single custom-route shape
// ──────────────────────────────────────────────────────────────────────

/** HTTP methods for custom routes. */
export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** MCP tool configuration for a route or action. */
export interface RouteMcpConfig {
  /** Override auto-generated tool description */
  readonly description?: string;
  /** MCP tool annotations */
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

/**
 * Route definition — single custom-route shape (user-facing + internal).
 *
 * - `handler: 'string'` → controller method → full Arc pipeline + MCP tool
 * - `handler: function` → inline handler → full Arc pipeline + MCP tool
 * - `raw: true` → raw Fastify handler → no pipeline, no MCP by default
 */
export interface RouteDefinition {
  readonly method: RouteMethod;
  /** Path relative to resource prefix */
  readonly path: string;
  /**
   * Route handler.
   * - String: controller method name (Arc pipeline) — runtime lookup, no TS coverage on typos.
   * - Function without `raw: true`: receives IRequestContext, returns IControllerResponse (Arc pipeline)
   * - Function with `raw: true`: raw Fastify handler `(request, reply)`
   *
   * Prefer `controllerMethod` (2.16) over the string form when you want the
   * compiler to catch typos. `handler` stays optional when `controllerMethod`
   * is set — exactly one of the two must be declared.
   */
  readonly handler?:
    | string
    | ControllerHandler
    | RouteHandlerMethod
    | ((request: FastifyRequest<Record<string, unknown>>, reply: FastifyReply) => unknown);
  /**
   * Typed function-reference handler (2.16). Receives the live controller
   * instance and returns the method to invoke — TypeScript catches typos
   * and surfaces autocomplete on the controller's method names. Prefer
   * this over the string `handler` form for any host that uses a typed
   * controller subclass.
   *
   * Resolved ONCE at route-registration time (the same path string
   * handlers go through), so there's no per-request lookup overhead.
   * The returned method is bound to the controller before dispatch.
   *
   * Mutually exclusive with `handler` — passing both throws at boot
   * with a clear "pick one" message. The runtime contract on what the
   * returned function accepts mirrors the `handler` rules: a plain
   * `ControllerHandler` for pipeline routes, a raw Fastify handler when
   * the route is `raw: true`.
   *
   * Typed loosely (`(controller: unknown) => …`) at the type-system
   * boundary because `RouteDefinition` is not generic over the
   * controller shape — host code annotates the parameter to opt in:
   *
   * @example
   * ```ts
   * class PostController extends BaseController<Post> {
   *   async getStats(ctx: IRequestContext) { … }
   * }
   *
   * defineResource({
   *   controller: new PostController(repo),
   *   routes: [{
   *     method: 'GET',
   *     path: '/stats',
   *     controllerMethod: (c: PostController) => c.getStats,
   *     //                       ^^^^^^^^^^^^^^ TS catches typos here
   *     permissions: requireAuth(),
   *   }],
   * });
   * ```
   */
  readonly controllerMethod?: (controller: unknown) => ControllerHandler | RouteHandlerMethod;
  /** Permission check — REQUIRED */
  readonly permissions: PermissionCheck;
  /**
   * Raw mode — bypasses Arc pipeline. Handler receives raw Fastify
   * request/reply. Default: false.
   */
  readonly raw?: boolean;
  /** Logical operation name (pipeline keys, MCP tool naming). */
  readonly operation?: string;
  /** OpenAPI summary */
  readonly summary?: string;
  /** OpenAPI description */
  readonly description?: string;
  /** OpenAPI tags */
  readonly tags?: string[];
  /** Route-level middleware */
  readonly preHandler?: RouteHandlerMethod[] | ((fastify: FastifyInstance) => RouteHandlerMethod[]);
  /** Pre-auth handlers (run before authentication) */
  readonly preAuth?: RouteHandlerMethod[];
  /**
   * Opt this custom route into the multiTenant preset's tenant scoping.
   *
   * When `true` AND the resource declares `multiTenantPreset` (or
   * `flexibleMultiTenantPreset`), arc prepends the preset's tenant
   * filter + injection middleware to this route's chain — the same
   * pair `update` gets. The handler can then read the resolved tenant
   * via `getOrgId(req.scope)` / `req._tenantFields` (or, for write
   * routes, off `req.body` after injection) without re-implementing
   * the scope read + header fallback + 400 boilerplate.
   *
   * Throws at boot if set when no multiTenant preset is wired — the
   * misconfiguration would otherwise be silently insecure (read routes
   * returning every tenant's rows).
   *
   * @default false
   */
  readonly tenantScope?: boolean;
  /**
   * SSE streaming mode. Two handler shapes work:
   *
   * - Write to `reply.raw` directly (NDJSON, custom SSE — historical contract).
   * - Return a Web `ReadableStream` (Vercel AI SDK's `result.toUIMessageStream()`,
   *   `fetch().body`, etc.). 2.17.1+ auto-pipes these through
   *   `pipeUIMessageStreamToReply()` so each chunk is JSON-encoded into
   *   an SSE `data:` frame and client-disconnect cancels the source.
   *   Pre-2.17.1 this crashed with `chunk must be a string or Buffer`.
   */
  readonly streamResponse?: boolean;
  /**
   * INTERNAL — marker stamped by built-in presets (softDelete, tree, …)
   * onto routes they emit. Read by the MCP collision detector
   * (`createMcpServer.resolveToolCollisions`) to attribute the route
   * source ("preset:softDelete vs user `actions.restore`") and to
   * auto-namespace the preset side when a user-authored tool legitimately
   * shadows it. Not part of the public surface — hosts must not set this.
   *
   * @internal
   */
  readonly _presetSource?: string;
  /**
   * Apply the resource's `fields` (field-level write permissions) to this
   * custom route's request body.
   *
   * Default: `true` for body-bearing methods (POST/PUT/PATCH), `false`
   * otherwise. Set to `false` to opt out — handler accepts the body as
   * supplied with no field-write filtering. The resource-level
   * `onFieldWriteDenied: 'reject' | 'strip'` setting governs how denials
   * are surfaced.
   *
   * `raw: true` routes ALWAYS bypass this — they've opted out of the
   * pipeline entirely.
   */
  readonly fieldWrite?: boolean;
  /**
   * Per-route rate limit. A custom route is its own Fastify route, so this
   * overrides the resource-level `rateLimit` for THIS endpoint only:
   *
   *   - omitted                → inherit the resource-level limit (or app default)
   *   - `false`                → disable rate limiting on this route
   *   - `{ max, timeWindow }`  → apply this specific limit
   *
   * Requires `@fastify/rate-limit` registered (arc's factory wires it by
   * default). Use for an expensive `/export` or an auth-sensitive `/reset`
   * that needs a tighter cap than the resource's read-heavy CRUD, or `false`
   * on an internal health/webhook route that must not be throttled.
   *
   * Note: this is per-route because each custom route is a distinct endpoint.
   * `actions` share ONE `POST /:id/action` mount by design, so a per-ACTION
   * limit can't be expressed here — throttle a specific action by promoting
   * it to a dedicated `routes:` entry, or rely on the resource-level limit.
   */
  readonly rateLimit?: RateLimitConfig | false;
  /**
   * Fastify route schema. Each slot (`body`, `querystring`, `params`,
   * `headers`, `response[status]`) accepts a plain JSON Schema object
   * **or** a Zod v4 schema — Arc auto-converts via `convertRouteSchema`.
   */
  readonly schema?: {
    body?: unknown;
    querystring?: unknown;
    params?: unknown;
    headers?: unknown;
    response?: Record<number | string, unknown>;
    [key: string]: unknown;
  };
  /**
   * MCP tool generation:
   * - omitted/true: auto-generate (non-raw routes only)
   * - false: skip MCP
   * - object: explicit config
   */
  readonly mcp?: boolean | RouteMcpConfig;
  /**
   * MCP handler for raw routes — parallel entry point for MCP without
   * changing the HTTP handler.
   */
  readonly mcpHandler?: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

// ──────────────────────────────────────────────────────────────────────
// Action Definition (v2.8 — replaces onRegister + createActionRouter)
// ──────────────────────────────────────────────────────────────────────

/**
 * Action handler function for state transitions. Receives the resource
 * ID, action-specific data, and the request.
 */
export type ActionHandlerFn = (
  id: string,
  data: Record<string, unknown>,
  req: RequestWithExtras,
) => Promise<unknown>;

/**
 * Full action configuration with handler, permissions, and schema.
 *
 * Rate limiting is intentionally NOT per-action: every action shares one
 * `POST /:id/action` (or `POST /action`) mount, so Fastify's per-route limit
 * can't distinguish them. Actions inherit the resource-level `rateLimit`; to
 * throttle a specific operation, promote it to a `routes:` entry (which
 * supports `RouteDefinition.rateLimit`).
 */
export interface ActionDefinition {
  readonly handler: ActionHandlerFn;
  /** Per-action permission (overrides resource-level `actionPermissions`) */
  readonly permissions?: PermissionCheck;
  /**
   * JSON Schema or Zod v4 schema for action-specific body fields.
   *
   * Typed `unknown` (not `Record<string, unknown>`) so Zod class instances
   * — `ZodObject<...>` carries no string index signature — assign without
   * a cast. Same convention as `RouteDefinition.schema.body` / `customSchemas`.
   * Runtime feature-detects via `convertRouteSchema` / `toJsonSchema`.
   */
  readonly schema?: unknown;
  /** Description for OpenAPI docs and MCP tool */
  readonly description?: string;
  /**
   * Whether this action needs an entity id from the URL.
   *
   * - `true` (default) — mounts under `POST /<prefix>/:id/action`. The `id`
   *   path param is required; handler receives it as the first argument.
   *   Use for actions that operate on an existing entity: `approve`,
   *   `dispatch`, `cancel`, `archive`.
   * - `false` — mounts under `POST /<prefix>/action` (no `:id` segment).
   *   Handler receives an empty-string first argument. Use for
   *   collection-level actions that create / search / bulk-mutate:
   *   `propose` (creates a new entity), `search` (returns rows), `bulk`.
   *
   * 2.15.5: previously every action had to live under `:id/action`, forcing
   * `propose`-style actions to swallow a meaningless URL parameter and
   * making the auto-generated MCP tool advertise an `id` field agents
   * had no value for. Setting `id: false` mounts the action at the
   * resource root and drops `id` from the MCP tool's input shape.
   */
  readonly id?: boolean;
  /**
   * MCP tool generation:
   * - omitted/true: auto-generate
   * - false: skip
   * - object: explicit config
   */
  readonly mcp?: boolean | RouteMcpConfig;
}

/** Action config: bare handler function OR full ActionDefinition. */
export type ActionEntry = ActionHandlerFn | ActionDefinition;

/** Actions configuration map. */
export type ActionsMap = Record<string, ActionEntry>;

// ──────────────────────────────────────────────────────────────────────
// Hooks + Events + Presets
// ──────────────────────────────────────────────────────────────────────

/**
 * Hook context passed to resource-level hook handlers. Mirrors
 * HookSystem's HookContext but with a simpler API for inline use.
 *
 * **v2.10.8:** `context` and a first-class `scope` projection are now
 * forwarded from the internal `HookContext`. Before this release, inline
 * `config.hooks` handlers had no way to reach the caller's tenant or
 * user info — they had to bypass the documented API and push directly
 * into `resource._pendingHooks` to get the raw internal shape. Now the
 * documented DX is complete:
 *
 * ```ts
 * hooks: {
 *   afterCreate: (ctx) => {
 *     auditLog.write({
 *       org: ctx.scope?.organizationId,
 *       actor: ctx.scope?.userId,
 *       id: ctx.data._id,
 *     });
 *   },
 * }
 * ```
 *
 * The `scope` projection matches `IRequestContext.scope` (2.10.6) so
 * hosts read tenant/user the same way across controllers and hooks.
 * Use `context._scope` directly for advanced cases that need to
 * discriminate on `scope.kind` or reach auth-adapter-specific fields.
 */
export interface ResourceHookContext {
  /** The document data (create/update body, or existing doc for delete / after-result) */
  data: AnyRecord;
  /** Authenticated user or null */
  user?: UserBase;
  /**
   * Full typed request context — includes `_scope`, `_policyFilters`,
   * `arc` metadata. Use `ctx.scope` for the common tenant/user projection;
   * reach for `ctx.context` when you need `_scope.kind` branching or
   * custom fields set by your auth adapter.
   */
  context?: AnyRecord;
  /**
   * First-class projection of request scope — `{ organizationId?, userId?, orgRoles? }`.
   * Populated for every scoped request so multi-tenant hooks don't have to
   * drill into `context._scope.organizationId` themselves. Matches the
   * identically-named field on `IRequestContext` (v2.10.6) so the same
   * read pattern works in controllers and hooks.
   */
  scope?: {
    organizationId?: string;
    userId?: string;
    orgRoles?: string[];
  };
  /** Additional metadata (e.g. `{ id, existing }` for update/delete) */
  meta?: AnyRecord;
}

/**
 * Inline lifecycle hooks on a resource definition. Wired into the
 * HookSystem automatically — same pipeline as presets and app-level hooks.
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'chat',
 *   hooks: {
 *     afterCreate: async (ctx) => { analytics.track('chat.created', { id: ctx.data._id }); },
 *     beforeDelete: async (ctx) => {
 *       if (ctx.data.isProtected) throw new Error('Cannot delete protected chat');
 *     },
 *   },
 * });
 * ```
 */
export interface ResourceHooks {
  beforeCreate?: (
    ctx: ResourceHookContext,
  ) => Promise<AnyRecord | undefined> | AnyRecord | undefined;
  afterCreate?: (ctx: ResourceHookContext) => Promise<void> | void;
  beforeUpdate?: (
    ctx: ResourceHookContext,
  ) => Promise<AnyRecord | undefined> | AnyRecord | undefined;
  afterUpdate?: (ctx: ResourceHookContext) => Promise<void> | void;
  beforeDelete?: (ctx: ResourceHookContext) => Promise<void> | void;
  afterDelete?: (ctx: ResourceHookContext) => Promise<void> | void;
}

export interface PresetHook {
  operation: "create" | "update" | "delete" | "read" | "list";
  phase: "before" | "after";
  handler: (ctx: AnyRecord) => void | Promise<void> | AnyRecord | Promise<AnyRecord>;
  priority?: number;
}

export interface PresetResult {
  name: string;
  /** Preset routes — merged into the resource's `routes` array. */
  routes?: RouteDefinition[] | ((permissions: ResourcePermissions) => RouteDefinition[]);
  middlewares?: MiddlewareConfig;
  schemaOptions?: RouteSchemaOptions;
  controllerOptions?: Record<string, unknown>;
  hooks?: PresetHook[];
}

export type PresetFunction = (config: ResourceConfig) => PresetResult;

export interface EventDefinition {
  name: string;
  /** Optional handler — events are published via `fastify.events.publish()`. */
  handler?: (data: unknown) => Promise<void> | void;
  /**
   * JSON Schema or Zod v4 schema for event payload. Typed `unknown` so Zod
   * class instances assign without a cast (same convention as
   * `ActionDefinition.schema` and `RouteDefinition.schema`).
   */
  schema?: unknown;
  description?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Resource permissions + Resource config
// ──────────────────────────────────────────────────────────────────────

/** Resource-level permissions — only `PermissionCheck` functions allowed. */
export interface ResourcePermissions {
  list?: PermissionCheck;
  get?: PermissionCheck;
  create?: PermissionCheck;
  update?: PermissionCheck;
  delete?: PermissionCheck;
}

/**
 * Plugin extension namespace — arc's typed escape hatch for attaching
 * declarative, per-resource config that **plugins** read at request time.
 *
 * **External** plugins augment it via TypeScript declaration merging
 * (`declare module "@classytic/arc/types"`) to register their own typed
 * slice — exactly the model Fastify uses for `FastifyInstance` decorators.
 * The host gets full autocomplete + compile-time checking on the matching
 * `extensions` block, and a typo (`extensions: { encyrption: … }`) is a
 * type error rather than a silent no-op.
 *
 * **First-party** slices (arc's own subpath plugins) are declared inline
 * below with type-only imports instead of `declare module`. Not a style
 * choice: arc bundles its declarations, and a relative module augmentation
 * (`declare module "../types/resource.js"`) survives bundling as an
 * unresolvable specifier — the merge silently never happens for consumers,
 * so the key would be a compile ERROR downstream while working inside this
 * repo. Inline declaration is bundler-proof; the type-only import is erased
 * at runtime, so the plugin stays fully opt-in.
 *
 * **The "React for backend" composition model.** `defineResource()` is the
 * declarative component, `extensions` is its typed props bag, and plugins
 * are the providers that consume those props at the framework boundary.
 * Adding a cross-cutting capability becomes *additive* — a plugin ships a
 * subpath + a one-line `declare module` augmentation, with no new
 * first-class `ResourceConfig` field and no core release per feature.
 *
 * Arc threads the declared `extensions` onto every generated route's
 * Fastify `config` (see `createCrudRouter`), so a plugin reads its slice
 * at request time via `request.routeOptions.config.arcExtensions` without
 * re-deriving which resource a route belongs to.
 *
 * @example An external plugin package registers its slice
 * ```ts
 * declare module "@classytic/arc/types" {
 *   interface ResourceExtensions {
 *     myPlugin?: import("my-arc-plugin").MyPluginDirective;
 *   }
 * }
 * ```
 *
 * @example A host declares it on a resource
 * ```ts
 * defineResource({
 *   name: "payment",
 *   extensions: { encryption: { mode: "fields", fields: ["cardNumber", "cvv"] } },
 * });
 * ```
 */
export interface ResourceExtensions {
  /**
   * Encrypt this resource's responses — full-body JWE or specific fields.
   * Read at request time by `@classytic/arc/encryption`'s `encryptionPlugin`
   * from `request.routeOptions.config.arcExtensions.encryption`; inert (and
   * dependency-free — the import is type-only) unless that plugin is
   * registered.
   */
  encryption?: import("../encryption/types.js").EncryptionDirective;
}

export interface ResourceConfig<TDoc = AnyRecord> {
  name: string;
  displayName?: string;
  tag?: string;
  /** Defaults to `/${name}s` if not provided. */
  prefix?: string;
  /**
   * Skip the global `resourcePrefix` from `createApp()`. The resource
   * registers at its own `prefix` (or `/${name}s`) directly on root.
   * Useful for webhooks, health, admin routes that shouldn't be under
   * `/api/v1`.
   *
   * @example
   * ```typescript
   * defineResource({ name: 'webhook', prefix: '/webhooks', skipGlobalPrefix: true })
   * ```
   */
  skipGlobalPrefix?: boolean;
  /** Optional for service-pattern resources */
  adapter?: DataAdapter<TDoc>;
  /** Controller instance — accepts any object with CRUD methods. */
  controller?: IController<TDoc> | ControllerLike;
  queryParser?: unknown;
  permissions?: ResourcePermissions;
  schemaOptions?: RouteSchemaOptions;
  openApiSchemas?: OpenApiSchemas;
  /** Custom JSON schemas (override Arc-generated). */
  customSchemas?: Partial<CrudSchemas>;
  /** Preset names, objects, or PresetResult values. */
  presets?: Array<string | PresetResult | { name: string; [key: string]: unknown }>;
  hooks?: ResourceHooks;
  /**
   * Functional pipeline — guards, transforms, interceptors. Flat array
   * (all operations) or per-operation map.
   *
   * @example
   * ```typescript
   * pipe: pipe(isActive, slugify, timing),
   * pipe: { create: pipe(isActive, slugify), list: pipe(timing) },
   * ```
   */
  pipe?: import("../pipeline/types.js").PipelineConfig;
  /**
   * Field-level permissions — control visibility and writability per role.
   *
   * @example
   * ```typescript
   * fields: {
   *   salary: fields.visibleTo(['admin', 'hr']),
   *   password: fields.hidden(),
   * }
   * ```
   */
  fields?: import("../permissions/fields.js").FieldPermissionMap;
  /**
   * Policy for requests that include fields the caller can't write.
   *
   * - `'reject'` (default, secure): 403 with the denied field names.
   *   Surfaces misconfigurations and write-side permission violations
   *   instead of silently dropping them.
   * - `'strip'`: legacy silent-drop behaviour — only opt in when migrating
   *   pre-2.9 code that relied on the permissive default.
   */
  onFieldWriteDenied?: "reject" | "strip";
  middlewares?: MiddlewareConfig;
  /**
   * PreHandler guards auto-applied to **every** route on this resource
   * (CRUD + custom + preset). Runs after auth/permissions, before
   * per-route `preHandler`. Use for mode gates, tenant checks, feature
   * flags — anything that applies to every endpoint.
   */
  routeGuards?: RouteHandlerMethod[];
  /**
   * Custom routes beyond CRUD. Presets also merge their routes here.
   *
   * **Route handlers return `IControllerResponse<T>` shape** —
   * `{ data, status?, meta?, headers? }`. Returning a bare value (array,
   * object, primitive) is supported via auto-envelope (2.17+) but the
   * explicit envelope is the canonical contract — declared `fields:`
   * permissions, custom `status`, `meta`, and `headers` only work when
   * you return the envelope. Set `raw: true` on a route to opt out of
   * arc's pipeline entirely (custom streaming, SSE, manual `reply.send()`).
   *
   * **Path collisions with auto-CRUD are detected at `defineResource()` time.**
   * If you declare a route that shares method+path with an auto-CRUD op
   * (e.g. `POST /` collides with `create`), validation throws with the
   * exact `disabledRoutes` line to add. Use one of:
   *   - `disabledRoutes: ['create']` — suppress the auto-CRUD op
   *   - `crud: { list: true, get: true }` — opt-in allow-list (preferred)
   *   - `disableDefaultRoutes: true` — turn off all auto-CRUD on this resource
   *
   * @example Custom route alongside default CRUD:
   * ```typescript
   * routes: [
   *   { method: 'GET', path: '/stats', handler: 'getStats', permissions: auth() },
   *   { method: 'POST', path: '/webhook', handler: webhookFn, raw: true, permissions: auth() },
   * ]
   * ```
   *
   * @example Custom POST replacing the auto-CRUD `create`:
   * ```typescript
   * disabledRoutes: ['create'],
   * routes: [
   *   { method: 'POST', path: '/', handler: customCreate, permissions: requireAuth() },
   * ]
   * ```
   */
  routes?: RouteDefinition[];
  /**
   * State-transition actions → unified `POST /:id/action` endpoint.
   * Each action can be a bare handler or full config with permissions
   * + schema.
   *
   * @example
   * ```typescript
   * actions: {
   *   approve: async (id, data, req) => service.approve(id, req.user._id),
   *   cancel: {
   *     handler: async (id, data, req) => service.cancel(id, data.reason, req.user._id),
   *     permissions: roles('admin'),
   *     schema: { reason: { type: 'string' } },
   *   },
   * },
   * actionPermissions: auth(),
   * ```
   */
  actions?: ActionsMap;
  /**
   * Fallback permission for actions without per-action permissions.
   * Only applies when `actions` is defined.
   */
  actionPermissions?: PermissionCheck;
  /**
   * Declarative aggregations (v2.13) — generate `GET /:resource/aggregations/:name`
   * routes from the portable `AggRequest` IR. Each entry pins permissions,
   * filters, lookups, measures, sort, limit, plus big-data safety knobs
   * (timeout, maxGroups, requireDateRange, indexHint, materialized).
   *
   * @example
   * ```ts
   * defineResource({
   *   name: 'order',
   *   aggregations: {
   *     revenueByStatus: defineAggregation({
   *       groupBy: 'status',
   *       measures: { count: 'count', revenue: 'sum:totalPrice' },
   *       permissions: requireRoles(['admin']),
   *       requireDateRange: { field: 'createdAt', maxRangeDays: 90 },
   *       timeout: 5000,
   *       maxGroups: 1000,
   *       cache: { staleTime: 60 },
   *     }),
   *   },
   * });
   * ```
   */
  aggregations?: import("../core/aggregation/types.js").AggregationsMap;
  /**
   * Turn off ALL auto-CRUD routes for this resource (custom `routes` /
   * `actions` / `aggregations` still mount). The canonical kill-switch —
   * `crud: false` is its declarative equivalent.
   *
   * Note: there is no `disableCrud` alias. A short-lived `disableCrud`
   * field shipped in the type but was never read by the router, so it
   * silently no-opped — removed in 2.18.0 so the only kill-switch is the
   * one that actually works.
   */
  disableDefaultRoutes?: boolean;
  /** Specific routes to disable (negative-form opt-out). */
  disabledRoutes?: CrudRouteKey[];
  /**
   * Declarative CRUD allow-list — what's ENABLED is explicit (positive form).
   *
   * Mutually exclusive with `disabledRoutes` — passing both is a config
   * error and throws at boot. Use this when you want least-privilege
   * defaults: a new CRUD op added in a future arc release won't silently
   * leak through your `disabledRoutes` list because every op is opt-in.
   *
   * - `crud: { list: true, get: true }` — only `list` + `get` mount;
   *   `create` / `update` / `delete` are NOT mounted.
   * - `crud: false` — equivalent to `disableDefaultRoutes: true` (no CRUD at all).
   * - `crud: undefined` (default) — every op mounts (legacy behaviour).
   *
   * 2.16: prefer this over `disabledRoutes` for new resources. The
   * negative form stays for back-compat but won't be the documented
   * default going forward.
   *
   * @example
   * ```ts
   * defineResource({
   *   name: 'audit-log',
   *   crud: { list: true, get: true },  // read-only — no create/update/delete
   *   permissions: { list: requireRoles(['admin']), get: requireRoles(['admin']) },
   * });
   * ```
   */
  crud?: false | { [K in CrudRouteKey]?: boolean };
  /**
   * Field name used for multi-tenant scoping (default: 'organizationId').
   * Override to match your schema: 'workspaceId', 'tenantId', etc.
   */
  tenantField?: string | false;
  /**
   * Tenant-cleanup declaration — what `cascadeDeleteForOrganization`
   * does with this resource's rows when an organization is deleted.
   * Required for the resource to participate in the cascade; unflagged
   * resources are never touched.
   *
   *   - `{ strategy: { type: 'hard' } }` — permanent delete (GDPR).
   *   - `{ strategy: { type: 'soft' } }` — set `deleted: true` + `deletedAt`
   *     (recoverable; pair with TTL for eventual hard-purge).
   *   - `{ strategy: { type: 'anonymize', fields: { name: '[REDACTED]', email: null } } }`
   *     — keep the row (legal retention) but clear PII linkage. HIPAA /
   *     PCI / SOX-compatible. Field values can be static or `(doc) =>
   *     value` for derived patches (hashes, etc.).
   *   - `{ strategy: { type: 'skip', reason: 'audit-retained-per-SOX' } }`
   *     — explicit opt-out with **mandatory** reason. Surfaces in audit reports.
   *
   * **Priority** — lower runs first. Default `100`. Use to land leaf data
   * before aggregate references:
   *   - `10`  : bulk leaf data (events, logs)
   *   - `50`  : business entities (orders, invoices)
   *   - `100` : default
   *
   * Priority groups are barriers even under concurrency — all
   * priority-10 resources finish before any priority-50 starts.
   *
   * **Batch size** — rows per chunk for the underlying `purgeByField`
   * call. Default kit-specific (~1000). Tune for very large tenants.
   *
   * @example Compliance-retained financial ledger
   * ```ts
   * defineResource({
   *   name: 'invoice',
   *   tenantField: 'organizationId',
   *   onTenantDelete: {
   *     strategy: {
   *       type: 'anonymize',
   *       fields: { customerName: '[REDACTED]', customerEmail: null },
   *     },
   *     priority: 50,
   *   },
   * });
   * ```
   */
  onTenantDelete?: OnTenantDeleteConfig;
  /**
   * Default sort applied to `list` responses when the request doesn't
   * specify one. Arc's built-in default is `-createdAt` (Mongo convention).
   *
   *   - `string` — override (e.g. `'-created_at'`, `'-id'`).
   *   - `false` — disable the default entirely. The adapter returns rows
   *     in its native order (primary-key order on most kits). **Use this
   *     for SQL/Drizzle resources that don't declare a `createdAt`
   *     column** — without it, the framework default would compile to
   *     `ORDER BY "createdAt" DESC` against a missing column.
   *
   * @example
   * ```ts
   * defineResource({ name: 'metric', defaultSort: '-recordedAt' });
   * defineResource({ name: 'tag', defaultSort: false }); // no default sort
   * ```
   */
  defaultSort?: string | false;
  /**
   * Primary key field name (default: '_id').
   *
   * Type-narrowed to `keyof TDoc` when `defineResource<TDoc>` is called
   * with a typed document interface — autocomplete for valid field names
   * — while still accepting any string when TDoc is `unknown` /
   * `AnyRecord` so adapters with dynamic shapes still work.
   *
   * @example
   * ```ts
   * defineResource<IJob>({ idField: 'jobId' })  // ← autocompletes from IJob fields
   * defineResource({ idField: 'sku' })          // ← any string allowed
   * ```
   */
  idField?: (keyof TDoc & string) | (string & {});
  /** For grouping in registry */
  module?: string;
  /** Domain events */
  events?: Record<string, EventDefinition>;
  /** Skip schema validation */
  skipValidation?: boolean;
  /** Don't register in introspection */
  skipRegistry?: boolean;
  /**
   * Default `limit` value when the request omits `?limit=`. Default 20.
   * Surfaced at the resource level (rather than only via a custom
   * `queryParser`) so hosts can declare it inline next to the resource
   * shape. Threads into both the auto-built controller's QueryResolver
   * AND the OpenAPI listQuery schema.
   *
   * For "fetch all" reference data, prefer the `referenceData: true`
   * shorthand below — it pins this AND `maxLimit` AND aggressive cache
   * defaults in one declaration.
   */
  defaultLimit?: number;
  /**
   * URL-driven `limit` ceiling. Default 100. Requests with
   * `?limit=N` above this cap fail validation with a 400 that names
   * the cap (`Query parameter 'limit' must be <= 100 (got N)`,
   * `meta.cap: 100` on the wire envelope) — 2.17.0+ surfaces the cap
   * value programmatically so callers can self-correct.
   */
  maxLimit?: number;
  /**
   * Mark this resource as **reference data** — small, mostly-static rows
   * (currencies, countries, plans, credentials, pipeline stages) that
   * callers want to fetch all of at once and cache aggressively.
   *
   * Sets the following defaults (each only when the corresponding
   * narrower flag is not explicitly set, so this stays composable):
   *
   *   - `crud: { list: true, get: true }` — read-only surface (reference
   *     data is rarely mutated through the public API; mutate via
   *     migrations / admin tools).
   *   - `defaultLimit: 1000` — one request returns everything by default.
   *   - `maxLimit: 1000` — same cap so explicit `?limit=` requests
   *     don't have to know the resource is reference data.
   *   - `cache: { staleTime: 300, gcTime: 600 }` — 5 min fresh / 10 min
   *     GC window so reference data isn't refetched on every request
   *     (values are seconds per `ResourceCacheConfig`). No-op without
   *     `queryCachePlugin` — same contract as the manual `cache` field;
   *     a first-mount diagnostic fires when the plugin is missing.
   *
   * Pre-2.17.0 hosts achieved this by sprinkling `defaultLimit: 1000` +
   * a custom queryParser + a `cache:` block across every reference
   * resource. The shorthand collapses that to one flag.
   *
   * @example
   * ```ts
   * defineResource({
   *   name: 'credential-type',
   *   adapter,
   *   referenceData: true,
   * });
   * ```
   */
  referenceData?: boolean;
  /**
   * Shorthand for the "service resource" pattern — a resource that ships
   * ONLY custom routes (no auto-CRUD, no adapter, no validation, no
   * introspection registry entry). Setting `customRoutesOnly: true`
   * is equivalent to the three-flag combo:
   *
   * ```ts
   * { disableDefaultRoutes: true, skipValidation: true, skipRegistry: true }
   * ```
   *
   * Each of those flags stays public — power users that need to opt OUT
   * of one (e.g. `customRoutesOnly: true` + `skipRegistry: false` because
   * a custom-routes-only resource still wants OpenAPI docs) can pass the
   * narrow flag explicitly; explicit settings always win over the
   * shorthand. The shorthand only fills in flags that were not set.
   *
   * @example
   * ```ts
   * defineResource({
   *   name: 'health',
   *   customRoutesOnly: true,
   *   routes: [{ method: 'GET', path: '/ping', handler: () => ({ ok: true }) }],
   * });
   * ```
   */
  customRoutesOnly?: boolean;
  /**
   * Per-resource MCP opt-out.
   *
   * - omitted / `true` (default) — resource may be surfaced by `mcpPlugin`,
   *   subject to the plugin's `expose` / `include` / `exclude` selection.
   * - `false` — opt this resource OUT of MCP tool generation entirely.
   *   Always wins over the plugin's `expose` / `include` allowlist;
   *   keeps the opt-out colocated with the resource definition instead
   *   of in a host-side blocklist that drifts as resources are added.
   *
   * Use the local opt-out for resources that should never expose tools
   * (internal back-office, audit-trail readers, system-managed entities).
   * Use the plugin-level `expose`/`include` allowlist when the cut is
   * cross-cutting (only a handful of resources should be agent-callable
   * across the whole app).
   *
   * @example
   * ```ts
   * defineResource({ name: 'internal-job-log', mcp: false, ... });
   * ```
   */
  mcp?: boolean;
  /** Internal: track applied presets */
  _appliedPresets?: string[];
  /** HTTP method for update routes. Default: 'PATCH' */
  updateMethod?: "PUT" | "PATCH" | "both";
  /**
   * Per-resource rate limiting. Requires `@fastify/rate-limit` to be
   * registered. Set to `false` to disable for this resource.
   */
  rateLimit?: RateLimitConfig | false;
  /**
   * QueryCache configuration for this resource. Enables
   * stale-while-revalidate and auto-invalidation. Requires
   * `queryCachePlugin` to be registered.
   */
  cache?: ResourceCacheConfig;
  /**
   * Per-resource audit opt-in. When `auditPlugin` is registered with
   * `autoAudit: { perResource: true }`, only resources with this flag
   * are audited.
   *
   * The cleanest pattern for apps where most resources don't need
   * auditing — no growing exclude lists, no centralized allowlist to
   * maintain.
   *
   * - `true`: Audit create/update/delete on this resource
   * - `{ operations: ['delete'] }`: Audit only specific operations
   * - `false` or omit: Not audited (default)
   *
   * @example
   * ```ts
   * await fastify.register(auditPlugin, { autoAudit: { perResource: true } });
   * defineResource({ name: 'order', audit: true });
   * defineResource({ name: 'payment', audit: { operations: ['delete'] } });
   * ```
   */
  audit?: boolean | { operations?: ("create" | "update" | "delete")[] };
  /**
   * Typed plugin-extension namespace — declarative per-resource config that
   * arc plugins read at request time. Empty by default; each installed
   * plugin augments {@link ResourceExtensions} with its own typed slice via
   * `declare module`. See {@link ResourceExtensions} for the full rationale
   * and the "React for backend" composition model.
   *
   * Threaded onto every generated route's Fastify `config` as
   * `config.arcExtensions`, so a plugin reads its slice via
   * `request.routeOptions.config.arcExtensions` without a resource lookup.
   *
   * @example
   * ```ts
   * defineResource({
   *   name: "payment",
   *   extensions: { encryption: { mode: "fields", fields: ["cardNumber"] } },
   * });
   * ```
   */
  extensions?: ResourceExtensions;
}
