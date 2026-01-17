/**
 * Environment Presets for createApp
 *
 * Provides sensible defaults for different environments:
 * - production: Strict security, performance optimized
 * - development: Relaxed CORS, verbose logging
 * - testing: In-memory DB, no rate limiting
 */

import type { CreateAppOptions } from './types.js';

/**
 * Production preset - strict security, performance optimized
 */
export const productionPreset: Partial<CreateAppOptions> = {
  // Raw JSON logs for production (log aggregators like Datadog, CloudWatch, etc.)
  logger: {
    level: 'info',
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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  },

  // Rate limiting - strict
  rateLimit: {
    max: 100,
    timeWindow: '1 minute',
  },

  // Note: Compression not included (use proxy/CDN instead)

  // Under pressure - health monitoring
  underPressure: {
    exposeStatusRoute: true,
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 1024 * 1024 * 1024, // 1GB
    maxRssBytes: 1024 * 1024 * 1024, // 1GB
  },
};

/**
 * Development preset - relaxed security, verbose logging
 */
export const developmentPreset: Partial<CreateAppOptions> = {
  logger: {
    level: 'debug',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
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
    origin: true, // Allow all origins
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  },

  // Rate limiting - very relaxed
  rateLimit: {
    max: 1000,
    timeWindow: '1 minute',
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
 * Get preset by name
 */
export function getPreset(name: 'production' | 'development' | 'testing'): Partial<CreateAppOptions> {
  switch (name) {
    case 'production':
      return productionPreset;
    case 'development':
      return developmentPreset;
    case 'testing':
      return testingPreset;
    default:
      throw new Error(`Unknown preset: ${name}`);
  }
}
