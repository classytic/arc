/**
 * Types for createApp factory
 */

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
} from "fastify";

// These types are inlined to avoid forcing consumers to install optional peer deps.
// @fastify/cors, @fastify/helmet, @fastify/rate-limit are optional — their types
// should not leak into our declaration files.
type CorsOptions = Record<string, unknown> & {
  origin?: unknown;
  credentials?: boolean;
  methods?: string[];
  allowedHeaders?: string[];
};
type HelmetOptions = Record<string, unknown>;
type RateLimitOpts = Record<string, unknown> & { max?: number; timeWindow?: string | number };

import type { CacheStore } from "../cache/interface.js";
import type { ExternalOpenApiPaths } from "../docs/externalPaths.js";
import type { EventTransport } from "../events/EventTransport.js";
import type { IdempotencyStore } from "../idempotency/stores/interface.js";
import type { ElevationOptions } from "../scope/elevation.js";
import type { Authenticator } from "../types/index.js";

// ============================================================================
// Auth Strategy Types (Discriminated Union with `type` field)
// ============================================================================

/**
 * Arc's built-in JWT auth
 *
 * Registers @fastify/jwt, wires up `fastify.authenticate`, and
 * exposes `fastify.auth` helpers (issueTokens, verifyRefreshToken).
 *
 * @example
 * ```typescript
 * const app = await createApp({
 *   auth: {
 *     type: 'jwt',
 *     jwt: { secret: process.env.JWT_SECRET },
 *   },
 * });
 *
 * // With custom authenticator
 * const app = await createApp({
 *   auth: {
 *     type: 'jwt',
 *     jwt: { secret: process.env.JWT_SECRET },
 *     authenticate: async (request, { jwt }) => {
 *       const token = request.headers.authorization?.split(' ')[1];
 *       if (!token) return null;
 *       const decoded = jwt.verify(token);
 *       return userRepo.findById(decoded.id);
 *     },
 *   },
 * });
 * ```
 */
export interface JwtAuthOption {
  type: "jwt";

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
  onFailure?: (request: FastifyRequest, reply: FastifyReply, error?: Error) => void | Promise<void>;

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
   * Token revocation check — called after JWT verification.
   * Return `true` to reject the token (fail-closed: errors also reject).
   *
   * @example
   * ```typescript
   * isRevoked: async (decoded) => {
   *   return revokedTokens.has(decoded.jti as string);
   * },
   * ```
   */
  isRevoked?: (decoded: Record<string, unknown>) => boolean | Promise<boolean>;
}

/**
 * Better Auth adapter integration
 *
 * When provided, Arc registers the Better Auth plugin (which sets up
 * auth routes and decorates fastify.authenticate) and skips Arc's
 * built-in JWT auth setup entirely.
 *
 * @example
 * ```typescript
 * import { createBetterAuthAdapter } from '@classytic/arc-better-auth';
 *
 * const app = await createApp({
 *   auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth: myBetterAuth }) },
 * });
 * ```
 */
export interface BetterAuthOption {
  type: "betterAuth";
  /** Better Auth adapter — pass the result of createBetterAuthAdapter() */
  betterAuth: { plugin: FastifyPluginAsync; openapi?: ExternalOpenApiPaths };
}

/**
 * Custom auth plugin — full control over authentication setup
 *
 * The plugin is registered directly on the Fastify instance.
 * It must decorate `fastify.authenticate` for protected routes to work.
 *
 * @example
 * ```typescript
 * const app = await createApp({
 *   auth: {
 *     type: 'custom',
 *     plugin: async (fastify) => {
 *       fastify.decorate('authenticate', async (request, reply) => { ... });
 *     },
 *   },
 * });
 * ```
 */
export interface CustomPluginAuthOption {
  type: "custom";
  /** Custom Fastify plugin that sets up authentication */
  plugin: FastifyPluginAsync;
}

/**
 * Custom authenticator function — lightweight alternative to a full plugin
 *
 * Arc decorates `fastify.authenticate` with this function directly.
 * No JWT setup, no Arc auth plugin — just your function.
 *
 * @example
 * ```typescript
 * const app = await createApp({
 *   auth: {
 *     type: 'authenticator',
 *     authenticate: async (request, reply) => {
 *       const session = await validateSession(request);
 *       if (!session) reply.code(401).send({ error: 'Unauthorized' });
 *       request.user = session.user;
 *     },
 *   },
 * });
 * ```
 */
export interface CustomAuthenticatorOption {
  type: "authenticator";
  /** Authenticate function — decorates fastify.authenticate directly */
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /**
   * Optional authenticate function for public routes.
   * If not provided, Arc auto-generates one by wrapping `authenticate` and
   * intercepting 401/403 responses so unauthenticated requests proceed as public.
   * Provide this if your authenticator has side effects that shouldn't run on public routes.
   */
  optionalAuthenticate?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * All supported auth configuration shapes
 *
 * - `false` — Disable authentication entirely
 * - `JwtAuthOption` — Arc's built-in JWT auth (`type: 'jwt'`)
 * - `BetterAuthOption` — Better Auth adapter integration (`type: 'betterAuth'`)
 * - `CustomPluginAuthOption` — Your own Fastify auth plugin (`type: 'custom'`)
 * - `CustomAuthenticatorOption` — A bare authenticate function (`type: 'authenticator'`)
 */
export type AuthOption =
  | false
  | JwtAuthOption
  | BetterAuthOption
  | CustomPluginAuthOption
  | CustomAuthenticatorOption;

/**
 * CreateApp Options
 *
 * Configuration for creating an Arc application.
 *
 * @example
 * ```typescript
 * // Minimal setup
 * const app = await createApp({
 *   preset: 'development',
 *   auth: {
 *     type: 'jwt',
 *     jwt: { secret: process.env.JWT_SECRET },
 *   },
 * });
 *
 * // With custom authenticator
 * const app = await createApp({
 *   preset: 'production',
 *   auth: {
 *     type: 'jwt',
 *     jwt: { secret: process.env.JWT_SECRET },
 *     authenticate: async (request, { jwt }) => {
 *       // Check API key first
 *       const apiKey = request.headers['x-api-key'];
 *       if (apiKey) {
 *         const result = await apiKeyService.verify(apiKey);
 *         if (result) return { _id: result.userId, isApiKey: true };
 *       }
 *       // Then check JWT
 *       const token = request.headers.authorization?.split(' ')[1];
 *       if (token) {
 *         const decoded = jwt.verify(token);
 *         return userRepo.findById(decoded.id);
 *       }
 *       return null;
 *     },
 *   },
 * });
 * ```
 */
export interface CreateAppOptions {
  // ============================================
  // Environment & Logging
  // ============================================

  /** Environment preset: 'production', 'development', 'testing', or 'edge' */
  preset?: "production" | "development" | "testing" | "edge";

  /**
   * Runtime profile for store backends.
   * - 'memory' (default): Uses in-memory stores. Suitable for single-instance deployments.
   * - 'distributed': Requires durable adapters for events, and for any enabled
   *   shared subsystems such as caching/queryCache/rate limiting.
   *   Idempotency remains per-resource opt-in: memory-backed stores are rejected,
   *   while a missing idempotency store emits a startup warning because dedupe
   *   would be instance-local.
   */
  runtime?: "memory" | "distributed";

  /**
   * Store and transport instances for runtime profile validation.
   * When `runtime` is `'distributed'`, Arc validates that these are
   * not memory-backed. Provide Redis or other durable adapters.
   */
  stores?: {
    /** Event transport (e.g., RedisEventTransport) */
    events?: EventTransport;
    /** Cache store (e.g., RedisCacheStore) */
    cache?: CacheStore;
    /** Idempotency store (e.g., RedisIdempotencyStore) */
    idempotency?: IdempotencyStore;
    /** QueryCache store (e.g., RedisCacheStore). Default: MemoryCacheStore. */
    queryCache?: CacheStore;
  };

  /** Fastify logger configuration */
  logger?: FastifyServerOptions["logger"];

  /**
   * Enable Arc debug logging.
   *
   * - `true` — all Arc modules
   * - `string` — comma-separated module names (e.g., `'scope,elevation,sse'`)
   * - `false` or omit — disabled (default)
   *
   * Also configurable via `ARC_DEBUG` environment variable.
   *
   * @example
   * ```typescript
   * // All modules
   * const app = await createApp({ debug: true });
   *
   * // Specific modules
   * const app = await createApp({ debug: 'scope,elevation' });
   * ```
   */
  debug?: boolean | string;

  /** Trust proxy headers (X-Forwarded-For, etc.) */
  trustProxy?: boolean;

  // ============================================
  // Authentication (New Clean API)
  // ============================================

  /**
   * Auth configuration
   *
   * Set to false to disable authentication entirely.
   * Each auth strategy requires a `type` discriminant field.
   *
   * @example
   * ```typescript
   * // Disable auth
   * auth: false,
   *
   * // Arc JWT
   * auth: {
   *   type: 'jwt',
   *   jwt: { secret: process.env.JWT_SECRET },
   * },
   *
   * // Arc JWT + custom authenticator
   * auth: {
   *   type: 'jwt',
   *   jwt: { secret: process.env.JWT_SECRET },
   *   authenticate: async (request, { jwt }) => {
   *     const token = request.headers.authorization?.split(' ')[1];
   *     if (!token) return null;
   *     const decoded = jwt.verify(token);
   *     return userRepo.findById(decoded.id);
   *   },
   * },
   *
   * // Better Auth adapter
   * auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth: myBetterAuth }) },
   *
   * // Custom auth plugin
   * auth: {
   *   type: 'custom',
   *   plugin: async (fastify) => {
   *     fastify.decorate('authenticate', async (req, reply) => { ... });
   *   },
   * },
   *
   * // Custom authenticator function
   * auth: {
   *   type: 'authenticator',
   *   authenticate: async (request, reply) => {
   *     const session = await validateSession(request);
   *     if (!session) reply.code(401).send({ error: 'Unauthorized' });
   *     request.user = session.user;
   *   },
   * },
   * ```
   */
  auth?: AuthOption;

  // ============================================
  // Elevation (opt-in)
  // ============================================

  /**
   * Platform admin elevation — opt-in for apps with superadmins.
   *
   * When configured, platform admins can explicitly elevate their scope
   * by sending `x-arc-scope: platform` header. Without this header,
   * superadmins are treated as normal users.
   *
   * Set to `false` or omit to disable elevation entirely.
   *
   * @example
   * ```typescript
   * elevation: {
   *   platformRoles: ['superadmin'],
   *   onElevation: (event) => auditLog.write({
   *     action: 'platform_elevation',
   *     userId: event.userId,
   *     targetOrg: event.organizationId,
   *   }),
   * }
   * ```
   */
  elevation?: ElevationOptions | false;

  // ============================================
  // Security Plugins (opt-out)
  // ============================================

  /** Helmet security headers. Set to false to disable. */
  helmet?: HelmetOptions | false;

  /** CORS configuration. Set to false to disable. */
  cors?: CorsOptions | false;

  /** Rate limiting. Set to false to disable. */
  rateLimit?: RateLimitOpts | false;

  // ============================================
  // Performance Plugins (opt-out)
  // ============================================

  // Note: Compression is not included due to known Fastify 5 issues.
  // Use a reverse proxy (Nginx, Caddy) or CDN for response compression.

  /** Under pressure health monitoring. Set to false to disable. */
  underPressure?: UnderPressureOptions | false;

  // ============================================
  // Utilities (opt-out)
  // ============================================

  /** @fastify/sensible (HTTP helpers). Set to false to disable. */
  sensible?: boolean | false;

  /** @fastify/multipart (file uploads). Set to false to disable. */
  multipart?: MultipartOptions | false;

  /** Raw body parsing (for webhooks). Set to false to disable. */
  rawBody?: RawBodyOptions | false;

  // ============================================
  // Arc-specific Options
  // ============================================

  /** Enable Arc plugins (requestId, health, gracefulShutdown, events, caching, sse) */
  arcPlugins?: {
    /** Request ID tracking (default: true) */
    requestId?: boolean;
    /** Health endpoints (default: true) */
    health?: boolean;
    /** Graceful shutdown handling (default: true) */
    gracefulShutdown?: boolean;
    /** Emit events for CRUD operations (default: true) */
    emitEvents?: boolean;
    /**
     * Event plugin configuration. Default: true (enabled with MemoryEventTransport).
     * Set to false to disable event plugin registration entirely.
     * Set to true for defaults (memory transport), or pass EventPluginOptions for fine control.
     * Transport is sourced from `stores.events` if provided, otherwise defaults to memory.
     *
     * When enabled, registers `eventPlugin` which provides `fastify.events` for
     * pub/sub. Combined with `emitEvents: true`, CRUD operations automatically
     * emit domain events (e.g., `product.created`, `order.updated`).
     *
     * @example
     * ```typescript
     * // Memory transport (default)
     * const app = await createApp({ arcPlugins: { events: true } });
     *
     * // With retry and logging
     * const app = await createApp({
     *   stores: { events: new RedisEventTransport({ url: 'redis://...' }) },
     *   arcPlugins: {
     *     events: {
     *       logEvents: true,
     *       retry: { maxRetries: 3, backoffMs: 1000 },
     *     },
     *   },
     * });
     * ```
     */
    events?: Omit<import("../events/eventPlugin.js").EventPluginOptions, "transport"> | boolean;
    /**
     * Caching headers (ETag + Cache-Control). Default: false (opt-in).
     * Set to true for defaults, or pass CachingOptions for fine control.
     */
    caching?: import("../plugins/caching.js").CachingOptions | boolean;
    /**
     * SSE event streaming. Default: false (opt-in).
     * Set to true for defaults, or pass SSEOptions for fine control.
     * Requires emitEvents to be enabled (or events plugin registered).
     */
    sse?: import("../plugins/sse.js").SSEOptions | boolean;
    /**
     * QueryCache — TanStack Query-inspired server cache with SWR.
     * Default: false (opt-in). Set to true for memory store defaults.
     * Requires per-resource `cache` config on defineResource().
     */
    queryCache?: import("../cache/queryCachePlugin.js").QueryCachePluginOptions | boolean;
    /**
     * Metrics endpoint (Prometheus-compatible). Default: false (opt-in).
     * Set to true for defaults (/_metrics), or pass MetricsOptions for custom path/prefix.
     */
    metrics?: import("../plugins/metrics.js").MetricsOptions | boolean;
    /**
     * API versioning (header or prefix-based). Default: false (opt-in).
     * Pass VersioningOptions to enable.
     */
    versioning?: import("../plugins/versioning.js").VersioningOptions;
  };

  /**
   * Type provider for schema inference.
   *
   * When set to `'typebox'`, enables TypeBox type provider for
   * automatic TypeScript inference from route schemas.
   *
   * Requires `@sinclair/typebox` and `@fastify/type-provider-typebox` installed.
   *
   * @example
   * ```typescript
   * import { Type } from '@classytic/arc/schemas';
   *
   * const app = await createApp({
   *   typeProvider: 'typebox',
   * });
   *
   * // Now route schemas built with Type.* give full TS inference
   * ```
   */
  typeProvider?: "typebox";

  /**
   * Error handler plugin. Normalizes AJV, Mongoose, and ArcError responses
   * into a consistent JSON envelope. Enabled by default.
   * Set to false to disable, or pass ErrorHandlerOptions for fine control.
   */
  errorHandler?: import("../plugins/errorHandler.js").ErrorHandlerOptions | false;

  /**
   * Custom AJV keywords to allow in route schemas.
   *
   * Arc already allows `"example"` by default. Use this to add
   * additional non-standard keywords your query parsers or schema
   * generators may use (e.g., `x-internal` from MongoKit).
   *
   * @example
   * ```typescript
   * const app = await createApp({
   *   ajv: { keywords: ['x-internal'] },
   * });
   * ```
   */
  ajv?: {
    keywords?: string[];
  };

  /**
   * Enable `reply.ok()`, `reply.fail()`, `reply.paginated()` response helpers.
   *
   * Default: `false` (opt-in).
   *
   * @example
   * ```typescript
   * const app = await createApp({ replyHelpers: true });
   *
   * // Then in any handler:
   * return reply.ok({ name: 'MacBook' });          // → 200 { success: true, data: { ... } }
   * return reply.ok(product, 201);                  // → 201 { success: true, data: { ... } }
   * return reply.fail('Not found', 404);            // → 404 { success: false, error: '...' }
   * return reply.fail(['err1', 'err2'], 422);       // → 422 { success: false, errors: [...] }
   * return reply.paginated({ docs, total, page, limit });
   * ```
   */
  replyHelpers?: boolean;

  /**
   * Auto-convert BigInt values to Number in all JSON responses.
   *
   * When `true`, Arc adds a `preSerialization` hook that converts BigInt values
   * to Number before JSON serialization. Without this, `JSON.stringify` throws
   * on BigInt values (e.g., from financial libraries like fin-io).
   *
   * Default: `false` (opt-in — most apps don't use BigInt).
   *
   * @example
   * ```typescript
   * const app = await createApp({
   *   serializeBigInt: true,
   * });
   * ```
   */
  serializeBigInt?: boolean;

  // ============================================
  // Resources & Lifecycle
  // ============================================

  /**
   * Resources to register automatically.
   * Each resource's `.toPlugin()` is called and registered for you.
   *
   * @example
   * ```ts
   * const app = await createApp({
   *   resources: [productResource, orderResource, userResource],
   *   auth: { type: 'jwt', jwt: { secret: 'xxx' } },
   * });
   * ```
   */
  resources?: Array<import("./loadResources.js").ResourceLike>;

  /**
   * URL prefix for all auto-registered resources.
   * Applied only to resources in the `resources` array — not to `plugins()`.
   *
   * @example
   * ```ts
   * const app = await createApp({
   *   resourcePrefix: '/api/v1',
   *   resources: await loadResources(import.meta.url),
   * });
   * // product → /api/v1/products, order → /api/v1/orders
   * ```
   */
  resourcePrefix?: string;

  /**
   * Custom plugin registration — runs after Arc core (security, auth, events)
   * but before `bootstrap` and `resources`.
   *
   * Use this for infrastructure setup: database connections, OpenAPI docs,
   * webhook plugins, SSE wiring, etc.
   */
  plugins?: (fastify: FastifyInstance) => Promise<void>;

  /**
   * Bootstrap functions — run after `plugins()` but before `resources`.
   *
   * Use this for domain initialization that needs infrastructure ready
   * (DB connected, events wired, Redis available) but must complete
   * before resources register (e.g., engine singletons, event handlers,
   * seed data, connection verification).
   *
   * Boot order:
   * ```
   * 1. Arc core (security, auth, events)
   * 2. plugins()      ← infra (DB, SSE, docs)
   * 3. bootstrap[]    ← domain init (singletons, event handlers)
   * 4. resources[]    ← auto-discovered routes
   * ```
   *
   * @example
   * ```ts
   * const app = await createApp({
   *   plugins: async (f) => { await connectDB(); await f.register(docsPlugin); },
   *   bootstrap: [inventoryInit, accountingInit, loyaltyInit],
   *   resources: await loadResources(import.meta.url),
   * });
   * ```
   */
  bootstrap?: Array<(fastify: FastifyInstance) => void | Promise<void>>;

  /**
   * Hook called after resources are registered but before the app is ready.
   * Use for post-registration wiring (e.g., cross-resource event subscriptions).
   */
  afterResources?: (fastify: FastifyInstance) => void | Promise<void>;

  /** Hook called after all plugins are loaded and the app is ready */
  onReady?: (fastify: FastifyInstance) => void | Promise<void>;

  /** Hook called when the app is shutting down */
  onClose?: (fastify: FastifyInstance) => void | Promise<void>;
}

// Plugin-specific options

export interface UnderPressureOptions {
  /** Expose `/_status` route for health checks (default: false) */
  exposeStatusRoute?: boolean;
  /** Event loop lag threshold in ms — requests rejected above this (default: 1000) */
  maxEventLoopDelay?: number;
  /** V8 heap usage threshold in bytes — requests rejected above this */
  maxHeapUsedBytes?: number;
  /** RSS memory threshold in bytes — requests rejected above this */
  maxRssBytes?: number;
}

export interface MultipartOptions {
  limits?: {
    /** Max file size in bytes (default: Fastify default ~1MB) */
    fileSize?: number;
    /** Max number of files per request */
    files?: number;
  };
}

export interface RawBodyOptions {
  /** Body field name to store raw body on (default: 'rawBody') */
  field?: string;
  /** Apply to all routes globally (default: false) */
  global?: boolean;
  /** Encoding for raw body string (default: 'utf8') */
  encoding?: string;
  /** Parse raw body before other parsers (default: false) */
  runFirst?: boolean;
}
