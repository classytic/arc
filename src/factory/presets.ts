/**
 * Environment Presets for createApp
 *
 * Provides sensible defaults for different environments:
 * - production: Strict security, performance optimized
 * - development: Relaxed CORS, verbose logging
 * - testing: In-memory DB, no rate limiting
 */

import type { CreateAppOptions } from "./types.js";

/**
 * Production preset - strict security, performance optimized
 */
export const productionPreset: Partial<CreateAppOptions> = {
  // Raw JSON logs for production (log aggregators like Datadog, CloudWatch, etc.)
  logger: {
    level: "info",
    // Redact sensitive data from logs to prevent credential leaks
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["set-cookie"]',
        "*.password",
        "*.secret",
        "*.token",
        "*.accessToken",
        "*.refreshToken",
        "*.creditCard",
      ],
      censor: "[REDACTED]",
    },
  },
  trustProxy: true,

  // Security
  helmet: {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
  },

  // CORS - must be explicitly configured
  cors: {
    origin: false, // Disabled by default in production
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "x-organization-id",
      "x-request-id",
    ],
  },

  // Rate limiting - strict
  rateLimit: {
    max: 100,
    timeWindow: "1 minute",
  },

  // Note: Compression not included (use proxy/CDN instead)

  // Under pressure - health monitoring
  // Note: maxEventLoopDelay is intentionally generous (3s) to avoid false 503s
  // on containerized platforms (Render, Railway, Fly.io) where event loop spikes
  // are common during cold starts and behind Cloudflare/proxy health checks.
  // Override to tighten: underPressure: { maxEventLoopDelay: 500 }
  underPressure: {
    exposeStatusRoute: true,
    maxEventLoopDelay: 3000,
    maxHeapUsedBytes: 1024 * 1024 * 1024, // 1GB
    maxRssBytes: 1024 * 1024 * 1024, // 1GB
  },
};

/**
 * Development preset - relaxed security, verbose logging
 */
export const developmentPreset: Partial<CreateAppOptions> = {
  logger: {
    level: "debug",
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  },
  trustProxy: true,

  // Security - relaxed for development
  helmet: {
    contentSecurityPolicy: false, // Disable CSP in dev
  },

  // CORS - allow all origins in development
  cors: {
    origin: true, // Allow all origins (reflects request Origin for credentials)
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "x-organization-id",
      "x-request-id",
    ],
  },

  // Rate limiting - very relaxed
  rateLimit: {
    max: 1000,
    timeWindow: "1 minute",
  },

  // Note: Compression not included (use proxy/CDN instead)

  // Under pressure - relaxed
  underPressure: {
    exposeStatusRoute: true,
    maxEventLoopDelay: 5000,
  },
};

/**
 * Testing preset - minimal setup, fast startup
 */
export const testingPreset: Partial<CreateAppOptions> = {
  logger: false, // Disable logging in tests
  trustProxy: false,

  // Security - disabled for tests
  helmet: false,
  cors: false,
  rateLimit: false,
  underPressure: false,

  // Sensible plugins still enabled
  sensible: true,
  multipart: {
    limits: {
      fileSize: 1024 * 1024, // 1MB
      files: 5,
    },
  },
};

/**
 * Edge/Serverless preset — minimal cold-start overhead
 *
 * Strips non-essential plugins to reduce startup time. Designed for:
 * - Cloudflare Workers (requires `nodejs_compat` flag + `toFetchHandler()`)
 * - AWS Lambda via `@fastify/aws-lambda` or `toFetchHandler()`
 * - Vercel Serverless Functions (Node.js runtime)
 * - Google Cloud Functions (Node.js runtime)
 * - Any environment where the platform handles security, rate limiting, and health checks
 *
 * Use with `toFetchHandler()` from `@classytic/arc/factory` for edge runtimes:
 * ```typescript
 * import { createApp, toFetchHandler } from '@classytic/arc/factory';
 * const app = await createApp({ preset: 'edge' });
 * export default { fetch: toFetchHandler(app) };
 * ```
 *
 * **Edge runtime requirements:**
 * - Cloudflare Workers: enable `nodejs_compat` in wrangler.toml
 * - Vercel: use Node.js runtime (not Edge Runtime) or enable nodejs compat
 *
 * Arc uses `node:crypto` and `AsyncLocalStorage` — both supported by
 * modern edge runtimes with Node.js compat flags. No TCP server is needed
 * when using `toFetchHandler()` (routes through Fastify's `.inject()`).
 */
export const edgePreset: Partial<CreateAppOptions> = {
  logger: {
    level: "warn", // Minimal logging to reduce I/O overhead
  },
  trustProxy: true, // Always behind API Gateway / CDN

  // Security — handled by API Gateway / CDN layer
  helmet: false,
  cors: false,
  rateLimit: false,

  // Performance — not needed in serverless
  underPressure: false,

  // Utilities — minimal footprint
  sensible: true,
  multipart: false, // Use pre-signed URLs for file uploads
  rawBody: false, // Register per-route if needed for webhooks

  // Arc plugins — serverless runtime handles lifecycle
  arcPlugins: {
    requestId: false, // API Gateway provides request IDs
    health: false, // Lambda has its own health checks
    gracefulShutdown: false, // Runtime manages shutdown
    emitEvents: true, // Keep events for business logic
  },
};

/**
 * Get preset by name
 */
export function getPreset(
  name: "production" | "development" | "testing" | "edge",
): Partial<CreateAppOptions> {
  switch (name) {
    case "production":
      return productionPreset;
    case "development":
      return developmentPreset;
    case "testing":
      return testingPreset;
    case "edge":
      return edgePreset;
    default:
      throw new Error(`Unknown preset: ${name}`);
  }
}
