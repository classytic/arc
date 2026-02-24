/**
 * Types for createApp factory
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';
import type { FastifyHelmetOptions } from '@fastify/helmet';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { AuthPluginOptions } from '../types/index.js';
import type { ExternalOpenApiPaths } from '../docs/externalPaths.js';

// ============================================================================
// Auth Strategy Types (Discriminated Union)
// ============================================================================

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
 *   auth: { betterAuth: createBetterAuthAdapter({ auth: myBetterAuth }) },
 * });
 * ```
 */
export interface BetterAuthOption {
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
 *     plugin: async (fastify) => {
 *       fastify.decorate('authenticate', async (request, reply) => { ... });
 *     },
 *   },
 * });
 * ```
 */
export interface CustomPluginAuthOption {
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
  /** Authenticate function — decorates fastify.authenticate directly */
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * All supported auth configuration shapes
 *
 * - `false` — Disable authentication entirely
 * - `AuthPluginOptions` — Arc's built-in JWT auth (existing behavior)
 * - `BetterAuthOption` — Better Auth adapter integration
 * - `CustomPluginAuthOption` — Your own Fastify auth plugin
 * - `CustomAuthenticatorOption` — A bare authenticate function
 */
export type AuthOption =
  | false
  | AuthPluginOptions
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
 *     jwt: { secret: process.env.JWT_SECRET },
 *   },
 * });
 *
 * // With custom authenticator
 * const app = await createApp({
 *   preset: 'production',
 *   auth: {
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
  preset?: 'production' | 'development' | 'testing' | 'edge';

  /** Fastify logger configuration */
  logger?: FastifyServerOptions['logger'];

  /** Trust proxy headers (X-Forwarded-For, etc.) */
  trustProxy?: boolean;

  // ============================================
  // Authentication (New Clean API)
  // ============================================

  /**
   * Auth configuration
   *
   * Set to false to disable authentication entirely.
   * Provide AuthPluginOptions for Arc's built-in JWT auth.
   * Or use one of the alternative auth strategies.
   *
   * @example
   * ```typescript
   * // Disable auth
   * auth: false,
   *
   * // Arc JWT (existing behavior)
   * auth: {
   *   jwt: { secret: process.env.JWT_SECRET },
   * },
   *
   * // Arc JWT + custom authenticator
   * auth: {
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
   * auth: { betterAuth: createBetterAuthAdapter({ auth: myBetterAuth }) },
   *
   * // Custom auth plugin
   * auth: {
   *   plugin: async (fastify) => {
   *     fastify.decorate('authenticate', async (req, reply) => { ... });
   *   },
   * },
   *
   * // Custom authenticator function
   * auth: {
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
  // Security Plugins (opt-out)
  // ============================================

  /** Helmet security headers. Set to false to disable. */
  helmet?: FastifyHelmetOptions | false;

  /** CORS configuration. Set to false to disable. */
  cors?: FastifyCorsOptions | false;

  /** Rate limiting. Set to false to disable. */
  rateLimit?: RateLimitOptions | false;

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

  /** Enable Arc plugins (requestId, health, gracefulShutdown, caching, sse) */
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
     * Caching headers (ETag + Cache-Control). Default: false (opt-in).
     * Set to true for defaults, or pass CachingOptions for fine control.
     */
    caching?: import('../plugins/caching.js').CachingOptions | boolean;
    /**
     * SSE event streaming. Default: false (opt-in).
     * Set to true for defaults, or pass SSEOptions for fine control.
     * Requires emitEvents to be enabled (or events plugin registered).
     */
    sse?: import('../plugins/sse.js').SSEOptions | boolean;
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
  typeProvider?: 'typebox';

  /** Custom plugin registration function */
  plugins?: (fastify: FastifyInstance) => Promise<void>;
}

// Plugin-specific options

export interface UnderPressureOptions {
  exposeStatusRoute?: boolean;
  maxEventLoopDelay?: number;
  maxHeapUsedBytes?: number;
  maxRssBytes?: number;
}

export interface MultipartOptions {
  limits?: {
    fileSize?: number;
    files?: number;
  };
}

export interface RawBodyOptions {
  field?: string;
  global?: boolean;
  encoding?: string;
  runFirst?: boolean;
}
