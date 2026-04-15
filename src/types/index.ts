/**
 * Arc Framework Types
 *
 * Clean, type-safe interfaces for the Arc framework.
 * Modern TypeScript patterns - no `any`, proper generics.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { DataAdapter } from '../adapters/interface.js';
import type { PermissionCheck, UserBase } from '../permissions/types.js';
import type { RequestScope } from '../scope/types.js';

// Re-export core types
export type { RouteHandlerMethod } from 'fastify';
// Re-export scope types
export type { RequestScope } from '../scope/types.js';
export {
  isMember,
  isElevated,
  hasOrgAccess,
  isAuthenticated,
  getOrgId,
  getOrgRoles,
  getTeamId,
  PUBLIC_SCOPE,
  AUTHENTICATED_SCOPE,
} from '../scope/types.js';
export type { ElevationOptions, ElevationEvent } from '../scope/elevation.js';

// Fastify declaration merge — request.scope is always defined
declare module 'fastify' {
  interface FastifyRequest {
    /** Request scope — set by auth adapter, read by permissions/presets/guards */
    scope: RequestScope;

    // ---- Auth / identity ----
    /**
     * Current user — set by auth adapter (Better Auth, JWT, custom).
     * `undefined` on public routes (`auth: false`) or unauthenticated requests.
     * Guard with `if (request.user)` on routes that allow anonymous access.
     *
     * Note: kept as required (not `user?`) because `@fastify/jwt` declares it
     * as required — declaration merges must have identical modifiers.
     * The `| undefined` in the type achieves the same DX: TypeScript will
     * flag unguarded access like `request.user.id` as possibly undefined.
     */
    user: Record<string, unknown> | undefined;

    // ---- Policy middleware ----
    /** Policy-injected query filters (e.g. ownership, org-scoping) */
    _policyFilters?: Record<string, unknown>;
    /** Field mask — fields to include/exclude in responses */
    fieldMask?: { include?: string[]; exclude?: string[] };
    /** Arbitrary policy metadata for downstream consumers */
    policyMetadata?: Record<string, unknown>;
    /** Document loaded by policy middleware for ownership checks */
    document?: unknown;
    /** Ownership check context (field name + user field) */
    _ownershipCheck?: Record<string, unknown>;
  }
}

/**
 * Typed Fastify request with Arc decorations.
 *
 * Use this in `raw: true` handlers instead of `(req as any).user`.
 *
 * @example
 * ```typescript
 * import type { ArcRequest } from '@classytic/arc';
 *
 * handler: async (req: ArcRequest, reply: FastifyReply) => {
 *   req.user?.id;                    // typed
 *   req.scope.organizationId;        // typed (when member)
 *   req.signal;                      // AbortSignal (Fastify 5)
 * }
 * ```
 */
export type ArcRequest = FastifyRequest & {
  scope: RequestScope;
  user: Record<string, unknown> | undefined;
  signal: AbortSignal;
};

/**
 * Response envelope helper — wraps data in Arc's standard `{ success, data }` format.
 *
 * @example
 * ```typescript
 * import { envelope } from '@classytic/arc';
 *
 * handler: async (req, reply) => {
 *   const data = await getResults();
 *   return envelope(data);
 *   // → { success: true, data }
 * }
 * ```
 */
export function envelope<T>(data: T, meta?: Record<string, unknown>): {
  success: true;
  data: T;
  [key: string]: unknown;
} {
  return { success: true, data, ...meta };
}

// Re-export from dedicated type modules
export type {
  CrudRepository,
  BulkWriteOperation,
  BulkWriteResult,
  DeleteManyResult,
  DeleteOptions,
  DeleteResult,
  InferDoc,
  KeysetPaginatedResult,
  OffsetPaginatedResult,
  PaginatedResult,
  PaginationParams,
  PaginationResult,
  QueryOptions,
  RepositorySession,
  UpdateManyResult,
  WriteOptions,
} from './repository.js';

export type {
  IRequestContext,
  IControllerResponse,
  ControllerHandler,
  FastifyHandler,
  RouteHandler,
  IController,
  ControllerLike,
} from './handlers.js';

export type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
  UserBase,
} from '../permissions/types.js';

// ============================================================================
// Base Types
// ============================================================================

export type AnyRecord = Record<string, unknown>;
/** MongoDB ObjectId — accepts string or any object with a `toString()` (e.g. mongoose ObjectId). */
export type ObjectId = string | { toString(): string };

/**
 * Flexible user type that accepts any object with id/ID properties.
 * Use this instead of `any` when dealing with user objects.
 * Re-exports UserBase from permissions module for convenience.
 * The actual user structure is defined by your app's auth system.
 */
export type UserLike = UserBase & {
  /** User email (optional) */
  email?: string;
};

/**
 * Extract user ID from a user object (supports both id and _id)
 */
export function getUserId(user: UserLike | null | undefined): string | undefined {
  if (!user) return undefined;
  const id = user.id ?? user._id;
  return id ? String(id) : undefined;
}


// ============================================================================
// Controller Types
// ============================================================================

/** Standard controller type alias for CRUD operations */
import type { IController } from './handlers.js';
export type CrudController<TDoc> = IController<TDoc>;

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  meta?: Record<string, unknown>;
}

// ============================================================================
// User Types
// ============================================================================

// UserBase is re-exported from permissions/types.ts

export interface UserOrganization {
  userId: string;
  organizationId: string;
  [key: string]: unknown;
}

export interface JWTPayload {
  sub: string;
  [key: string]: unknown;
}

// ============================================================================
// Request Types - Flexible
// ============================================================================

export interface RequestContext {
  operation?: string;
  user?: unknown; // YOUR user object
  filters?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Internal metadata shape injected by Arc's Fastify adapter.
 * Extends RequestContext with known internal fields so controllers
 * can access them without `as AnyRecord` casts.
 */
export interface ArcInternalMetadata extends RequestContext {
  /** Policy filters from permission middleware */
  _policyFilters?: Record<string, unknown>;
  /** Request scope from scope resolution */
  _scope?: import('../scope/types.js').RequestScope;
  /** Ownership check config from ownedByUser preset */
  _ownershipCheck?: { field: string; userId: string };
  /** Arc instance references (hooks, field permissions, etc.) */
  arc?: {
    hooks?: import('../hooks/HookSystem.js').HookSystem;
    fields?: import('../permissions/fields.js').FieldPermissionMap;
    [key: string]: unknown;
  };
}

/**
 * Controller-level query options - parsed from request query string
 * Includes pagination, filtering, and context data
 */
export interface ControllerQueryOptions {
  page?: number;
  limit?: number;
  sort?: string | Record<string, 1 | -1>;
  /** Simple populate (comma-separated string or array) */
  populate?: string | string[] | Record<string, unknown>;
  /**
   * Advanced populate options (Mongoose-compatible)
   * When set, takes precedence over simple `populate`
   */
  populateOptions?: PopulateOption[];
  /**
   * Lookup/join options (database-agnostic).
   * MongoKit maps these to $lookup aggregation pipeline stages.
   * Future adapters (PrismaKit, PgKit) would map to SQL JOINs.
   *
   * @example
   * URL: ?lookup[category][from]=categories&lookup[category][localField]=categorySlug&lookup[category][foreignField]=slug
   */
  lookups?: LookupOption[];
  select?: string | string[] | Record<string, 0 | 1>; // String, array, or MongoDB projection
  filters?: Record<string, unknown>;
  search?: string;
  lean?: boolean;
  after?: string; // Cursor-based pagination
  user?: unknown; // Current user context
  context?: Record<string, unknown>; // Additional context
  /** Allow additional options */
  [key: string]: unknown;
}

/**
 * Database-agnostic lookup/join option.
 * Parsed from URL: ?lookup[alias][from]=collection&lookup[alias][localField]=field&lookup[alias][foreignField]=field
 *
 * MongoKit maps this to MongoDB $lookup aggregation.
 * Future adapters would map to SQL JOINs or Prisma includes.
 */
export interface LookupOption {
  /** Source collection/table to join from */
  from: string;
  /** Local field to match on */
  localField: string;
  /** Foreign field to match on */
  foreignField: string;
  /** Alias for the joined data (defaults to the lookup key) */
  as?: string;
  /** Return a single object instead of array (default: false) */
  single?: boolean;
  /** Field selection on the joined collection (comma-separated string or projection object) */
  select?: string | Record<string, 0 | 1>;
}

/**
 * Mongoose-compatible populate option for advanced field selection
 * Used when you need to select specific fields from populated documents
 *
 * @example
 * ```typescript
 * // URL: ?populate[author][select]=name,email
 * // Generates: { path: 'author', select: 'name email' }
 * ```
 */
export interface PopulateOption {
  /** Field path to populate */
  path: string;
  /** Fields to select (space-separated) */
  select?: string;
  /** Filter conditions for populated documents */
  match?: Record<string, unknown>;
  /** Query options (limit, sort, skip) */
  options?: {
    limit?: number;
    sort?: Record<string, 1 | -1>;
    skip?: number;
  };
  /** Nested populate configuration */
  populate?: PopulateOption;
}

/**
 * Parsed query result from QueryParser
 * Includes pagination, sorting, filtering, etc.
 *
 * The index signature allows custom query parsers (like MongoKit's QueryParser)
 * to add additional fields without breaking Arc's type system.
 */
export interface ParsedQuery {
  filters?: Record<string, unknown>;
  limit?: number;
  sort?: string | Record<string, 1 | -1>;
  /** Simple populate (comma-separated string or array) */
  populate?: string | string[] | Record<string, unknown>;
  /**
   * Advanced populate options (Mongoose-compatible)
   * When set, takes precedence over simple `populate`
   * @example [{ path: 'author', select: 'name email' }]
   */
  populateOptions?: PopulateOption[];
  /**
   * Lookup/join options from MongoKit QueryParser or custom parsers.
   * Maps to $lookup in MongoDB, JOINs in SQL adapters.
   */
  lookups?: LookupOption[];
  search?: string;
  page?: number;
  after?: string; // Cursor for cursor-based pagination
  select?: string | string[] | Record<string, 0 | 1>; // MongoDB projection format
  /** Allow additional fields from custom query parsers */
  [key: string]: unknown;
}

/**
 * Query Parser Interface
 * Implement this to create custom query parsers
 *
 * @example MongoKit QueryParser
 * ```typescript
 * import { QueryParser } from '@classytic/mongokit';
 * const queryParser = new QueryParser();
 * ```
 */
export interface QueryParserInterface {
  parse(query: Record<string, unknown> | null | undefined): ParsedQuery;

  /**
   * Optional: Export OpenAPI schema for query parameters
   * Use this to document query parameters in OpenAPI/Swagger
   */
  getQuerySchema?(): {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };

  /**
   * Optional: Allowed filter fields whitelist.
   * When set, MCP auto-derives `filterableFields` from this
   * if `schemaOptions.filterableFields` is not explicitly configured.
   */
  allowedFilterFields?: readonly string[];

  /**
   * Optional: Allowed filter operators whitelist.
   * Used by MCP to enrich list tool descriptions with available operators.
   * Values are human-readable keys: 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', etc.
   */
  allowedOperators?: readonly string[];

  /**
   * Optional: Allowed sort fields whitelist.
   * Used by MCP to describe available sort options in list tool descriptions.
   */
  allowedSortFields?: readonly string[];
}

export interface FastifyRequestExtras {
  user?: Record<string, unknown>;
}

export interface RequestWithExtras extends FastifyRequest {
  /**
   * Arc metadata - set by createCrudRouter
   * Contains resource configuration and schema options
   */
  arc?: {
    resourceName?: string;
    schemaOptions?: RouteSchemaOptions;
    permissions?: ResourcePermissions;
  };
  context?: Record<string, unknown>; // Additional context data
  _policyFilters?: Record<string, unknown>; // Policy filters from middleware
  fieldMask?: { include?: string[]; exclude?: string[] }; // Field projection for responses
  _ownershipCheck?: Record<string, unknown>; // Ownership validation context
}

export type FastifyWithAuth = FastifyInstance & {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

/**
 * Arc core decorator interface
 * Added by arcCorePlugin to provide instance-scoped hooks and registry
 */
export interface ArcDecorator {
  /** Instance-scoped hook system */
  hooks: import('../hooks/HookSystem.js').HookSystem;
  /** Instance-scoped resource registry */
  registry: import('../registry/ResourceRegistry.js').ResourceRegistry;
  /** Whether event emission is enabled */
  emitEvents: boolean;
}

/**
 * Events decorator interface
 * Added by eventPlugin to provide event pub/sub
 */
export interface EventsDecorator {
  /** Publish an event */
  publish: <T>(type: string, payload: T, meta?: Partial<{ id: string; timestamp: Date }>) => Promise<void>;
  /** Subscribe to events */
  subscribe: (pattern: string, handler: (event: unknown) => void | Promise<void>) => Promise<() => void>;
  /** Get transport name */
  transportName: string;
}

/**
 * Fastify instance with Arc decorators
 * Arc adds these decorators via plugins/presets
 */
export type FastifyWithDecorators = FastifyInstance & {
  // Arc core decorator (from arcCorePlugin)
  arc?: ArcDecorator;

  // Events decorator (from eventPlugin)
  events?: EventsDecorator;

  // Auth decorators (from auth plugin)
  authenticate?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  optionalAuthenticate?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

  // Organization-scoped filtering (from multiTenant preset)
  organizationScoped?: (options?: { required?: boolean }) => RouteHandlerMethod;

  // Custom decorators from your app
  [key: string]: unknown;
};

export interface OwnershipCheck {
  field: string;
  userField?: string;
}

// ============================================================================
// Resource & Route Types
// ============================================================================

import type { ControllerLike } from './handlers.js';

/**
 * Per-resource rate limit configuration.
 *
 * Applied to all routes of the resource when `@fastify/rate-limit` is registered
 * on the Fastify instance. Set to `false` to explicitly disable rate limiting
 * for a resource even when a global rate limit is configured.
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'product',
 *   rateLimit: { max: 100, timeWindow: '1 minute' },
 * });
 * ```
 */
/**
 * Per-resource cache configuration for QueryCache.
 * Enables stale-while-revalidate, auto-invalidation on mutations,
 * and cross-resource tag-based invalidation.
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
   * When matched event fires, all caches with those tags are invalidated.
   * @example { 'category.*': ['catalog'] }
   */
  invalidateOn?: Record<string, string[]>;
  /** Disable caching for this resource */
  disabled?: boolean;
}

export interface RateLimitConfig {
  /** Maximum number of requests allowed within the time window */
  max: number;
  /** Time window for rate limiting (e.g., '1 minute', '15 seconds', '1 hour') */
  timeWindow: string;
}

export interface ResourceConfig<TDoc = AnyRecord> {
  name: string;
  displayName?: string;
  tag?: string;
  prefix?: string; // Defaults to `/${name}s` if not provided
  /**
   * Skip the global `resourcePrefix` from `createApp()`.
   * The resource registers at its own `prefix` (or `/${name}s`) directly on root.
   * Useful for webhooks, health, admin routes that shouldn't be under `/api/v1`.
   *
   * @example
   * ```typescript
   * defineResource({ name: 'webhook', prefix: '/webhooks', skipGlobalPrefix: true })
   * // Registers at /webhooks even when createApp({ resourcePrefix: '/api/v1' })
   * ```
   */
  skipGlobalPrefix?: boolean;
  adapter?: DataAdapter<TDoc>; // Optional for service-pattern resources
  /** Controller instance - accepts any object with CRUD methods */
  controller?: IController<TDoc> | ControllerLike;
  queryParser?: unknown;
  permissions?: ResourcePermissions;
  schemaOptions?: RouteSchemaOptions;
  openApiSchemas?: OpenApiSchemas;
  customSchemas?: Partial<CrudSchemas>; // Custom JSON schemas
  presets?: Array<string | PresetResult | { name: string; [key: string]: unknown }>; // Preset names, objects, or PresetResult
  hooks?: ResourceHooks;
  /**
   * Functional pipeline — guards, transforms, and interceptors.
   * Can be a flat array (all operations) or per-operation map.
   *
   * @example
   * ```typescript
   * import { pipe, guard, transform, intercept } from '@classytic/arc';
   *
   * resource('product', {
   *   pipe: pipe(isActive, slugify, timing),
   *   // OR per-operation:
   *   pipe: { create: pipe(isActive, slugify), list: pipe(timing) },
   * });
   * ```
   */
  pipe?: import('../pipeline/types.js').PipelineConfig;
  /**
   * Field-level permissions — control visibility and writability per role.
   *
   * @example
   * ```typescript
   * import { fields } from '@classytic/arc';
   * fields: {
   *   salary: fields.visibleTo(['admin', 'hr']),
   *   password: fields.hidden(),
   * }
   * ```
   */
  fields?: import('../permissions/fields.js').FieldPermissionMap;
  middlewares?: MiddlewareConfig;
  /**
   * PreHandler guards auto-applied to **every** route on this resource
   * (CRUD + custom `routes` + preset routes). Runs after auth/permissions,
   * before per-route `preHandler`. Use for mode gates, tenant checks,
   * feature flags — anything that applies to every endpoint.
   *
   * @example
   * ```typescript
   * defineResource({
   *   routeGuards: [requireFlowMode('standard')],
   *   routes: [
   *     { method: 'GET', path: '/', raw: true, handler: listHandler },
   *     // guard runs automatically — no per-route boilerplate
   *   ],
   * });
   * ```
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
   * State-transition actions → unified POST /:id/action endpoint.
   * Each action can be a bare handler or full config with permissions + schema.
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
  disabledRoutes?: CrudRouteKey[]; // Specific routes to disable
  /**
   * Field name used for multi-tenant scoping (default: 'organizationId').
   * Override to match your schema: 'workspaceId', 'tenantId', 'teamId', etc.
   * Takes effect when org context is present (via multiTenant preset).
   */
  tenantField?: string | false;
  /**
   * Primary key field name (default: '_id').
   *
   * Type-narrowed to `keyof TDoc` when `defineResource<TDoc>` is called with
   * a typed document interface — gives autocomplete for valid field names —
   * while still accepting any string when TDoc is `unknown` / `AnyRecord` so
   * adapters with dynamic shapes still work.
   *
   * @example
   * ```ts
   * defineResource<IJob>({ idField: 'jobId' })  // ← autocompletes from IJob fields
   * defineResource({ idField: 'sku' })          // ← any string allowed
   * ```
   *
   * Override for non-MongoDB adapters (e.g., 'id' for SQL databases) or
   * resources keyed by a business identifier (slug, sku, orderNumber).
   */
  idField?: (keyof TDoc & string) | (string & {});
  module?: string; // For grouping in registry
  events?: Record<string, EventDefinition>; // Domain events
  skipValidation?: boolean; // Skip schema validation
  skipRegistry?: boolean; // Don't register in introspection
  _appliedPresets?: string[]; // Internal: track applied presets
  /**
   * Called during plugin registration with the scoped Fastify instance.
   * Use for wiring singletons, reading decorators, or setting up resource-specific
   * services that need access to the Fastify instance.
   *
   * @example
   * ```typescript
   * defineResource({
   *   name: 'notification',
   *   onRegister: (fastify) => {
   *     setSseManager(fastify.sseManager);
   *   },
   * })
   * ```
   */
  onRegister?: (fastify: FastifyInstance) => void | Promise<void>;
  /** HTTP method for update routes. Default: 'PATCH' */
  updateMethod?: 'PUT' | 'PATCH' | 'both';
  /**
   * Per-resource rate limiting.
   * Requires `@fastify/rate-limit` to be registered on the Fastify instance.
   * Set to `false` to disable rate limiting for this resource.
   */
  rateLimit?: RateLimitConfig | false;
  /**
   * QueryCache configuration for this resource.
   * Enables stale-while-revalidate and auto-invalidation.
   * Requires `queryCachePlugin` to be registered.
   */
  cache?: ResourceCacheConfig;
  /**
   * Per-resource audit opt-in. When `auditPlugin` is registered with
   * `autoAudit: { perResource: true }`, only resources with this flag are audited.
   *
   * The cleanest pattern for apps where most resources don't need auditing —
   * no growing exclude lists, no centralized allowlist to maintain.
   *
   * - `true`: Audit create/update/delete on this resource
   * - `{ operations: ['delete'] }`: Audit only specific operations
   * - `false` or omit: Not audited (default)
   *
   * @example
   * ```ts
   * // app.ts
   * await fastify.register(auditPlugin, {
   *   autoAudit: { perResource: true },
   * });
   *
   * // order.resource.ts
   * defineResource({ name: 'order', audit: true });
   *
   * // payment.resource.ts
   * defineResource({ name: 'payment', audit: { operations: ['delete'] } });
   * ```
   */
  audit?: boolean | { operations?: ("create" | "update" | "delete")[] };
}

/**
 * Resource-level permissions
 * ONLY PermissionCheck functions allowed - no string arrays
 */
export interface ResourcePermissions {
  list?: PermissionCheck;
  get?: PermissionCheck;
  create?: PermissionCheck;
  update?: PermissionCheck;
  delete?: PermissionCheck;
}

/**
 * Hook context passed to resource-level hook handlers.
 * Mirrors HookSystem's HookContext but with a simpler API for inline use.
 */
export interface ResourceHookContext {
  /** The document data (create/update body, or existing doc for delete) */
  data: AnyRecord;
  /** Authenticated user or null */
  user?: UserBase;
  /** Additional metadata (e.g. `{ id, existing }` for update/delete) */
  meta?: AnyRecord;
}

/**
 * Inline lifecycle hooks on a resource definition.
 * These are wired into the HookSystem automatically — same pipeline as presets and app-level hooks.
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'chat',
 *   hooks: {
 *     afterCreate: async (ctx) => {
 *       analytics.track('chat.created', { chatId: ctx.data._id, userId: ctx.user?.id });
 *     },
 *     beforeDelete: async (ctx) => {
 *       if (ctx.data.isProtected) throw new Error('Cannot delete protected chat');
 *     },
 *     afterDelete: async (ctx) => {
 *       await notificationService.send('chat.deleted', { id: ctx.meta?.id });
 *     },
 *   },
 * });
 * ```
 */
export interface ResourceHooks {
  /** Runs before create — can modify data by returning a new object */
  beforeCreate?: (ctx: ResourceHookContext) => Promise<AnyRecord | void> | AnyRecord | void;
  /** Runs after create — receives the created document */
  afterCreate?: (ctx: ResourceHookContext) => Promise<void> | void;
  /** Runs before update — ctx.meta.id has the resource ID, ctx.meta.existing has the current doc */
  beforeUpdate?: (ctx: ResourceHookContext) => Promise<AnyRecord | void> | AnyRecord | void;
  /** Runs after update — receives the updated document */
  afterUpdate?: (ctx: ResourceHookContext) => Promise<void> | void;
  /** Runs before delete — ctx.data is the existing doc, ctx.meta.id has the resource ID */
  beforeDelete?: (ctx: ResourceHookContext) => Promise<void> | void;
  /** Runs after delete — ctx.data is the deleted doc, ctx.meta.id has the resource ID */
  afterDelete?: (ctx: ResourceHookContext) => Promise<void> | void;
}

/**
 * Additional route definition for custom endpoints
 */
export interface AdditionalRoute {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Route path (relative to resource prefix) */
  path: string;
  /**
   * Handler - string (controller method name) or function.
   *
   * When `wrapHandler: true`:
   * - `string` — calls controller method by name (e.g., `'approve'`)
   * - `ControllerHandler` — receives `IRequestContext`, returns `IControllerResponse`
   *
   * When `wrapHandler: false`:
   * - Fastify handler `(request, reply) => unknown`
   */
  handler: string | import('./handlers.js').ControllerHandler | RouteHandlerMethod | ((request: FastifyRequest<any>, reply: FastifyReply) => unknown);

  /** Permission check - REQUIRED */
  permissions: PermissionCheck;

  /**
   * Handler type - REQUIRED, no auto-detection
   * true = ControllerHandler (receives context object)
   * false = FastifyHandler (receives request, reply)
   */
  wrapHandler: boolean;

  /**
   * Logical operation name for pipeline keys and permission actions.
   * Defaults to handler name (string handlers) or method+path slug.
   * Prevents collisions when multiple routes share the same HTTP method.
   *
   * @example
   * operation: 'listDeleted'  // Used as pipeline key and permission action
   * operation: 'restore'
   */
  operation?: string;

  /** OpenAPI summary */
  summary?: string;
  /** OpenAPI description */
  description?: string;
  /** OpenAPI tags */
  tags?: string[];

  /**
   * Custom route-level middleware
   * Can be an array of handlers or a function that receives fastify and returns handlers
   * @example
   * // Direct array
   * preHandler: [myMiddleware]
   * // Function that receives fastify (for accessing decorators)
   * preHandler: (fastify) => [fastify.customerContext({ required: true })]
   */
  preHandler?: RouteHandlerMethod[] | ((fastify: FastifyInstance) => RouteHandlerMethod[]);

  /**
   * Pre-auth handlers — run BEFORE authentication middleware.
   * Use for promoting query params to headers (e.g., EventSource ?token= → Authorization).
   *
   * @example
   * ```typescript
   * preAuth: [(req) => {
   *   const token = (req.query as Record<string, string>)?.token;
   *   if (token) req.headers.authorization = `Bearer ${token}`;
   * }]
   * ```
   */
  preAuth?: RouteHandlerMethod[];

  /**
   * Streaming response mode — designed for SSE and AI streaming routes.
   * When `true`:
   * - Forces `wrapHandler: false` (no `{ success, data }` wrapper)
   * - Sets SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
   * - `request.signal` (Fastify 5 built-in) is available for abort-on-disconnect
   *
   * @example
   * ```typescript
   * {
   *   method: 'POST',
   *   path: '/stream',
   *   streamResponse: true,
   *   permissions: requireAuth(),
   *   handler: async (request, reply) => {
   *     const { stream } = await generateStream({ abortSignal: request.signal });
   *     return reply.send(stream);
   *   },
   * }
   * ```
   */
  streamResponse?: boolean;

  /** Fastify route schema */
  schema?: Record<string, unknown>;

  /**
   * MCP handler for routes with `wrapHandler: false`.
   * When set, this route becomes an MCP tool without needing `wrapHandler: true`.
   * The HTTP handler stays a plain Fastify handler; MCP gets a parallel entry point.
   *
   * @example
   * ```typescript
   * additionalRoutes: [{
   *   method: 'GET',
   *   path: '/stats',
   *   handler: (req, reply) => reply.send(getStats()),
   *   wrapHandler: false,
   *   permissions: isAuthenticated,
   *   mcpHandler: async (input) => ({
   *     content: [{ type: 'text', text: JSON.stringify(await getStats()) }],
   *   }),
   * }]
   * ```
   */
  mcpHandler?: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;

  /**
   * MCP tool generation config preserved from v2.8 `routes`.
   * - `false`: skip MCP tool generation for this route
   * - `true` / omitted: auto-generate when the route goes through Arc's pipeline
   * - object: explicit description/annotations overrides
   *
   * Added in 2.8.1 — previously dropped during `routes → additionalRoutes`
   * normalization, breaking MCP opt-out and per-route annotations.
   */
  mcp?: boolean | {
    readonly description?: string;
    readonly annotations?: {
      readonly readOnlyHint?: boolean;
      readonly destructiveHint?: boolean;
      readonly idempotentHint?: boolean;
      readonly openWorldHint?: boolean;
    };
  };
}

// ============================================================================
// Route Definition (v2.8 — replaces additionalRoutes for users)
// ============================================================================

/** HTTP methods for custom routes */
type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** MCP tool configuration for a route or action */
interface RouteMcpConfig {
  /** Override auto-generated tool description */
  readonly description?: string;
  /** MCP tool annotations */
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly idempotentHint?: boolean; readonly openWorldHint?: boolean };
}

/**
 * Route definition — replaces additionalRoutes.
 *
 * - `handler: 'string'` → controller method → full Arc pipeline + MCP tool
 * - `handler: function` → inline handler → full Arc pipeline + MCP tool
 * - `raw: true` → raw Fastify handler → no pipeline, no MCP by default
 */
interface RouteDefinition {
  readonly method: RouteMethod;
  /** Path relative to resource prefix */
  readonly path: string;
  /**
   * Route handler.
   * - String: controller method name (goes through Arc pipeline)
   * - Function without `raw: true`: receives IRequestContext, returns IControllerResponse (goes through Arc pipeline)
   * - Function with `raw: true`: raw Fastify handler (request, reply)
   */
  readonly handler: string | import('./handlers.js').ControllerHandler | RouteHandlerMethod | ((request: FastifyRequest<Record<string, unknown>>, reply: FastifyReply) => unknown);
  /** Permission check — REQUIRED */
  readonly permissions: PermissionCheck;
  /**
   * Raw mode — bypasses Arc pipeline. Handler receives raw Fastify request/reply.
   * Default: false (handler goes through Arc pipeline).
   */
  readonly raw?: boolean;
  /** Logical operation name (for pipeline keys, MCP tool naming). Defaults to handler name or method+path slug. */
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
   * Fastify route schema. Each slot (`body`, `querystring`, `params`, `headers`,
   * `response[status]`) accepts a plain JSON Schema object **or** a Zod v4 schema —
   * arc auto-converts via `convertRouteSchema` at registration time. Slot values
   * are typed `unknown` so class-based Zod schemas assign without casts.
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
   * MCP handler for raw routes — parallel entry point for MCP without changing HTTP handler.
   */
  readonly mcpHandler?: (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

// ============================================================================
// Action Definition (v2.8 — replaces onRegister + createActionRouter)
// ============================================================================

/**
 * Action handler function for state transitions.
 * Receives the resource ID, action-specific data, and the request context.
 */
type ActionHandlerFn = (
  id: string,
  data: Record<string, unknown>,
  req: RequestWithExtras,
) => Promise<unknown>;

/**
 * Full action configuration with handler, permissions, and schema.
 */
interface ActionDefinition {
  /** Action handler */
  readonly handler: ActionHandlerFn;
  /** Per-action permission check (overrides resource-level actionPermissions) */
  readonly permissions?: PermissionCheck;
  /**
   * JSON Schema or Zod v4 schema for action-specific body fields.
   * Per-field values are typed `unknown` so Zod class instances assign without casts.
   */
  readonly schema?: Record<string, unknown>;
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

/** Action config: bare handler function OR full ActionDefinition */
type ActionEntry = ActionHandlerFn | ActionDefinition;

/** Actions configuration map */
type ActionsMap = Record<string, ActionEntry>;

export interface RouteSchemaOptions {
  hiddenFields?: string[];
  readonlyFields?: string[];
  requiredFields?: string[];
  optionalFields?: string[];
  excludeFields?: string[];
  /**
   * Fields allowed for filtering in list operations.
   * Used by MCP tool generation to build the list tool's input schema.
   * If not set and using a QueryParser with `allowedFilterFields`, MCP auto-derives from it.
   */
  filterableFields?: string[];
  fieldRules?: Record<string, {
    systemManaged?: boolean;
    hidden?: boolean;
    immutable?: boolean;
    immutableAfterCreate?: boolean;
    optional?: boolean;
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
    /** Human-readable description — auto-maps to OpenAPI `description` */
    description?: string;
    [key: string]: unknown;
  }>;
  query?: Record<string, unknown>; // Query parameter schema for OpenAPI
}

export interface FieldRule {
  field: string;
  required?: boolean;
  readonly?: boolean;
  hidden?: boolean;
}

/**
 * CRUD Route Schemas (Fastify Native Format)
 *
 * Each slot accepts either a plain JSON Schema object **or** a Zod v4 schema —
 * arc's `convertRouteSchema` feature-detects at runtime. The slot values are
 * typed `unknown` (not `Record<string, unknown>`) so class-based Zod schemas
 * assign cleanly without `as unknown as Record<string, unknown>` casts.
 *
 * @example
 * ```ts
 * {
 *   list: {
 *     querystring: { type: 'object', properties: { page: { type: 'number' } } },
 *     response: { 200: z.object({ docs: z.array(EntitySchema) }) }
 *   },
 *   create: {
 *     body: z.object({ name: z.string(), size: z.number().int().positive() }),
 *     response: { 201: EntitySchema }
 *   }
 * }
 * ```
 */
export interface CrudSchemas {
  /** GET / - List all resources */
  list?: {
    /** Plain JSON Schema or Zod schema (auto-converted). */
    querystring?: unknown;
    /** Map of HTTP status code → JSON Schema or Zod schema. */
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };

  /** GET /:id - Get single resource */
  get?: {
    params?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };

  /** POST / - Create resource */
  create?: {
    body?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };

  /** PATCH /:id - Update resource */
  update?: {
    params?: unknown;
    body?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };

  /** DELETE /:id - Delete resource */
  delete?: {
    params?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };

  // Allow custom operation schemas
  [key: string]: unknown;
}

export interface OpenApiSchemas {
  entity?: unknown;
  createBody?: unknown;
  updateBody?: unknown;
  params?: unknown;
  listQuery?: unknown;
  /**
   * Explicit response schema for OpenAPI documentation.
   * If provided, this will be used as-is for the response schema.
   * If not provided, response schema is auto-generated from createBody.
   *
   * Note: This is for OpenAPI docs only - does NOT affect Fastify serialization.
   *
   * @example
   * response: {
   *   type: 'object',
   *   properties: {
   *     _id: { type: 'string' },
   *     name: { type: 'string' },
   *     email: { type: 'string' },
   *     // Exclude password, include virtuals
   *     fullName: { type: 'string' },
   *   }
   * }
   */
  response?: unknown;
  [key: string]: unknown;
}

/** Handler for middleware functions */
export type MiddlewareHandler = (request: RequestWithExtras, reply: FastifyReply) => Promise<unknown>;
export type CrudRouteKey = 'list' | 'get' | 'create' | 'update' | 'delete';

// ============================================================================
// Middleware & Config Types
// ============================================================================

export interface MiddlewareConfig {
  list?: MiddlewareHandler[];
  get?: MiddlewareHandler[];
  create?: MiddlewareHandler[];
  update?: MiddlewareHandler[];
  delete?: MiddlewareHandler[];
  [key: string]: MiddlewareHandler[] | undefined;
}

// ============================================================================
// Auth Types - Flexible, Database-Agnostic
// ============================================================================

/**
 * JWT utilities provided to authenticator
 * Arc provides these helpers, app uses them as needed
 */
export interface JwtContext {
  /** Verify a JWT token and return decoded payload */
  verify: <T = Record<string, unknown>>(token: string) => T;
  /** Sign a payload and return JWT token */
  sign: (payload: Record<string, unknown>, options?: { expiresIn?: string }) => string;
  /** Decode without verification (for inspection) */
  decode: <T = Record<string, unknown>>(token: string) => T | null;
}

/**
 * Context passed to app's authenticator function
 */
export interface AuthenticatorContext {
  /** JWT utilities (available if jwt.secret provided) */
  jwt: JwtContext | null;
  /** Fastify instance for advanced use cases */
  fastify: FastifyInstance;
}

/**
 * App-provided authenticator function
 *
 * Arc calls this for every non-public route.
 * App has FULL control over authentication logic.
 *
 * @example
 * ```typescript
 * // Simple JWT auth
 * authenticate: async (request, { jwt }) => {
 *   const token = request.headers.authorization?.split(' ')[1];
 *   if (!token || !jwt) return null;
 *   const decoded = jwt.verify(token);
 *   return userRepo.findById(decoded.id);
 * }
 *
 * // Multi-strategy (JWT + API Key)
 * authenticate: async (request, { jwt }) => {
 *   const apiKey = request.headers['x-api-key'];
 *   if (apiKey) {
 *     const result = await apiKeyService.verify(apiKey);
 *     if (result) return { _id: result.userId, isApiKey: true };
 *   }
 *   const token = request.headers.authorization?.split(' ')[1];
 *   if (token && jwt) {
 *     const decoded = jwt.verify(token);
 *     return userRepo.findById(decoded.id);
 *   }
 *   return null;
 * }
 * ```
 */
export type Authenticator = (
  request: FastifyRequest,
  context: AuthenticatorContext
) => Promise<unknown | null> | unknown | null;

/**
 * Token pair returned by issueTokens helper
 */
export interface TokenPair {
  /** Access token (JWT) */
  accessToken: string;
  /** Refresh token (JWT with longer expiry) */
  refreshToken?: string;
  /** Access token expiry in seconds */
  expiresIn: number;
  /** Refresh token expiry in seconds */
  refreshExpiresIn?: number;
  /** Token type (always 'Bearer') */
  tokenType: 'Bearer';
}

/**
 * Auth helpers available on fastify.auth
 *
 * @example
 * ```typescript
 * // In login handler
 * const user = await userRepo.findByEmail(email);
 * if (!user || !await bcrypt.compare(password, user.password)) {
 *   return reply.code(401).send({ error: 'Invalid credentials' });
 * }
 *
 * const tokens = fastify.auth.issueTokens({
 *   id: user._id,
 *   email: user.email,
 *   role: user.role,
 * });
 *
 * return { success: true, ...tokens, user };
 * ```
 */
export interface AuthHelpers {
  /** JWT utilities (if configured) */
  jwt: JwtContext | null;

  /**
   * Issue access + refresh tokens for a user
   * App calls this after validating credentials
   */
  issueTokens: (
    payload: Record<string, unknown>,
    options?: { expiresIn?: string; refreshExpiresIn?: string }
  ) => TokenPair;

  /**
   * Verify a refresh token and return decoded payload
   */
  verifyRefreshToken: <T = Record<string, unknown>>(token: string) => T;
}

export interface ServiceContext {
  user?: unknown;
  requestId?: string;
  select?: string[] | Record<string, 0 | 1>; // Field projection for responses
  populate?: string | string[]; // Relations to populate
  lean?: boolean; // Return plain objects
}

// ============================================================================
// Preset Types
// ============================================================================

export interface PresetHook {
  operation: 'create' | 'update' | 'delete' | 'read' | 'list';
  phase: 'before' | 'after';
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

// ============================================================================
// Plugin Types
// ============================================================================

export interface GracefulShutdownOptions {
  timeout?: number;
  onShutdown?: () => Promise<void> | void;
  signals?: NodeJS.Signals[];
  logEvents?: boolean;
}

export interface RequestIdOptions {
  headerName?: string;
  generator?: () => string;
}

export interface HealthOptions {
  path?: string;
  check?: () => Promise<unknown>;
}

export interface HealthCheck {
  healthy: boolean;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Auth Plugin Options - Clean, Minimal Configuration
 *
 * Arc provides JWT infrastructure and calls your authenticator.
 * You control ALL authentication logic.
 *
 * @example
 * ```typescript
 * // Minimal: just JWT (uses default jwtVerify)
 * auth: {
 *   jwt: { secret: process.env.JWT_SECRET },
 * }
 *
 * // With custom authenticator (recommended)
 * auth: {
 *   jwt: { secret: process.env.JWT_SECRET },
 *   authenticate: async (request, { jwt }) => {
 *     const token = request.headers.authorization?.split(' ')[1];
 *     if (!token) return null;
 *     const decoded = jwt.verify(token);
 *     return userRepo.findById(decoded.id);
 *   },
 * }
 *
 * // Multi-strategy (JWT + API Key)
 * auth: {
 *   jwt: { secret: process.env.JWT_SECRET },
 *   authenticate: async (request, { jwt }) => {
 *     // Try API key first (faster)
 *     const apiKey = request.headers['x-api-key'];
 *     if (apiKey) {
 *       const result = await apiKeyService.verify(apiKey);
 *       if (result) return { _id: result.userId, isApiKey: true };
 *     }
 *     // Try JWT
 *     const token = request.headers.authorization?.split(' ')[1];
 *     if (token) {
 *       const decoded = jwt.verify(token);
 *       return userRepo.findById(decoded.id);
 *     }
 *     return null;
 *   },
 *   onFailure: (request, reply) => {
 *     reply.code(401).send({
 *       success: false,
 *       error: 'Authentication required',
 *       message: 'Use Bearer token or X-API-Key header',
 *     });
 *   },
 * }
 * ```
 */
export interface AuthPluginOptions {
  /**
   * JWT configuration (optional but recommended)
   * If provided, jwt utilities are available in authenticator context
   */
  jwt?: {
    /** JWT secret (required for JWT features) */
    secret: string;
    /** Access token expiry (default: '15m') */
    expiresIn?: string;
    /** Refresh token secret (defaults to main secret) */
    refreshSecret?: string;
    /** Refresh token expiry (default: '7d') */
    refreshExpiresIn?: string;
    /** Additional @fastify/jwt sign options */
    sign?: Record<string, unknown>;
    /** Additional @fastify/jwt verify options */
    verify?: Record<string, unknown>;
  };

  /**
   * Custom authenticator function (recommended)
   *
   * Arc calls this for non-public routes.
   * Return user object to authenticate, null/undefined to reject.
   *
   * If not provided and jwt.secret is set, uses default jwtVerify.
   */
  authenticate?: Authenticator;

  /**
   * Custom auth failure handler
   * Customize the 401 response when authentication fails
   */
  onFailure?: (
    request: FastifyRequest,
    reply: FastifyReply,
    error?: Error
  ) => void | Promise<void>;

  /**
   * Expose detailed auth error messages in 401 responses.
   * When false (default), returns generic "Authentication required".
   * When true, includes the actual error message for debugging.
   * Decoupled from log level — set explicitly per environment.
   */
  exposeAuthErrors?: boolean;

  /**
   * Property name to store user on request (default: 'user')
   */
  userProperty?: string;

  /**
   * Custom token extractor for the built-in JWT auth path.
   * When not provided, defaults to extracting Bearer token from Authorization header.
   * Use this when tokens are in HttpOnly cookies, custom headers, or query params.
   *
   * @example
   * ```typescript
   * // Extract from HttpOnly cookie
   * tokenExtractor: (request) => request.cookies?.['auth-token'] ?? null,
   *
   * // Extract from custom header
   * tokenExtractor: (request) => request.headers['x-api-token'] as string ?? null,
   * ```
   */
  tokenExtractor?: (request: FastifyRequest) => string | null;

  /**
   * Token revocation check — called after JWT verification succeeds.
   * Return `true` to reject the token (revoked), `false` to allow.
   *
   * Arc provides this primitive — implement your own store (Redis set,
   * DB lookup, Better Auth session check, etc.)
   *
   * **Fail-closed**: if the check throws, the token is treated as revoked.
   *
   * @example
   * ```typescript
   * // Redis-backed revocation
   * isRevoked: async (decoded) => {
   *   return await redis.sismember('revoked-tokens', decoded.jti ?? decoded.id);
   * },
   *
   * // DB-backed revocation
   * isRevoked: async (decoded) => {
   *   const user = await db.user.findById(decoded.id);
   *   return !user || user.bannedAt != null;
   * },
   * ```
   */
  isRevoked?: (decoded: Record<string, unknown>) => boolean | Promise<boolean>;
}


export interface IntrospectionPluginOptions {
  path?: string;
  prefix?: string;
  enabled?: boolean;
  authRoles?: string[];
}

export interface CrudRouterOptions {
  /** Route prefix */
  prefix?: string;

  /** Permission checks for CRUD operations */
  permissions?: ResourcePermissions;

  /** OpenAPI tag for grouping routes */
  tag?: string;

  /** JSON schemas for CRUD operations */
  schemas?: Partial<CrudSchemas>;

  /** Middlewares for each CRUD operation */
  middlewares?: MiddlewareConfig;

  /** Additional custom routes (from presets or user-defined) */
  additionalRoutes?: AdditionalRoute[];

  /** Disable all default CRUD routes */
  disableDefaultRoutes?: boolean;

  /** Disable specific CRUD routes */
  disabledRoutes?: CrudRouteKey[];

  /** Functional pipeline (guard/transform/intercept) */
  pipe?: import('../pipeline/types.js').PipelineConfig;

  /** Resource name for lifecycle hooks */
  resourceName?: string;

  /** Schema generation options */
  schemaOptions?: RouteSchemaOptions;

  /** Field-level permissions (visibility, writability per role) */
  fields?: import('../permissions/fields.js').FieldPermissionMap;

  /** HTTP method for update routes. Default: 'PATCH' */
  updateMethod?: 'PUT' | 'PATCH' | 'both';

  /**
   * Per-resource rate limiting.
   * Requires `@fastify/rate-limit` to be registered on the Fastify instance.
   * Set to `false` to disable rate limiting for this resource.
   */
  rateLimit?: RateLimitConfig | false;

  /** PreHandler guards applied to every route (CRUD + custom + preset). */
  routeGuards?: RouteHandlerMethod[];
}

// ============================================================================
// Registry & Metadata Types
// ============================================================================

export interface ResourceMetadata {
  name: string;
  displayName?: string;
  tag?: string;
  prefix: string;
  module?: string;
  permissions?: ResourcePermissions;
  presets: string[];
  customRoutes?: Array<{
    method: string;
    path: string;
    handler: string;
    operation?: string;
    summary?: string;
    description?: string;
    permissions?: PermissionCheck;
    raw?: boolean;
    schema?: Record<string, unknown>;
  }>;
  routes: Array<{
    method: string;
    path: string;
    handler?: string;
    operation?: string;
    summary?: string;
  }>;
  events?: string[];
}

export interface RegistryEntry extends ResourceMetadata {
  plugin: unknown;
  adapter?: { type: string; name: string } | null;
  events?: string[];
  disableDefaultRoutes?: boolean;
  openApiSchemas?: OpenApiSchemas;
  registeredAt?: string;
  /** Field-level permissions metadata (for OpenAPI docs) */
  fieldPermissions?: Record<string, { type: string; roles?: readonly string[]; redactValue?: unknown }>;
  /** Pipeline step names (for OpenAPI docs) */
  pipelineSteps?: Array<{ type: string; name: string; operations?: string[] }>;
  /** Update HTTP method(s) used for this resource */
  updateMethod?: 'PUT' | 'PATCH' | 'both';
  /** Routes disabled for this resource */
  disabledRoutes?: string[];
  /** Rate limit config */
  rateLimit?: RateLimitConfig | false;
  /** Per-resource audit opt-in flag (read by auditPlugin perResource mode) */
  audit?: boolean | { operations?: ("create" | "update" | "delete")[] };
  /**
   * v2.8 declarative actions metadata — populated from `ResourceConfig.actions`.
   *
   * Consumed by OpenAPI generation (renders `POST /:id/action` with a
   * discriminated body schema) and MCP tool generation.
   *
   * Added in 2.8.1.
   */
  actions?: Array<{
    readonly name: string;
    readonly description?: string;
    /** Raw per-action schema (JSON Schema, Zod v4, or legacy field map) */
    readonly schema?: Record<string, unknown>;
    /** Per-action permission check (if different from resource-level `actionPermissions`) */
    readonly permissions?: PermissionCheck;
    /** MCP tool generation flag — `false` to skip, object for overrides */
    readonly mcp?: boolean | {
      readonly description?: string;
      readonly annotations?: Record<string, unknown>;
    };
  }>;
  /**
   * Resource-level fallback permission for actions without per-action
   * permissions. Used by OpenAPI to determine auth requirements and by MCP
   * as the fallback in `createActionToolHandler`.
   *
   * Added in 2.8.1 — previously not surfaced to downstream consumers,
   * causing OpenAPI to mark action endpoints as public when runtime required auth.
   */
  actionPermissions?: PermissionCheck;
}

export interface RegistryStats {
  total?: number;
  totalResources: number;
  byTag?: Record<string, number>;
  byModule?: Record<string, number>;
  presetUsage?: Record<string, number>;
  totalRoutes?: number;
  totalEvents?: number;
}

export interface IntrospectionData {
  resources: ResourceMetadata[];
  stats: RegistryStats;
  generatedAt?: string;
}

export interface EventDefinition {
  name: string;
  /** Optional handler — events are published via fastify.events.publish(), not invoked through resource definitions */
  handler?: (data: unknown) => Promise<void> | void;
  schema?: Record<string, unknown>; // JSON schema for event payload
  description?: string; // Event documentation
}

// ============================================================================
// Validation Types
// ============================================================================

export interface ConfigError {
  field: string;
  message: string;
  code?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ConfigError[];
}

export interface ValidateOptions {
  strict?: boolean;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Infer document type from DataAdapter, Repository, or ResourceConfig.
 * Smart inference that works with multiple sources.
 *
 * @example
 * ```typescript
 * type Doc1 = InferDocType<typeof adapter>;     // From DataAdapter
 * type Doc2 = InferDocType<typeof repository>;  // From Repository
 * type Doc3 = InferDocType<typeof resource>;    // From ResourceConfig
 * ```
 */
import type { CrudRepository } from './repository.js';

/**
 * Infer document type from DataAdapter or ResourceConfig
 */
export type InferDocType<T> =
  T extends DataAdapter<infer D>
    ? D
    : T extends ResourceConfig<infer D>
      ? D
      : never;

/**
 * Infer document type from a DataAdapter.
 * Falls back to `unknown` (not `never`) — safe for generic constraints.
 *
 * @example
 * ```typescript
 * const adapter = createMongooseAdapter({ model: ProductModel, repository: productRepo });
 * type ProductDoc = InferAdapterDoc<typeof adapter>;
 * // ProductDoc = the document type inferred from the adapter
 * ```
 */
export type InferAdapterDoc<A> = A extends DataAdapter<infer D> ? D : unknown;

export type InferResourceDoc<T> = T extends ResourceConfig<infer D> ? D : never;
export type TypedResourceConfig<TDoc> = ResourceConfig<TDoc>;
export type TypedController<TDoc> = IController<TDoc>;
export type TypedRepository<TDoc> = CrudRepository<TDoc>;

// ============================================================================
// Base Controller Options (canonical definition in core/BaseController.ts)
// ============================================================================

export type { BaseControllerOptions } from '../core/BaseController.js';

// v2.8 route + action types
export type { RouteDefinition, RouteMcpConfig, ActionHandlerFn, ActionDefinition, ActionEntry, ActionsMap };
