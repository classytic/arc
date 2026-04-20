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
 * // 2. Create Arc app with resources
 * const app = await createApp({
 *   preset: 'production',
 *   auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
 *   cors: { origin: ['https://example.com'] },
 *   resources: [productResource, orderResource],
 * });
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

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import qs from "qs";
import { getPreset } from "./presets.js";
import { registerArcCore, registerArcPlugins } from "./registerArcPlugins.js";
import {
  decorateRequestScope,
  registerAuth,
  registerElevation,
  registerErrorHandler,
} from "./registerAuth.js";
import { registerResources } from "./registerResources.js";
import { registerSecurityPlugins, registerUtilityPlugins } from "./registerSecurity.js";
import type { CreateAppOptions } from "./types.js";

// ── Constants ──

const MEMORY_STORE_NAMES = new Set(["memory", "memory-cache"]);

// ── Validation ──

function validateAuthOptions(options: CreateAppOptions): void {
  const authConfig = options.auth;
  if (authConfig === false || !authConfig) return;

  if (authConfig.type === "jwt" && !authConfig.jwt?.secret && !authConfig.authenticate) {
    throw new Error(
      "createApp: JWT secret required when Arc auth is enabled.\n" +
        "Provide auth.jwt.secret, auth.authenticate, or set auth: false to disable.\n" +
        "Example: auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } }",
    );
  }
}

function validateDistributedRuntime(options: CreateAppOptions): string[] {
  const deferredWarnings: string[] = [];
  if (options.runtime !== "distributed") return deferredWarnings;

  const missing: string[] = [];

  // Events transport — always required for distributed
  const events = options.stores?.events;
  if (!events || MEMORY_STORE_NAMES.has(events.name)) {
    missing.push("events transport");
  }

  // Cache store — only when caching is enabled. An adapter without a
  // `name` (the bare repo-core `CacheAdapter` shape) is treated as
  // external — caller opted in explicitly.
  if (options.arcPlugins?.caching) {
    const cache = options.stores?.cache;
    if (!cache || (cache.name !== undefined && MEMORY_STORE_NAMES.has(cache.name))) {
      missing.push("cache store");
    }
  }

  // Idempotency store — warn when memory-backed or absent
  const idempotency = options.stores?.idempotency;
  if (idempotency && MEMORY_STORE_NAMES.has(idempotency.name)) {
    missing.push("idempotency store (memory-backed in distributed mode)");
  } else if (!idempotency) {
    deferredWarnings.push(
      "runtime: 'distributed' — no idempotency store configured. " +
        "Write-path deduplication will be instance-local. If resources use the " +
        "idempotency plugin, provide stores.idempotency with a Redis/MongoDB store.",
    );
  }

  // QueryCache store — only when queryCache is enabled. Unnamed adapters
  // are treated as external (see `cache` above).
  if (options.arcPlugins?.queryCache) {
    const qc = options.stores?.queryCache;
    if (!qc || (qc.name !== undefined && MEMORY_STORE_NAMES.has(qc.name))) {
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

  return deferredWarnings;
}

// ── Factory ──

/**
 * Create a production-ready Fastify application with Arc framework.
 *
 * Boot order:
 * ```
 * 0. Logger, validation, preset merge
 * 1. Create Fastify instance
 * 2. Security plugins (Helmet, CORS, Rate Limit) — opt-out
 * 3. Utility plugins (Under Pressure, Sensible, Multipart, Raw Body)
 * 4. Arc core (fastify.arc, events)
 * 5. Arc plugins (requestId, health, caching, SSE, metrics, versioning)
 * 6. Auth (scope decoration, auth strategy, elevation, error handler)
 * 7. plugins()        — user infra (DB, docs, webhooks)
 * 8. bootstrap[]      — domain init (singletons, event handlers)
 * 9. resources[]      — auto-discovered routes (prefix + skipGlobalPrefix)
 * 10. afterResources() — post-registration wiring
 * 11. onReady/onClose  — lifecycle hooks
 * ```
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  // ── 0. Logger + validation ──

  if (options.debug !== undefined && options.debug !== false) {
    const { configureArcLogger } = await import("../logger/index.js");
    configureArcLogger({ debug: options.debug });
  }

  validateAuthOptions(options);
  const deferredWarnings = validateDistributedRuntime(options);

  // ── 1. Merge preset + create Fastify ──

  const presetConfig = options.preset ? getPreset(options.preset) : {};
  const config: CreateAppOptions = { ...presetConfig, ...options };

  const fastify: FastifyInstance = Fastify({
    logger: config.logger ?? true,
    trustProxy: config.trustProxy ?? false,
    pluginTimeout: config.pluginTimeout ?? 10_000,
    routerOptions: {
      querystringParser: (str: string) => qs.parse(str),
    },
    ajv: {
      customOptions: {
        coerceTypes: true,
        useDefaults: true,
        removeAdditional: false,
        keywords: ["example", ...(config.ajv?.keywords ?? [])],
      },
    },
  });

  for (const warning of deferredWarnings) {
    fastify.log.warn(warning);
  }

  // TypeBox type provider (opt-in)
  if (config.typeProvider === "typebox") {
    try {
      const { TypeBoxValidatorCompiler } = await import("@fastify/type-provider-typebox");
      fastify.setValidatorCompiler(TypeBoxValidatorCompiler);
    } catch {
      fastify.log.warn(
        'typeProvider: "typebox" requested but @fastify/type-provider-typebox is not installed.',
      );
    }
  }

  // Fix empty JSON body on DELETE/GET requests.
  // Some clients send Content-Type: application/json with no body on DELETE/GET.
  // Fastify's default parser rejects this (FST_ERR_CTP_EMPTY_JSON_BODY).
  // We override to treat empty bodies as undefined, while preserving Fastify's
  // prototype poisoning protection via secure-json-parse.
  const sjp = await import("secure-json-parse");
  fastify.removeContentTypeParser("application/json");
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req: FastifyRequest, body: string, done: (err: Error | null, body?: unknown) => void) => {
      if (!body || body.length === 0) return done(null, undefined);
      try {
        done(null, sjp.parse(body));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // ── 2. Security plugins (opt-out) ──
  await registerSecurityPlugins(fastify, config);

  // ── 3. Utility plugins ──
  await registerUtilityPlugins(fastify, config);

  // ── 4. Arc core + events ──
  const trackPlugin = (name: string, opts?: Record<string, unknown>) => {
    fastify.arc.plugins.set(name, {
      name,
      options: opts,
      registeredAt: new Date().toISOString(),
    });
  };

  const arcModules = await registerArcCore(fastify, config, trackPlugin);

  // ── 5. Arc plugins (opt-in) ──
  await registerArcPlugins(fastify, config, trackPlugin, arcModules);

  // ── 6. Auth (scope + strategy + elevation + error handler) ──
  decorateRequestScope(fastify);
  await registerAuth(fastify, config, trackPlugin);
  await registerElevation(fastify, config, trackPlugin);
  await registerErrorHandler(fastify, config, trackPlugin);

  // ── 7–11. Resources lifecycle (plugins → bootstrap → resources → after → hooks) ──
  await registerResources(fastify, config);

  // ── Reply helpers (opt-in) ──
  if (config.replyHelpers) {
    const { replyHelpersPlugin } = await import("../plugins/replyHelpers.js");
    await fastify.register(replyHelpersPlugin);
  }

  // ── BigInt serialization (opt-in) ──
  if (config.serializeBigInt) {
    fastify.addHook("preSerialization", async (_request, _reply, payload) => {
      if (payload === null || payload === undefined) return payload;
      // Fast path: only transform if the payload actually contains BigInt
      // JSON.stringify with a replacer handles nested values efficiently
      try {
        return JSON.parse(
          JSON.stringify(payload, (_key, value) =>
            typeof value === "bigint" ? Number(value) : value,
          ),
        );
      } catch {
        return payload;
      }
    });
  }

  // ── Log summary ──
  const authMode = config.auth === false ? "none" : config.auth ? config.auth.type : "none";
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
  async production(options: Omit<CreateAppOptions, "preset">): Promise<FastifyInstance> {
    return createApp({ ...options, preset: "production" });
  },
  async development(options: Omit<CreateAppOptions, "preset">): Promise<FastifyInstance> {
    return createApp({ ...options, preset: "development" });
  },
  async testing(options: Omit<CreateAppOptions, "preset">): Promise<FastifyInstance> {
    return createApp({ ...options, preset: "testing" });
  },
};
