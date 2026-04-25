/**
 * Resource Types — everything about defining a resource.
 *
 * `ResourceConfig`, route + action shapes, JSON schemas, middleware
 * config, presets, hooks, events. The big domain file.
 */

import type {
  FieldRule as RepoCoreFieldRule,
  SchemaBuilderOptions,
} from "@classytic/repo-core/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import type { DataAdapter } from "../adapters/interface.js";
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
   * - String: controller method name (Arc pipeline)
   * - Function without `raw: true`: receives IRequestContext, returns IControllerResponse (Arc pipeline)
   * - Function with `raw: true`: raw Fastify handler `(request, reply)`
   */
  readonly handler:
    | string
    | ControllerHandler
    | RouteHandlerMethod
    | ((request: FastifyRequest<Record<string, unknown>>, reply: FastifyReply) => unknown);
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
  /** SSE streaming mode */
  readonly streamResponse?: boolean;
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

/** Full action configuration with handler, permissions, and schema. */
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
  beforeCreate?: (ctx: ResourceHookContext) => Promise<AnyRecord | void> | AnyRecord | void;
  afterCreate?: (ctx: ResourceHookContext) => Promise<void> | void;
  beforeUpdate?: (ctx: ResourceHookContext) => Promise<AnyRecord | void> | AnyRecord | void;
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
   * @example
   * ```typescript
   * routes: [
   *   { method: 'GET', path: '/stats', handler: 'getStats', permissions: auth() },
   *   { method: 'POST', path: '/webhook', handler: webhookFn, raw: true, permissions: auth() },
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
  disableCrud?: boolean;
  disableDefaultRoutes?: boolean;
  /** Specific routes to disable */
  disabledRoutes?: CrudRouteKey[];
  /**
   * Field name used for multi-tenant scoping (default: 'organizationId').
   * Override to match your schema: 'workspaceId', 'tenantId', etc.
   */
  tenantField?: string | false;
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
}
