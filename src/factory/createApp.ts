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
 *   auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
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

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import qs from "qs";
import type { CreateAppOptions } from "./types.js";
import { getPreset } from "./presets.js";
import { PUBLIC_SCOPE } from "../scope/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify plugin types vary per package
type FastifyPlugin = (...args: any[]) => any;

// Plugin registry: name → { package, loader, optional }
const PLUGIN_REGISTRY: Record<
  string,
  {
    package: string;
    loader: () => Promise<FastifyPlugin>;
    optional?: boolean;
  }
> = {
  cors: {
    package: "@fastify/cors",
    loader: () => import("@fastify/cors").then((m) => m.default),
  },
  helmet: {
    package: "@fastify/helmet",
    loader: () => import("@fastify/helmet").then((m) => m.default),
  },
  rateLimit: {
    package: "@fastify/rate-limit",
    loader: () => import("@fastify/rate-limit").then((m) => m.default),
  },
  underPressure: {
    package: "@fastify/under-pressure",
    loader: () => import("@fastify/under-pressure").then((m) => m.default),
  },
  sensible: {
    package: "@fastify/sensible",
    loader: () => import("@fastify/sensible").then((m) => m.default),
  },
  multipart: {
    package: "@fastify/multipart",
    loader: () => import("@fastify/multipart").then((m) => m.default),
    optional: true,
  },
  rawBody: {
    package: "fastify-raw-body",
    loader: () => import("fastify-raw-body").then((m) => m.default),
    optional: true,
  },
};

// Import plugins (with lazy loading for optional dependencies)
async function loadPlugin(
  name: string,
  logger?: { warn: (msg: string) => void },
): Promise<FastifyPlugin | null> {
  const entry = PLUGIN_REGISTRY[name];
  if (!entry) {
    throw new Error(`Unknown plugin: ${name}`);
  }

  try {
    return await entry.loader();
  } catch (error) {
    const err = error as Error;
    const isModuleNotFound =
      err.message.includes("Cannot find module") ||
      err.message.includes("Cannot find package") ||
      err.message.includes("MODULE_NOT_FOUND") ||
      err.message.includes("Could not resolve");

    // For optional plugins, return null instead of throwing
    if (isModuleNotFound && entry.optional) {
      logger?.warn(
        `Optional plugin '${name}' skipped (${entry.package} not installed)`,
      );
      return null;
    }

    // For required plugins, throw helpful error
    if (isModuleNotFound) {
      throw new Error(
        `Plugin '${name}' requires package '${entry.package}' which is not installed.\n` +
          `Install it with: npm install ${entry.package}\n` +
          `Or disable this plugin by setting ${name}: false in createApp options.`,
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
export async function createApp(
  options: CreateAppOptions,
): Promise<FastifyInstance> {
  // ============================================
  // 0. CONFIGURE ARC LOGGER
  // ============================================
  if (options.debug !== undefined && options.debug !== false) {
    const { configureArcLogger } = await import("../logger/index.js");
    configureArcLogger({ debug: options.debug });
  }

  // ============================================
  // 1. VALIDATE AUTH OPTIONS
  // ============================================
  const authConfig = options.auth;
  const isAuthDisabled = authConfig === false;

  // Validate JWT auth requires a secret (unless a custom authenticator is provided)
  if (!isAuthDisabled && authConfig && authConfig.type === "jwt") {
    if (!authConfig.jwt?.secret && !authConfig.authenticate) {
      throw new Error(
        "createApp: JWT secret required when Arc auth is enabled.\n" +
          "Provide auth.jwt.secret, auth.authenticate, or set auth: false to disable.\n" +
          "Example: auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } }",
      );
    }
  }

  // ============================================
  // 1b. VALIDATE RUNTIME PROFILE
  // ============================================
  if (options.runtime === "distributed") {
    const MEMORY_NAMES = new Set(["memory", "memory-cache"]);
    const missing: string[] = [];

    const eventsTransport = options.stores?.events;
    if (!eventsTransport || MEMORY_NAMES.has(eventsTransport.name)) {
      missing.push("events transport");
    }

    const cacheStore = options.stores?.cache;
    if (!cacheStore || MEMORY_NAMES.has(cacheStore.name)) {
      missing.push("cache store");
    }

    const idempotencyStore = options.stores?.idempotency;
    if (!idempotencyStore || MEMORY_NAMES.has(idempotencyStore.name)) {
      missing.push("idempotency store");
    }

    // QueryCache store validation (only when queryCache plugin is enabled)
    if (options.arcPlugins?.queryCache) {
      const qcStore = options.stores?.queryCache;
      if (!qcStore || MEMORY_NAMES.has(qcStore.name)) {
        missing.push("queryCache store");
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `[Arc] runtime: 'distributed' requires Redis/durable adapters.\n` +
          `Missing: ${missing.join(", ")}.\n` +
          `Provide Redis-backed stores or use runtime: 'memory' for development.`,
      );
    }
  }

  // ============================================
  // 2. MERGE WITH PRESET
  // ============================================
  const presetConfig = options.preset ? getPreset(options.preset) : {};
  const config: CreateAppOptions = { ...presetConfig, ...options }; // User options override preset

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
        keywords: ["example", ...(config.ajv?.keywords ?? [])],
      },
    },
  });

  // Apply TypeBox type provider if requested
  // This enables TypeScript type inference from TypeBox route schemas
  if (config.typeProvider === "typebox") {
    try {
      const { TypeBoxValidatorCompiler } =
        await import("@fastify/type-provider-typebox");
      fastify.setValidatorCompiler(TypeBoxValidatorCompiler);
      fastify.log.debug("TypeBox type provider enabled");
    } catch {
      fastify.log.warn(
        'typeProvider: "typebox" requested but @fastify/type-provider-typebox is not installed. ' +
          "Install it with: npm install @sinclair/typebox @fastify/type-provider-typebox",
      );
    }
  }

  // ============================================
  // 3b. FIX EMPTY JSON BODY ON DELETE/GET REQUESTS
  // ============================================
  // Some clients (browsers, fetch wrappers) send Content-Type: application/json
  // on DELETE/GET requests with no body. Fastify's default JSON parser rejects
  // empty bodies with FST_ERR_CTP_EMPTY_JSON_BODY. Override to treat them as undefined.
  fastify.removeContentTypeParser("application/json");
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (
      _req: FastifyRequest,
      body: string,
      done: (err: Error | null, body?: unknown) => void,
    ) => {
      if (!body || body.length === 0) {
        return done(null, undefined);
      }
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // ============================================
  // 4. REGISTER SECURITY PLUGINS (opt-out)
  // ============================================

  // Helmet - Security headers
  if (config.helmet !== false) {
    const helmet = (await loadPlugin("helmet"))!;
    // Use type assertion to handle complex helmet options
    await fastify.register(
      helmet,
      (config.helmet ?? {}) as Record<string, unknown>,
    );
    fastify.log.debug("Helmet (security headers) enabled");
  } else {
    fastify.log.warn("Helmet disabled - security headers not applied");
  }

  // CORS - Cross-origin requests
  if (config.cors !== false) {
    const cors = (await loadPlugin("cors"))!;
    const corsOptions = { ...(config.cors ?? {}) } as Record<string, unknown>;

    // Require explicit origin in production
    if (
      config.preset === "production" &&
      (!corsOptions || !("origin" in corsOptions))
    ) {
      throw new Error(
        "CORS origin must be explicitly configured in production.\n" +
          "Set cors.origin to allowed domains or set cors: false to disable.\n" +
          "Example: cors: { origin: ['https://yourdomain.com'] }\n" +
          "Docs: https://github.com/classytic/arc#security",
      );
    }

    // Smart CORS: when credentials are enabled and origin is '*' (string),
    // convert to `true` so @fastify/cors reflects the request Origin header
    // instead of sending literal '*', which browsers reject with credentials.
    if (corsOptions.credentials && corsOptions.origin === "*") {
      corsOptions.origin = true;
    }

    await fastify.register(cors, corsOptions);
    fastify.log.debug("CORS enabled");
  } else {
    fastify.log.warn("CORS disabled");
  }

  // Rate limiting - DDoS protection
  if (config.rateLimit !== false) {
    const rateLimit = (await loadPlugin("rateLimit"))!;
    const rateLimitOpts = config.rateLimit ?? {
      max: 100,
      timeWindow: "1 minute",
    };
    await fastify.register(rateLimit, rateLimitOpts);

    // Warn if production without Redis store (in-memory = per-instance counters)
    if (config.preset === "production") {
      const hasStore =
        typeof rateLimitOpts === "object" && "store" in rateLimitOpts;
      if (!hasStore) {
        fastify.log.warn(
          "Rate limiting is using in-memory store. In multi-instance deployments, " +
            "each instance tracks limits independently. Configure a Redis store for distributed rate limiting: " +
            "rateLimit: { store: new RedisStore({ ... }) }",
        );
      }
    }

    fastify.log.debug("Rate limiting enabled");
  } else {
    fastify.log.warn("Rate limiting disabled");
  }

  // ============================================
  // 5. REGISTER PERFORMANCE PLUGINS
  // ============================================

  // Note: Compression is NOT included due to known Fastify 5 stream issues.
  // Use a reverse proxy (Nginx, Caddy) or CDN for response compression.
  // See: https://github.com/fastify/fastify/issues/6017
  if (config.preset === "production") {
    fastify.log.warn(
      "Response compression is not enabled (Fastify 5 stream issues). " +
        "Use a reverse proxy (Nginx, Caddy, Cloudflare) for gzip/brotli in production.",
    );
  }

  // Under Pressure - Health monitoring
  if (config.underPressure !== false) {
    const underPressure = (await loadPlugin("underPressure"))!;
    await fastify.register(
      underPressure,
      config.underPressure ?? { exposeStatusRoute: true },
    );
    fastify.log.debug("Health monitoring (under-pressure) enabled");
  } else {
    fastify.log.debug("Health monitoring disabled");
  }

  // ============================================
  // 6. REGISTER UTILITY PLUGINS (opt-out)
  // ============================================

  // Sensible - HTTP helpers
  if (config.sensible !== false) {
    const sensible = (await loadPlugin("sensible"))!;
    await fastify.register(sensible);
    fastify.log.debug("Sensible (HTTP helpers) enabled");
  }

  // Multipart - File uploads (optional)
  if (config.multipart !== false) {
    const multipart = await loadPlugin("multipart", fastify.log);
    if (multipart) {
      const multipartDefaults = {
        limits: {
          fileSize: 10 * 1024 * 1024, // 10MB
          files: 10,
        },
        // CRITICAL: Throw on file size exceeded instead of silently truncating
        throwFileSizeLimit: true,
      };
      await fastify.register(multipart, {
        ...multipartDefaults,
        ...config.multipart,
      });
      fastify.log.debug("Multipart (file uploads) enabled");
    }
  }

  // Raw body - For webhooks (optional)
  if (config.rawBody !== false) {
    const rawBody = await loadPlugin("rawBody", fastify.log);
    if (rawBody) {
      const rawBodyDefaults = {
        field: "rawBody",
        global: false,
        encoding: "utf8",
        runFirst: true,
      };
      await fastify.register(rawBody, {
        ...rawBodyDefaults,
        ...config.rawBody,
      });
      fastify.log.debug("Raw body parsing enabled");
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
  } = await import("../plugins/index.js");

  // Always register arc core first - provides fastify.arc with hooks & registry
  // This prevents global singleton leaks between app instances (e.g., in tests)
  await fastify.register(arcCorePlugin, {
    emitEvents: config.arcPlugins?.emitEvents !== false,
  });

  /** Track a plugin in the Arc plugin registry */
  const trackPlugin = (name: string, opts?: Record<string, unknown>) => {
    fastify.arc.plugins.set(name, {
      name,
      options: opts,
      registeredAt: new Date().toISOString(),
    });
  };
  trackPlugin("arc-core");

  // Register event plugin — provides fastify.events for pub/sub.
  // Without this, arcCorePlugin's CRUD event hooks are no-ops (hasEvents check).
  // Transport is sourced from stores.events (defaults to MemoryEventTransport).
  if (config.arcPlugins?.events !== false) {
    const { default: eventPlugin } = await import("../events/eventPlugin.js");
    const eventOpts =
      typeof config.arcPlugins?.events === "object"
        ? config.arcPlugins.events
        : {};
    await fastify.register(eventPlugin, {
      ...eventOpts,
      transport: options.stores?.events, // undefined → eventPlugin defaults to MemoryEventTransport
    });
    trackPlugin("arc-events", eventOpts as Record<string, unknown>);
    fastify.log.debug(
      `Arc events plugin enabled (transport: ${fastify.events.transportName})`,
    );
  }

  // ============================================
  // 8. REGISTER ARC PLUGINS (opt-in)
  // ============================================

  if (config.arcPlugins?.requestId !== false) {
    await fastify.register(requestIdPlugin);
    trackPlugin("arc-request-id");
    fastify.log.debug("Arc requestId plugin enabled");
  }

  if (config.arcPlugins?.health !== false) {
    await fastify.register(healthPlugin);
    trackPlugin("arc-health");
    fastify.log.debug("Arc health plugin enabled");
  }

  if (config.arcPlugins?.gracefulShutdown !== false) {
    await fastify.register(gracefulShutdownPlugin);
    trackPlugin("arc-graceful-shutdown");
    fastify.log.debug("Arc gracefulShutdown plugin enabled");
  }

  // Caching plugin (opt-in)
  if (config.arcPlugins?.caching) {
    const { default: cachingPlugin } = await import("../plugins/caching.js");
    const cachingOpts =
      config.arcPlugins.caching === true ? {} : config.arcPlugins.caching;
    await fastify.register(cachingPlugin, cachingOpts);
    trackPlugin("arc-caching", cachingOpts as Record<string, unknown>);
    fastify.log.debug("Arc caching plugin enabled");
  }

  // QueryCache plugin (opt-in)
  if (config.arcPlugins?.queryCache) {
    const { queryCachePlugin } = await import("../cache/queryCachePlugin.js");
    const qcOpts =
      config.arcPlugins.queryCache === true ? {} : config.arcPlugins.queryCache;
    const store =
      options.stores?.queryCache ??
      new (await import("../cache/memory.js")).MemoryCacheStore();
    await fastify.register(queryCachePlugin, { store, ...qcOpts });
    trackPlugin("arc-query-cache", qcOpts as Record<string, unknown>);
    fastify.log.debug("Arc queryCache plugin enabled");
  }

  // SSE plugin (opt-in, requires events)
  if (config.arcPlugins?.sse) {
    if (config.arcPlugins?.events === false) {
      fastify.log.warn(
        "SSE plugin requires events plugin (arcPlugins.events). SSE disabled.",
      );
    } else {
      const { default: ssePlugin } = await import("../plugins/sse.js");
      const sseOpts =
        config.arcPlugins.sse === true ? {} : config.arcPlugins.sse;
      await fastify.register(ssePlugin, sseOpts);
      trackPlugin("arc-sse", sseOpts as Record<string, unknown>);
      fastify.log.debug("Arc SSE plugin enabled");
    }
  }

  // ============================================
  // 9a. DECORATE request.scope (default: public)
  // ============================================
  // Every request starts as 'public'. Auth hooks upgrade to 'authenticated' or 'member'.
  // Elevation plugin (if registered) may further upgrade to 'elevated'.
  // Initial value is null — the onRequest hook below sets the real default per-request.
  // Using null avoids Fastify 5's reference-type sharing bug (objects are shared across requests).
  fastify.decorateRequest("scope", null!);
  fastify.addHook("onRequest", async (request) => {
    if (!request.scope) {
      request.scope = PUBLIC_SCOPE;
    }
  });

  // ============================================
  // 9b. REGISTER AUTHENTICATION (Arc, Better Auth, or custom)
  // ============================================

  if (isAuthDisabled) {
    fastify.log.debug("Authentication disabled");
  } else if (authConfig) {
    switch (authConfig.type) {
      case "betterAuth": {
        // Better Auth adapter — registers auth routes + fastify.authenticate
        const { plugin, openapi } = authConfig.betterAuth;
        await fastify.register(plugin);
        trackPlugin("auth-better-auth");
        // Push OpenAPI paths if the adapter extracted them (and plugin didn't already)
        if (openapi && !fastify.arc.externalOpenApiPaths.includes(openapi)) {
          fastify.arc.externalOpenApiPaths.push(openapi);
        }
        fastify.log.debug("Better Auth authentication enabled");
        break;
      }
      case "custom": {
        // Custom auth plugin — user has full control
        await fastify.register(authConfig.plugin);
        trackPlugin("auth-custom");
        fastify.log.debug("Custom authentication plugin enabled");
        break;
      }
      case "authenticator": {
        // Custom authenticator function — decorate both authenticate and optionalAuthenticate.
        // optionalAuthenticate is required for public routes (allowPublic) to parse auth
        // when present, enabling proper org-scoped filtering for authenticated users.
        const { authenticate, optionalAuthenticate } = authConfig as {
          authenticate: (
            request: FastifyRequest,
            reply: FastifyReply,
          ) => Promise<void>;
          optionalAuthenticate?: (
            request: FastifyRequest,
            reply: FastifyReply,
          ) => Promise<void>;
        };
        fastify.decorate(
          "authenticate",
          async function (request: FastifyRequest, reply: FastifyReply) {
            await authenticate(request, reply);
          },
        );
        if (!fastify.hasDecorator("optionalAuthenticate")) {
          if (optionalAuthenticate) {
            // User provided an explicit optional auth handler
            fastify.decorate(
              "optionalAuthenticate",
              async function (request: FastifyRequest, reply: FastifyReply) {
                await optionalAuthenticate(request, reply);
              },
            );
          } else {
            // Auto-generate: wrap authenticate to silently ignore failures.
            // Uses a lightweight reply proxy to intercept error responses without
            // actually sending them, so the request continues as unauthenticated.
            fastify.decorate(
              "optionalAuthenticate",
              async function (request: FastifyRequest, reply: FastifyReply) {
                let intercepted = false;
                const proxyReply = new Proxy(reply, {
                  get(target, prop) {
                    if (prop === "code") {
                      return (statusCode: number) => {
                        if (statusCode === 401 || statusCode === 403) {
                          intercepted = true;
                          // Return a chainable proxy that no-ops send/type/header
                          return new Proxy(target, {
                            get(_t, p) {
                              if (
                                p === "send" ||
                                p === "type" ||
                                p === "header" ||
                                p === "headers"
                              ) {
                                return () => proxyReply;
                              }
                              return Reflect.get(target, p, target);
                            },
                          });
                        }
                        return target.code(statusCode);
                      };
                    }
                    if (prop === "send" && intercepted) {
                      return () => proxyReply;
                    }
                    if (prop === "sent") {
                      return intercepted ? false : target.sent;
                    }
                    return Reflect.get(target, prop, target);
                  },
                });

                try {
                  await authenticate(request, proxyReply as FastifyReply);
                } catch {
                  // Silently ignore auth errors — treat as unauthenticated
                }
                // If authenticate sent a 401/403, we intercepted it — request continues as public
              },
            );
          }
        }
        trackPlugin("auth-authenticator");
        fastify.log.debug("Custom authenticator enabled");
        break;
      }
      case "jwt": {
        // Arc's built-in JWT auth plugin
        const { authPlugin } = await import("../auth/index.js");
        // Pass all fields except `type` to the auth plugin (matches AuthPluginOptions shape)
        const { type: _, ...arcAuthOpts } = authConfig;
        await fastify.register(authPlugin, arcAuthOpts);
        trackPlugin("auth-jwt");
        fastify.log.debug("Arc authentication plugin enabled");
        break;
      }
    }
  }

  // ============================================
  // 9c. REGISTER ELEVATION PLUGIN (opt-in, after auth)
  // ============================================
  if (config.elevation) {
    const { elevationPlugin } = await import("../scope/elevation.js");
    await fastify.register(elevationPlugin, config.elevation);
    trackPlugin("arc-elevation", config.elevation as Record<string, unknown>);
    fastify.log.debug("Elevation plugin enabled");
  }

  // ============================================
  // 9d. REGISTER ERROR HANDLER (opt-out)
  // ============================================
  if (config.errorHandler !== false) {
    const { errorHandlerPlugin } = await import("../plugins/errorHandler.js");
    const errorOpts =
      typeof config.errorHandler === "object"
        ? config.errorHandler
        : {
            includeStack: config.preset !== "production",
          };
    await fastify.register(errorHandlerPlugin, errorOpts);
    trackPlugin("arc-error-handler", errorOpts as Record<string, unknown>);
    fastify.log.debug("Arc error handler enabled");
  }

  // ============================================
  // 10. REGISTER CUSTOM PLUGINS
  // ============================================

  if (config.plugins) {
    await config.plugins(fastify);
    fastify.log.debug("Custom plugins registered");
  }

  // ============================================
  // 10b. LIFECYCLE HOOKS
  // ============================================
  if (config.onReady) {
    const onReady = config.onReady;
    fastify.addHook("onReady", async () => {
      await onReady(fastify);
    });
  }
  if (config.onClose) {
    const onClose = config.onClose;
    fastify.addHook("onClose", async () => {
      await onClose(fastify);
    });
  }

  // ============================================
  // 11. LOG SUMMARY
  // ============================================

  const authMode = isAuthDisabled
    ? "none"
    : authConfig
      ? authConfig.type
      : "none";
  fastify.log.info(
    {
      preset: config.preset ?? "custom",
      runtime: config.runtime ?? "memory",
      auth: authMode,
      helmet: config.helmet !== false,
      cors: config.cors !== false,
      rateLimit: config.rateLimit !== false,
    },
    "Arc application created",
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
  async production(
    options: Omit<CreateAppOptions, "preset">,
  ): Promise<FastifyInstance> {
    return createApp({ ...options, preset: "production" });
  },

  /**
   * Create development app with relaxed security
   */
  async development(
    options: Omit<CreateAppOptions, "preset">,
  ): Promise<FastifyInstance> {
    return createApp({ ...options, preset: "development" });
  },

  /**
   * Create testing app with minimal setup
   */
  async testing(
    options: Omit<CreateAppOptions, "preset">,
  ): Promise<FastifyInstance> {
    return createApp({ ...options, preset: "testing" });
  },
};
