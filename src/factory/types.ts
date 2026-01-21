/**
 * Types for createApp factory
 */

import type { FastifyServerOptions } from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';
import type { FastifyHelmetOptions } from '@fastify/helmet';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { AuthPluginOptions } from '../types/index.js';

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

  /** Environment preset: 'production', 'development', or 'testing' */
  preset?: 'production' | 'development' | 'testing';

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
   * Provide AuthPluginOptions for full control.
   *
   * @example
   * ```typescript
   * // Disable auth
   * auth: false,
   *
   * // Simple JWT (uses default jwtVerify)
   * auth: {
   *   jwt: { secret: process.env.JWT_SECRET },
   * },
   *
   * // Custom authenticator
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
   * // Completely custom auth plugin
   * auth: {
   *   plugin: async (fastify) => {
   *     // Your custom auth setup
   *   },
   * },
   * ```
   */
  auth?: false | AuthPluginOptions | {
    /** Replace Arc auth with your own plugin */
    plugin?: (fastify: any) => Promise<void>;
  };

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

  /** Enable Arc plugins (requestId, health, gracefulShutdown) */
  arcPlugins?: {
    /** Request ID tracking (default: true) */
    requestId?: boolean;
    /** Health endpoints (default: true) */
    health?: boolean;
    /** Graceful shutdown handling (default: true) */
    gracefulShutdown?: boolean;
    /** Emit events for CRUD operations (default: true) */
    emitEvents?: boolean;
  };

  /** Custom plugin registration function */
  plugins?: (fastify: any) => Promise<void>;
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
