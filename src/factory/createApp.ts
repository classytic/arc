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

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import qs from 'qs';
import type { CreateAppOptions, BetterAuthOption, CustomPluginAuthOption, CustomAuthenticatorOption } from './types.js';
import type { AuthPluginOptions } from '../types/index.js';
import { getPreset } from './presets.js';

// ============================================================================
// Auth option type guards
// ============================================================================

function isBetterAuth(auth: NonNullable<CreateAppOptions['auth']>): auth is BetterAuthOption {
  return typeof auth === 'object' && 'betterAuth' in auth;
}

function isCustomPlugin(auth: NonNullable<CreateAppOptions['auth']>): auth is CustomPluginAuthOption {
  return typeof auth === 'object' && 'plugin' in auth && !('betterAuth' in auth);
}

function isCustomAuthenticator(auth: NonNullable<CreateAppOptions['auth']>): auth is CustomAuthenticatorOption {
  return (
    typeof auth === 'object' &&
    'authenticate' in auth &&
    !('jwt' in auth) &&
    !('betterAuth' in auth) &&
    !('plugin' in auth)
  );
}

function isArcJwt(auth: NonNullable<CreateAppOptions['auth']>): auth is AuthPluginOptions {
  return typeof auth === 'object' && 'jwt' in auth;
}

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
      logger?.warn(`Optional plugin '${name}' skipped (${packageName} not installed)`);
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

  // Determine which auth strategy is in use
  const useBetterAuth = !isAuthDisabled && authConfig && isBetterAuth(authConfig);
  const useCustomPlugin = !isAuthDisabled && authConfig && isCustomPlugin(authConfig);
  const useCustomAuthenticator = !isAuthDisabled && authConfig && isCustomAuthenticator(authConfig);
  const useArcJwt = !isAuthDisabled && authConfig && isArcJwt(authConfig);

  // Validate: if none of the recognized strategies match, require JWT secret
  if (
    !isAuthDisabled &&
    !useBetterAuth &&
    !useCustomPlugin &&
    !useCustomAuthenticator &&
    !useArcJwt
  ) {
    throw new Error(
      'createApp: Invalid auth configuration.\n' +
      'Provide one of:\n' +
      '  - auth: { jwt: { secret } }              (Arc JWT)\n' +
      '  - auth: { betterAuth: adapter }           (Better Auth)\n' +
      '  - auth: { plugin: fastifyPlugin }         (Custom plugin)\n' +
      '  - auth: { authenticate: fn }              (Custom authenticator)\n' +
      '  - auth: false                             (Disabled)\n' +
      'Example: auth: { jwt: { secret: process.env.JWT_SECRET } }'
    );
  }

  // Arc JWT requires a secret (unless a custom authenticator is provided within AuthPluginOptions)
  if (useArcJwt) {
    const arcAuth = authConfig as AuthPluginOptions;
    if (!arcAuth.jwt?.secret && !arcAuth.authenticate) {
      throw new Error(
        'createApp: JWT secret required when Arc auth is enabled.\n' +
        'Provide auth.jwt.secret, auth.authenticate, or set auth: false to disable.\n' +
        'Example: auth: { jwt: { secret: process.env.JWT_SECRET } }'
      );
    }
  }

  // ============================================
  // 2. MERGE WITH PRESET
  // ============================================
  const presetConfig = options.preset ? getPreset(options.preset) : {};
  const config = { ...presetConfig, ...options }; // User options override preset

  // ============================================
  // 3. CREATE FASTIFY INSTANCE
  // ============================================
  let fastify: FastifyInstance = Fastify({
    logger: config.logger ?? true,
    trustProxy: config.trustProxy ?? false,
    // Use qs parser to support nested bracket notation in query strings
    // e.g., ?populate[author][select]=name,email → { populate: { author: { select: 'name,email' } } }
    // This is required for MongoKit's advanced populate options to work
    // Placed under routerOptions to avoid FSTDEP022 deprecation warning in Fastify 5
    routerOptions: {
      querystringParser: (str: string) => qs.parse(str),
    },
    ajv: {
      customOptions: {
        coerceTypes: true,
        useDefaults: true,
        removeAdditional: false,
        // Allow OpenAPI keywords (example, description, etc.) in schemas
        // These are used by response schemas for documentation but aren't standard JSON Schema
        keywords: ['example'],
      },
    },
  });

  // Apply TypeBox type provider if requested
  // This enables TypeScript type inference from TypeBox route schemas
  if (config.typeProvider === 'typebox') {
    try {
      const { TypeBoxValidatorCompiler } = await import('@fastify/type-provider-typebox');
      fastify.setValidatorCompiler(TypeBoxValidatorCompiler);
      fastify.log.debug('TypeBox type provider enabled');
    } catch {
      fastify.log.warn(
        'typeProvider: "typebox" requested but @fastify/type-provider-typebox is not installed. ' +
        'Install it with: npm install @sinclair/typebox @fastify/type-provider-typebox'
      );
    }
  }

  // ============================================
  // 3b. FIX EMPTY JSON BODY ON DELETE/GET REQUESTS
  // ============================================
  // Some clients (browsers, fetch wrappers) send Content-Type: application/json
  // on DELETE/GET requests with no body. Fastify's default JSON parser rejects
  // empty bodies with FST_ERR_CTP_EMPTY_JSON_BODY. Override to treat them as undefined.
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req: FastifyRequest, body: string, done: (err: Error | null, body?: unknown) => void) => {
      if (!body || body.length === 0) {
        return done(null, undefined);
      }
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error);
      }
    }
  );

  // ============================================
  // 4. REGISTER SECURITY PLUGINS (opt-out)
  // ============================================

  // Helmet - Security headers
  if (config.helmet !== false) {
    const helmet = await loadPlugin('helmet');
    // Use type assertion to handle complex helmet options
    await fastify.register(helmet, (config.helmet ?? {}) as Record<string, unknown>);
    fastify.log.debug('Helmet (security headers) enabled');
  } else {
    fastify.log.warn('Helmet disabled - security headers not applied');
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
    fastify.log.debug('CORS enabled');
  } else {
    fastify.log.warn('CORS disabled');
  }

  // Rate limiting - DDoS protection
  if (config.rateLimit !== false) {
    const rateLimit = await loadPlugin('rateLimit');
    const rateLimitOpts = config.rateLimit ?? { max: 100, timeWindow: '1 minute' };
    await fastify.register(rateLimit, rateLimitOpts);

    // Warn if production without Redis store (in-memory = per-instance counters)
    if (config.preset === 'production') {
      const hasStore = typeof rateLimitOpts === 'object' && 'store' in rateLimitOpts;
      if (!hasStore) {
        fastify.log.warn(
          'Rate limiting is using in-memory store. In multi-instance deployments, ' +
          'each instance tracks limits independently. Configure a Redis store for distributed rate limiting: ' +
          'rateLimit: { store: new RedisStore({ ... }) }'
        );
      }
    }

    fastify.log.debug('Rate limiting enabled');
  } else {
    fastify.log.warn('Rate limiting disabled');
  }

  // ============================================
  // 5. REGISTER PERFORMANCE PLUGINS
  // ============================================

  // Note: Compression is NOT included due to known Fastify 5 stream issues.
  // Use a reverse proxy (Nginx, Caddy) or CDN for response compression.
  // See: https://github.com/fastify/fastify/issues/6017
  if (config.preset === 'production') {
    fastify.log.warn(
      'Response compression is not enabled (Fastify 5 stream issues). ' +
      'Use a reverse proxy (Nginx, Caddy, Cloudflare) for gzip/brotli in production.'
    );
  }

  // Under Pressure - Health monitoring
  if (config.underPressure !== false) {
    const underPressure = await loadPlugin('underPressure');
    await fastify.register(underPressure, config.underPressure ?? { exposeStatusRoute: true });
    fastify.log.debug('Health monitoring (under-pressure) enabled');
  } else {
    fastify.log.debug('Health monitoring disabled');
  }

  // ============================================
  // 6. REGISTER UTILITY PLUGINS (opt-out)
  // ============================================

  // Sensible - HTTP helpers
  if (config.sensible !== false) {
    const sensible = await loadPlugin('sensible');
    await fastify.register(sensible);
    fastify.log.debug('Sensible (HTTP helpers) enabled');
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
        // CRITICAL: Throw on file size exceeded instead of silently truncating
        throwFileSizeLimit: true,
      };
      await fastify.register(multipart, { ...multipartDefaults, ...config.multipart });
      fastify.log.debug('Multipart (file uploads) enabled');
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
      fastify.log.debug('Raw body parsing enabled');
    }
  }

  // ============================================
  // 7. REGISTER ARC CORE & PLUGINS
  // ============================================

  // Single dynamic import for all Arc plugins
  const {
    arcCorePlugin,
    requestIdPlugin,
    healthPlugin,
    gracefulShutdownPlugin,
  } = await import('../plugins/index.js');

  // Always register arc core first - provides fastify.arc with hooks & registry
  // This prevents global singleton leaks between app instances (e.g., in tests)
  await fastify.register(arcCorePlugin, {
    emitEvents: config.arcPlugins?.emitEvents !== false,
  });

  // ============================================
  // 8. REGISTER ARC PLUGINS (opt-in)
  // ============================================

  if (config.arcPlugins?.requestId !== false) {
    await fastify.register(requestIdPlugin);
    fastify.log.debug('Arc requestId plugin enabled');
  }

  if (config.arcPlugins?.health !== false) {
    await fastify.register(healthPlugin);
    fastify.log.debug('Arc health plugin enabled');
  }

  if (config.arcPlugins?.gracefulShutdown !== false) {
    await fastify.register(gracefulShutdownPlugin);
    fastify.log.debug('Arc gracefulShutdown plugin enabled');
  }

  // Caching plugin (opt-in)
  if (config.arcPlugins?.caching) {
    const { default: cachingPlugin } = await import('../plugins/caching.js');
    const cachingOpts = config.arcPlugins.caching === true ? {} : config.arcPlugins.caching;
    await fastify.register(cachingPlugin, cachingOpts);
    fastify.log.debug('Arc caching plugin enabled');
  }

  // SSE plugin (opt-in, requires events)
  if (config.arcPlugins?.sse) {
    if (config.arcPlugins?.emitEvents === false) {
      fastify.log.warn('SSE plugin requires events (arcPlugins.emitEvents). SSE disabled.');
    } else {
      const { default: ssePlugin } = await import('../plugins/sse.js');
      const sseOpts = config.arcPlugins.sse === true ? {} : config.arcPlugins.sse;
      await fastify.register(ssePlugin, sseOpts);
      fastify.log.debug('Arc SSE plugin enabled');
    }
  }

  // ============================================
  // 9. REGISTER AUTHENTICATION (Arc, Better Auth, or custom)
  // ============================================

  if (isAuthDisabled) {
    fastify.log.debug('Authentication disabled');
  } else if (useBetterAuth) {
    // Better Auth adapter — registers auth routes + fastify.authenticate
    const { plugin, openapi } = (authConfig as BetterAuthOption).betterAuth;
    await fastify.register(plugin);
    // Push OpenAPI paths if the adapter extracted them (and plugin didn't already)
    if (openapi && !fastify.arc.externalOpenApiPaths.includes(openapi)) {
      fastify.arc.externalOpenApiPaths.push(openapi);
    }
    fastify.log.debug('Better Auth authentication enabled');
  } else if (useCustomPlugin) {
    // Custom auth plugin — user has full control
    const { plugin } = authConfig as CustomPluginAuthOption;
    await fastify.register(plugin);
    fastify.log.debug('Custom authentication plugin enabled');
  } else if (useCustomAuthenticator) {
    // Custom authenticator function — decorate directly
    const { authenticate } = authConfig as CustomAuthenticatorOption;
    fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
      await authenticate(request, reply);
    });
    fastify.log.debug('Custom authenticator enabled');
  } else if (useArcJwt) {
    // Arc's built-in JWT auth plugin
    const { authPlugin } = await import('../auth/index.js');
    const arcAuth = authConfig as AuthPluginOptions;
    await fastify.register(authPlugin, arcAuth);
    fastify.log.debug('Arc authentication plugin enabled');
  }

  // ============================================
  // 10. REGISTER CUSTOM PLUGINS
  // ============================================

  if (config.plugins) {
    await config.plugins(fastify);
    fastify.log.debug('Custom plugins registered');
  }

  // ============================================
  // 11. LOG SUMMARY
  // ============================================

  const authMode = isAuthDisabled ? 'none' : useBetterAuth ? 'better-auth' : useCustomPlugin ? 'custom-plugin' : useCustomAuthenticator ? 'custom' : useArcJwt ? 'jwt' : 'none';
  fastify.log.info(
    { preset: config.preset ?? 'custom', auth: authMode, helmet: config.helmet !== false, cors: config.cors !== false, rateLimit: config.rateLimit !== false },
    'Arc application created'
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
