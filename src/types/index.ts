/**
 * Arc Framework Types
 *
 * Clean, type-safe interfaces for the Arc framework.
 * Modern TypeScript patterns - no `any`, proper generics.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { Types } from 'mongoose';
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
    /** Current user — set by auth adapter (Better Auth, JWT, custom) */
    user: Record<string, unknown>;

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

// Re-export from dedicated type modules
export type {
  CrudRepository,
  PaginatedResult,
  QueryOptions,
  PaginationParams,
  InferDoc,
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
export type ObjectId = Types.ObjectId | string;

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
  additionalRoutes?: AdditionalRoute[];
  disableCrud?: boolean;
  disableDefaultRoutes?: boolean;
  disabledRoutes?: CrudRouteKey[]; // Specific routes to disable
  /**
   * Field name used for multi-tenant scoping (default: 'organizationId').
   * Override to match your schema: 'workspaceId', 'tenantId', 'teamId', etc.
   * Takes effect when org context is present (via multiTenant preset).
   */
  tenantField?: string;
  /**
   * Primary key field name (default: '_id').
   * Override for non-MongoDB adapters (e.g., 'id' for SQL databases).
   */
  idField?: string;
  module?: string; // For grouping in registry
  events?: Record<string, EventDefinition>; // Domain events
  skipValidation?: boolean; // Skip schema validation
  skipRegistry?: boolean; // Don't register in introspection
  _appliedPresets?: string[]; // Internal: track applied presets
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

export interface ResourceHooks {
  beforeCreate?: (data: AnyRecord) => Promise<AnyRecord> | AnyRecord;
  afterCreate?: (doc: AnyRecord) => Promise<void> | void;
  beforeUpdate?: (id: string, data: AnyRecord) => Promise<AnyRecord> | AnyRecord;
  afterUpdate?: (doc: AnyRecord) => Promise<void> | void;
  beforeDelete?: (id: string) => Promise<void> | void;
  afterDelete?: (id: string) => Promise<void> | void;
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
   * Handler - string (controller method name) or function
   * Function can be Fastify handler or (request, reply) => Promise<unknown>
   */
  handler: string | RouteHandlerMethod | ((request: FastifyRequest, reply: FastifyReply) => unknown);

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

  /** Fastify route schema */
  schema?: Record<string, unknown>;
}

export interface RouteSchemaOptions {
  hiddenFields?: string[];
  readonlyFields?: string[];
  requiredFields?: string[];
  optionalFields?: string[];
  excludeFields?: string[];
  fieldRules?: Record<string, { systemManaged?: boolean; [key: string]: unknown }>;
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
 * @example
 * {
 *   list: {
 *     querystring: { type: 'object', properties: { page: { type: 'number' } } },
 *     response: { 200: { type: 'object', properties: { docs: { type: 'array' } } } }
 *   },
 *   create: {
 *     body: { type: 'object', properties: { name: { type: 'string' } } },
 *     response: { 201: { type: 'object' } }
 *   }
 * }
 */
export interface CrudSchemas {
  /** GET / - List all resources */
  list?: {
    querystring?: Record<string, unknown>;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };

  /** GET /:id - Get single resource */
  get?: {
    params?: Record<string, unknown>;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };

  /** POST / - Create resource */
  create?: {
    body?: Record<string, unknown>;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };

  /** PATCH /:id - Update resource */
  update?: {
    params?: Record<string, unknown>;
    body?: Record<string, unknown>;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };

  /** DELETE /:id - Delete resource */
  delete?: {
    params?: Record<string, unknown>;
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
 *   roles: user.roles,
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
  additionalRoutes?: AdditionalRoute[] | ((permissions: ResourcePermissions) => AdditionalRoute[]);
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
  additionalRoutes?: AdditionalRoute[];
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
  handler: (data: unknown) => Promise<void> | void;
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
