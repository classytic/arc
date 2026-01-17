/**
 * Types for createApp factory
 */

import type { FastifyServerOptions } from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';
import type { FastifyHelmetOptions } from '@fastify/helmet';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { AuthPluginOptions } from '../types/index.js';

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
  // Authentication
  // ============================================

  /** JWT secret for Arc auth (required when Arc auth is enabled) */
  jwtSecret?: string;

  /** JWT expiration time (e.g., '7d', '24h') */
  jwtExpiresIn?: string;

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
    requestId?: boolean;
    health?: boolean;
    gracefulShutdown?: boolean;
  };

  /** Custom plugin registration function */
  plugins?: (fastify: any) => Promise<void>;

  /** Auth configuration (Arc auth or custom auth plugin) */
  auth?: false | {
    plugin?: (fastify: any) => Promise<void>;
    options?: AuthPluginOptions;
  };
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
