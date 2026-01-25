/**
 * ArcFactory - Production-ready Fastify application factory
 *
 * Enforces security best practices by making plugins opt-out instead of opt-in.
 * A developer must explicitly disable security features rather than forget to enable them.
 *
 * Note: Arc is database-agnostic. Connect your database separately and provide
 * adapters when defining resources. This allows multiple databases, custom
 * connection pooling, and full control over your data layer.
 *
 * @example
 * // 1. Connect your database(s) separately
 * import mongoose from 'mongoose';
 * await mongoose.connect(process.env.MONGO_URI);
 *
 * // 2. Create Arc app (no database config needed)
 * const app = await createApp({
 *   preset: 'production',
 *   auth: { jwt: { secret: process.env.JWT_SECRET } },
 *   cors: { origin: ['https://example.com'] },
 * });
 *
 * // 3. Register resources with your adapters
 * await app.register(productResource.toPlugin());
 *
 * @example
 * // Multiple databases example
 * const primaryDb = await mongoose.connect(process.env.PRIMARY_DB);
 * const analyticsDb = mongoose.createConnection(process.env.ANALYTICS_DB);
 *
 * const orderResource = defineResource({
 *   adapter: createMongooseAdapter({ model: OrderModel, repository: orderRepo }),
 * });
 *
 * const analyticsResource = defineResource({
 *   adapter: createMongooseAdapter({ model: AnalyticsModel, repository: analyticsRepo }),
 * });
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { CreateAppOptions } from './types.js';
import { getPreset } from './presets.js';

// Plugin name to package name mapping
const PLUGIN_PACKAGES: Record<string, string> = {
  cors: '@fastify/cors',
  helmet: '@fastify/helmet',
  rateLimit: '@fastify/rate-limit',
  underPressure: '@fastify/under-pressure',
  sensible: '@fastify/sensible',
  multipart: '@fastify/multipart',
  rawBody: 'fastify-raw-body',
};

// Optional plugins that should not throw if missing
const OPTIONAL_PLUGINS = new Set(['multipart', 'rawBody']);

// Import plugins (with lazy loading for optional dependencies)
async function loadPlugin(name: string, logger?: { warn: (msg: string) => void }): Promise<any> {
  const packageName = PLUGIN_PACKAGES[name];
  if (!packageName) {
    throw new Error(`Unknown plugin: ${name}`);
  }

  try {
    switch (name) {
      case 'cors':
        return (await import('@fastify/cors')).default;
      case 'helmet':
        return (await import('@fastify/helmet')).default;
      case 'rateLimit':
        return (await import('@fastify/rate-limit')).default;
      case 'underPressure':
        return (await import('@fastify/under-pressure')).default;
      case 'sensible':
        return (await import('@fastify/sensible')).default;
      case 'multipart':
        return (await import('@fastify/multipart')).default;
      case 'rawBody':
        return (await import('fastify-raw-body')).default;
      default:
        throw new Error(`Unknown plugin: ${name}`);
    }
  } catch (error) {
    const err = error as Error;
    const isModuleNotFound = err.message.includes('Cannot find module') ||
      err.message.includes('Cannot find package') ||
      err.message.includes('MODULE_NOT_FOUND') ||
      err.message.includes('Could not resolve');

    // For optional plugins, return null instead of throwing
    if (isModuleNotFound && OPTIONAL_PLUGINS.has(name)) {
      logger?.warn(`ℹ️  Optional plugin '${name}' skipped (${packageName} not installed)`);
      return null;
    }

    // For required plugins, throw helpful error
    if (isModuleNotFound) {
      throw new Error(
        `Plugin '${name}' requires package '${packageName}' which is not installed.\n` +
        `Install it with: npm install ${packageName}\n` +
        `Or disable this plugin by setting ${name}: false in createApp options.`
      );
    }

    // Re-throw other errors
    throw new Error(`Failed to load plugin '${name}': ${err.message}`);
  }
}

/**
 * Create a production-ready Fastify application with Arc framework
 *
 * Security plugins are enabled by default (opt-out):
 * - helmet (security headers)
 * - cors (cross-origin requests)
 * - rateLimit (DDoS protection)
 * - underPressure (health monitoring)
 *
 * Note: Compression is not included due to known Fastify 5 issues.
 * Use a reverse proxy (Nginx, Caddy) or CDN for compression.
 *
 * @param options - Application configuration
 * @returns Configured Fastify instance
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  // ============================================
  // 1. VALIDATE AUTH OPTIONS
  // ============================================
  const authConfig = options.auth;
  const isAuthDisabled = authConfig === false;
  const hasCustomPlugin = typeof authConfig === 'object' && 'plugin' in authConfig && authConfig.plugin;
  const hasCustomAuthenticator = typeof authConfig === 'object' && 'authenticate' in authConfig;
  const jwtSecret = typeof authConfig === 'object' && 'jwt' in authConfig
    ? authConfig.jwt?.secret
    : undefined;

  // Validate: if Arc auth is enabled (not disabled, no custom plugin), need JWT secret or custom authenticator
  if (!isAuthDisabled && !hasCustomPlugin && !jwtSecret && !hasCustomAuthenticator) {
    throw new Error(
      'createApp: JWT secret required when Arc auth is enabled.\n' +
      'Provide auth.jwt.secret, auth.authenticate, or set auth: false to disable.\n' +
      'Example: auth: { jwt: { secret: process.env.JWT_SECRET } }'
    );
  }

  // ============================================
  // 2. MERGE WITH PRESET
  // ============================================
  const presetConfig = options.preset ? getPreset(options.preset) : {};
  const config = { ...presetConfig, ...options }; // User options override preset

  // ============================================
  // 3. CREATE FASTIFY INSTANCE
  // ============================================
  const fastify = Fastify({
    logger: config.logger ?? true,
    trustProxy: config.trustProxy ?? false,
    ajv: {
      customOptions: {
        coerceTypes: true,
        useDefaults: true,
        removeAdditional: false,
      },
    },
  });

  // ============================================
  // 4. REGISTER SECURITY PLUGINS (opt-out)
  // ============================================

  // Helmet - Security headers
  if (config.helmet !== false) {
    const helmet = await loadPlugin('helmet');
    // Use type assertion to handle complex helmet options
    await fastify.register(helmet, (config.helmet ?? {}) as Record<string, unknown>);
    fastify.log.info('✅ Helmet (security headers) enabled');
  } else {
    fastify.log.warn('⚠️  Helmet disabled - security headers not applied');
  }

  // CORS - Cross-origin requests
  if (config.cors !== false) {
    const cors = await loadPlugin('cors');
    const corsOptions = config.cors ?? {};

    // Require explicit origin in production
    if (config.preset === 'production' && (!corsOptions || !('origin' in corsOptions))) {
      throw new Error(
        'CORS origin must be explicitly configured in production.\n' +
        'Set cors.origin to allowed domains or set cors: false to disable.\n' +
        'Example: cors: { origin: [\'https://yourdomain.com\'] }\n' +
        'Docs: https://github.com/classytic/arc#security'
      );
    }

    await fastify.register(cors, corsOptions);
    fastify.log.info('✅ CORS enabled');
  } else {
    fastify.log.warn('⚠️  CORS disabled');
  }

  // Rate limiting - DDoS protection
  if (config.rateLimit !== false) {
    const rateLimit = await loadPlugin('rateLimit');
    await fastify.register(rateLimit, config.rateLimit ?? { max: 100, timeWindow: '1 minute' });
    fastify.log.info('✅ Rate limiting enabled');
  } else {
    fastify.log.warn('⚠️  Rate limiting disabled');
  }

  // ============================================
  // 5. REGISTER PERFORMANCE PLUGINS
  // ============================================

  // Note: Compression is NOT included due to known Fastify 5 stream issues.
  // Use a reverse proxy (Nginx, Caddy) or CDN for response compression.
  // See: https://github.com/fastify/fastify/issues/6017

  // Under Pressure - Health monitoring
  if (config.underPressure !== false) {
    const underPressure = await loadPlugin('underPressure');
    await fastify.register(underPressure, config.underPressure ?? { exposeStatusRoute: true });
    fastify.log.info('✅ Health monitoring (under-pressure) enabled');
  } else {
    fastify.log.info('ℹ️  Health monitoring disabled');
  }

  // ============================================
  // 6. REGISTER UTILITY PLUGINS (opt-out)
  // ============================================

  // Sensible - HTTP helpers
  if (config.sensible !== false) {
    const sensible = await loadPlugin('sensible');
    await fastify.register(sensible);
    fastify.log.info('✅ Sensible (HTTP helpers) enabled');
  }

  // Multipart - File uploads (optional)
  if (config.multipart !== false) {
    const multipart = await loadPlugin('multipart', fastify.log);
    if (multipart) {
      const multipartDefaults = {
        limits: {
          fileSize: 10 * 1024 * 1024, // 10MB
          files: 10,
        },
      };
      await fastify.register(multipart, { ...multipartDefaults, ...config.multipart });
      fastify.log.info('✅ Multipart (file uploads) enabled');
    }
  }

  // Raw body - For webhooks (optional)
  if (config.rawBody !== false) {
    const rawBody = await loadPlugin('rawBody', fastify.log);
    if (rawBody) {
      const rawBodyDefaults = {
        field: 'rawBody',
        global: false,
        encoding: 'utf8',
        runFirst: true,
      };
      await fastify.register(rawBody, { ...rawBodyDefaults, ...config.rawBody });
      fastify.log.info('✅ Raw body parsing enabled');
    }
  }

  // ============================================
  // 7. REGISTER ARC CORE (instance-scoped hooks & registry)
  // ============================================

  // Always register arc core first - provides fastify.arc with hooks & registry
  // This prevents global singleton leaks between app instances (e.g., in tests)
  const { arcCorePlugin } = await import('../plugins/index.js');
  await fastify.register(arcCorePlugin, {
    emitEvents: config.arcPlugins?.emitEvents !== false,
  });

  // ============================================
  // 8. REGISTER ARC PLUGINS (opt-in)
  // ============================================

  if (config.arcPlugins?.requestId !== false) {
    const { requestIdPlugin } = await import('../plugins/index.js');
    await fastify.register(requestIdPlugin);
    fastify.log.info('✅ Arc requestId plugin enabled');
  }

  if (config.arcPlugins?.health !== false) {
    const { healthPlugin } = await import('../plugins/index.js');
    await fastify.register(healthPlugin);
    fastify.log.info('✅ Arc health plugin enabled');
  }

  if (config.arcPlugins?.gracefulShutdown !== false) {
    const { gracefulShutdownPlugin } = await import('../plugins/index.js');
    await fastify.register(gracefulShutdownPlugin);
    fastify.log.info('✅ Arc gracefulShutdown plugin enabled');
  }

  // ============================================
  // 9. REGISTER AUTHENTICATION (Arc or custom)
  // ============================================

  if (!isAuthDisabled) {
    if (hasCustomPlugin) {
      // Custom auth plugin - user has full control
      const pluginFn = (authConfig as { plugin: (fastify: any) => Promise<void> }).plugin;
      await pluginFn(fastify);
      fastify.log.info('✅ Custom authentication plugin enabled');
    } else {
      // Arc auth plugin
      const { authPlugin } = await import('../auth/index.js');
      // Extract auth options, excluding the plugin property
      const { plugin: _, ...authOpts } = typeof authConfig === 'object' ? authConfig as Record<string, unknown> : {};

      await fastify.register(authPlugin, authOpts);
      fastify.log.info('✅ Arc authentication plugin enabled');
    }
  } else {
    fastify.log.info('ℹ️  Authentication disabled');
  }

  // ============================================
  // 10. REGISTER CUSTOM PLUGINS
  // ============================================

  if (config.plugins) {
    await config.plugins(fastify);
    fastify.log.info('✅ Custom plugins registered');
  }

  // ============================================
  // 11. LOG SUMMARY
  // ============================================

  fastify.log.info(
    `🚀 Arc application created successfully (preset: ${config.preset ?? 'custom'}, ` +
    `security: helmet=${config.helmet !== false}, cors=${config.cors !== false}, rateLimit=${config.rateLimit !== false})`
  );

  return fastify;
}

/**
 * Quick factory for common scenarios
 */
export const ArcFactory = {
  /**
   * Create production app with strict security
   */
  async production(options: Omit<CreateAppOptions, 'preset'>): Promise<FastifyInstance> {
    return createApp({ ...options, preset: 'production' });
  },

  /**
   * Create development app with relaxed security
   */
  async development(options: Omit<CreateAppOptions, 'preset'>): Promise<FastifyInstance> {
    return createApp({ ...options, preset: 'development' });
  },

  /**
   * Create testing app with minimal setup
   */
  async testing(options: Omit<CreateAppOptions, 'preset'>): Promise<FastifyInstance> {
    return createApp({ ...options, preset: 'testing' });
  },
};
