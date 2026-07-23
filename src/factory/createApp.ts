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

import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import qs from "qs";
import { arcLog, configureArcLogger, createPinoWriter } from "../logger/index.js";
import { createRequestIdGenerator } from "../plugins/requestId.js";
import { parseJsonBody } from "../utils/jsonBody.js";
import { collectModuleHealthChecks, orderModules, resolveModule } from "./module/index.js";
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
import type { CreateAppOptions } from "./types/index.js";

// ── Constants ──

const MEMORY_STORE_NAMES = new Set(["memory", "memory-cache"]);

/**
 * Default redact paths layered into Fastify's pino logger when the host
 * doesn't supply a `logger.redact` of their own. Covers the common token /
 * cookie / password leak surfaces — `Authorization` and `Cookie` headers
 * (and their case-variants because Node lower-cases incoming headers but
 * outgoing logs may carry either), API-key headers, and any nested
 * `password` / `token` / `secret` / `apiKey` fields anywhere in the log
 * tree.
 *
 * Hosts that need NO redaction (test fixtures, security audits) opt out
 * with `logger: { redact: [] }`. Hosts that need MORE redaction supply
 * their own `redact` and arc steps aside — this default never overrides
 * an explicit setting. (2.15.1)
 */
export const DEFAULT_LOGGER_REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  'req.headers["x-internal-api-key"]',
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.apiKey",
] as const;

/**
 * Resolve the host's `logger` option, layering safe redact defaults
 * when the host hasn't supplied any. Returns the value Fastify expects
 * for its `logger` server option.
 *
 * Three branches:
 *   - `logger === false` → pass through (no logger).
 *   - `logger === undefined` → enable with default redact paths.
 *   - `logger === true` → enable with default redact paths.
 *   - `logger` is an object → respect explicit `redact` (host wins);
 *     otherwise inject defaults.
 */
export function resolveLoggerConfig(
  logger: CreateAppOptions["logger"],
): FastifyServerOptions["logger"] {
  if (logger === false) return false;
  if (logger === true || logger === undefined) {
    return { redact: [...DEFAULT_LOGGER_REDACT_PATHS] };
  }
  if (typeof logger === "object" && logger !== null) {
    const objLogger = logger as Record<string, unknown>;
    if (objLogger.redact !== undefined) return logger;
    return { ...objLogger, redact: [...DEFAULT_LOGGER_REDACT_PATHS] } as typeof logger;
  }
  return logger;
}

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

  // Each entry carries the config key the host must set AND a concrete
  // hint, so the thrown error points at the exact fix instead of just
  // naming what's absent.
  const missing: Array<{ key: string; hint: string }> = [];

  // Events transport — always required for distributed
  const events = options.stores?.events;
  if (!events || MEMORY_STORE_NAMES.has(events.name)) {
    missing.push({ key: "stores.events", hint: "a Redis Streams or pub/sub transport" });
  }

  // Cache store — only when caching is enabled. An adapter without a
  // `name` (the bare repo-core `CacheAdapter` shape) is treated as
  // external — caller opted in explicitly.
  if (options.arcPlugins?.caching) {
    const cache = options.stores?.cache;
    if (!cache || (cache.name !== undefined && MEMORY_STORE_NAMES.has(cache.name))) {
      missing.push({ key: "stores.cache", hint: "a Redis-backed cache adapter" });
    }
  }

  // Idempotency store — warn when memory-backed or absent
  const idempotency = options.stores?.idempotency;
  if (idempotency && MEMORY_STORE_NAMES.has(idempotency.name)) {
    missing.push({
      key: "stores.idempotency",
      hint: "a Redis/MongoDB store (currently memory-backed → instance-local)",
    });
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
      missing.push({ key: "stores.queryCache", hint: "a Redis-backed query-cache adapter" });
    }
  }

  // Schedules without a lock — every replica fires every tick. Warn, don't
  // throw: duplicate schedule execution is a correctness hazard the host
  // may have accepted (idempotent jobs), unlike the hard-required stores
  // above.
  const schedules = options.arcPlugins?.schedules;
  if (
    schedules &&
    typeof schedules === "object" &&
    schedules.enabled !== false &&
    !schedules.lock
  ) {
    deferredWarnings.push(
      "runtime: 'distributed' — schedules configured without a `lock` adapter. " +
        "EVERY replica will fire every schedule tick. Pass an ecosystem lock " +
        "(e.g. createMongoLockAdapter) under arcPlugins.schedules.lock for " +
        "single-firer leases.",
    );
  }

  // The guard validates what `createApp` can SEE (stores + arcPlugins).
  // Subsystems wired inside `plugins()` / `bootstrap[]` — webhook stores,
  // audit/usage stores, realtime broadcast adapters, outbox relays — are
  // the host's checklist: wiki/delivery-guarantees.md, "Distributed
  // deployment checklist".

  if (missing.length > 0) {
    const lines = missing.map((m) => `  • ${m.key.padEnd(20)} → ${m.hint}`).join("\n");
    throw new Error(
      "[Arc] runtime: 'distributed' requires durable (Redis/MongoDB) adapters, not memory.\n\n" +
        `Missing:\n${lines}\n\n` +
        "Fix: pass durable adapters under `stores`, or use runtime: 'memory' for single-instance dev.",
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
 * 0. Logger, validation → beforeBoot() (DB connect etc.), preset merge
 * 1. Create Fastify instance
 * 2. Security plugins (Helmet, CORS, Rate Limit) — opt-out
 * 3. Utility plugins (Under Pressure, Sensible, Multipart, Raw Body)
 * 4. Arc core (fastify.arc, events)
 * 5. Arc plugins (requestId, health, caching, SSE, metrics, versioning)
 * 6. Auth (scope decoration, auth strategy, elevation, error handler)
 * 7. plugins()        — user infra (DB, data, webhooks)
 * 8. bootstrap[]      — domain init (singletons, event handlers)
 * 9. resources[]      — auto-discovered routes (prefix + skipGlobalPrefix)
 * 10. afterResources() — post-registration wiring
 * 11. onReady/onClose  — lifecycle hooks
 * ```
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  // ── 0. Logger + validation ──

  if (options.debug !== undefined && options.debug !== false) {
    configureArcLogger({ debug: options.debug });
  }

  validateAuthOptions(options);
  const deferredWarnings = validateDistributedRuntime(options);

  // ── 0.5 Pre-boot hook — DB connection etc. Runs after option validation
  // (config bugs fail fast without touching infrastructure) and before
  // ANYTHING else: no Fastify instance, no module resolution, no resource
  // imports have happened yet. See `CreateAppOptions.beforeBoot`.
  if (options.beforeBoot) {
    await options.beforeBoot();
  }

  // ── 1. Merge preset + create Fastify ──

  const presetConfig = options.preset ? getPreset(options.preset) : {};
  const config: CreateAppOptions = { ...presetConfig, ...options };

  // The production preset ships `trustProxy: false` (2.24 flip — fail
  // closed; it was `true` = trust EVERY proxy). A framework can't know the
  // host's proxy topology: behind an LB, `false` means `request.ip` is the
  // LB's address (rate-limit keys collapse onto one bucket, audit IPs are
  // wrong), so we warn ONLY when the host inherited the default without
  // deciding — an explicit `trustProxy` (hop count, CIDR, function, or a
  // deliberate true/false) silences this.
  const inheritedTrustProxyDefault =
    options.preset === "production" && options.trustProxy === undefined;

  // ── 1.5 Resolve + order the module graph — pure work (dynamic imports +
  // stable topological sort), hoisted BEFORE any side-effecting phase: a
  // broken composition root (dup name, missing/self dep, cycle) now aborts
  // before security plugins or the DB-touching app plugins run. Hoisting
  // also lets module-shipped `errorMappers` merge into the error handler,
  // which registers at phase 6 — long before the old resolution point
  // inside registerResources. Thunks fire exactly once, here.
  const resolvedModules = orderModules(
    await Promise.all((config.modules ?? []).map((m) => resolveModule(m))),
  );
  const moduleErrorMappers = resolvedModules.flatMap((m) => m.errorMappers ?? []);
  // Module readiness checks — collected in dependency order (fails on a
  // duplicate name across modules). Merged modules-first with the host's
  // app-level checks in registerArcPlugins; exposed on `fastify.arc` so the
  // worker probe (createWorker) gets the identical union.
  const moduleHealthChecks = collectModuleHealthChecks(resolvedModules);

  const resolvedLogger = resolveLoggerConfig(config.logger);

  const fastify: FastifyInstance = Fastify({
    logger: resolvedLogger,
    // Request-id resolution belongs at the SERVER level, not in a hook:
    // Fastify binds `request.log = logger.child({ reqId: request.id })` at
    // request construction, BEFORE any onRequest hook runs — an id assigned
    // in a hook never reaches the logs. `genReqId` adopts a sanitized
    // incoming `x-request-id` (≤128 chars, [\w.:-]) or generates a UUID;
    // the requestId plugin echoes it on the response header and handles
    // W3C trace-context propagation.
    genReqId: createRequestIdGenerator(),
    trustProxy: config.trustProxy ?? false,
    pluginTimeout: config.pluginTimeout ?? 10_000,
    // Honour an explicit override; Fastify's default (1 MiB) applies otherwise.
    ...(config.bodyLimit !== undefined ? { bodyLimit: config.bodyLimit } : {}),
    // Server timeout knobs — pass-throughs only. Arc deliberately ships no
    // defaults here: Node ≥18 already bounds slow-loris (headersTimeout
    // ~60s, requestTimeout 300s), and an opinionated requestTimeout would
    // 408 legitimate slow uploads while SSE/streaming responses are
    // unaffected either way. See the JSDoc on each option.
    ...(config.requestTimeout !== undefined ? { requestTimeout: config.requestTimeout } : {}),
    ...(config.connectionTimeout !== undefined
      ? { connectionTimeout: config.connectionTimeout }
      : {}),
    ...(config.keepAliveTimeout !== undefined ? { keepAliveTimeout: config.keepAliveTimeout } : {}),
    // Arc deliberately replaces Fastify 5's default error handler with the
    // canonical ErrorContract converter (see plugins/errorHandler.ts).
    // Fastify 5 emits FSTWRN004 when `setErrorHandler` runs in a scope
    // that already has one — true for our case because the default
    // handler counts as "set" at root. The value semantics are:
    //   - undefined / 'warn' (default) → allow + emit FSTWRN004
    //   - true                          → allow silently
    //   - false                         → throw FST_ERR_ERROR_HANDLER_ALREADY_SET
    // Pick `true`: the cross-cutting handler is the documented arc
    // contract, override is intentional, no need to bark at boot.
    allowErrorHandlerOverride: true,
    routerOptions: {
      querystringParser: (str: string) =>
        qs.parse(str, {
          depth: 5,
          parameterLimit: 100,
          arrayLimit: 20,
          allowPrototypes: false,
        }),
      // 2.16 — Fastify 5.8+ moved maxParamLength under `routerOptions`
      // (the top-level option is deprecated, emits FSTDEP022). Default 400
      // overrides Fastify's stock 100 so modern signed-token URLs
      // (HMAC, magic-link, JWT-in-URL, OAuth state) route correctly
      // without per-host wiring.
      maxParamLength: config.maxParamLength ?? 400,
    },
    ajv: {
      customOptions: {
        coerceTypes: true,
        useDefaults: true,
        removeAdditional: false,
        // Disable Ajv `strictTypes` because mongokit (and other kits) emit
        // `additionalProperties: true` WITHOUT `type: 'object'` for
        // `Schema.Types.Mixed` fields. That's deliberate: a `Mixed` field
        // accepts ANY JS value (string, number, boolean, object, array,
        // null), so adding `type: 'object'` would reject valid primitives
        // at AJV validation. See `mongokit/src/utils/mongooseToJsonSchema.ts`
        // line 481-487 for the rationale. Strict mode flags this combo
        // and pollutes boot logs even though the schemas validate
        // correctly. Other strict-mode signals (`strict`, `strictSchema`,
        // `strictNumbers`, `strictRequired`) stay on by Ajv default.
        strictTypes: false,
        keywords: ["example", ...(config.ajv?.keywords ?? [])],
      },
    },
  });

  // Route arc's internal logger (`arcLog`) through the host's pino instance
  // so framework warnings inherit the app's transports, level, AND redaction
  // — the console fallback bypassed all three. `logger: false` keeps the
  // console fallback: silent apps still surface arc warnings somewhere.
  // Last-created app wins the (global) writer; hosts that need a custom
  // writer call `configureArcLogger({ writer })` AFTER createApp.
  if (resolvedLogger !== false) {
    configureArcLogger({
      ...(options.debug !== undefined && options.debug !== false ? { debug: options.debug } : {}),
      writer: createPinoWriter(fastify.log),
    });
  }

  for (const warning of deferredWarnings) {
    fastify.log.warn(warning);
  }

  if (inheritedTrustProxyDefault) {
    fastify.log.warn(
      "[arc] preset: 'production' now defaults to trustProxy: false (fail-closed; " +
        "was true before 2.24). If this app runs behind a load balancer or reverse " +
        "proxy, request.ip is currently the PROXY's address — rate-limit keys collapse " +
        "onto one bucket and audit logs record the wrong client. Set trustProxy " +
        "explicitly: a hop count (trustProxy: 1), a CIDR allow-list ('10.0.0.0/8'), " +
        "a resolver function, or false if clients truly connect directly.",
    );
  }

  // NOTE: arc deliberately does NOT swap Fastify's validator compiler for
  // TypeBoxValidatorCompiler. TypeBox v1 is for schema construction +
  // compile-time inference; Fastify's standard AJV pipeline owns runtime
  // request validation and serialization for EVERY route (plain JSON Schema,
  // Zod-converted, and TypeBox schemas alike). Fastify already accepts the
  // JSON Schema that `Type.*` produces — no global provider switch, so
  // validation/coercion/property-stripping defaults stay consistent. Use
  // `@fastify/type-provider-typebox`'s `FastifyPluginAsyncTypebox` only at
  // typed plugin/route boundaries for inference. See src/schemas/index.ts.

  // Fix empty JSON body on DELETE/GET requests.
  // Some clients send Content-Type: application/json with no body on DELETE/GET.
  // Fastify's default parser rejects this (FST_ERR_CTP_EMPTY_JSON_BODY).
  // `parseJsonBody` treats empty bodies as undefined, keeps Fastify's
  // prototype-poisoning protection (secure-json-parse), and decorates parse
  // failures with `statusCode: 400` — Fastify forwards parser errors to the
  // error handler verbatim, so an undecorated SyntaxError would surface as a
  // 500 `arc.internal_error` for client-sent bad JSON.
  fastify.removeContentTypeParser("application/json");
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req: FastifyRequest, body: string, done: (err: Error | null, body?: unknown) => void) => {
      try {
        done(null, parseJsonBody(body));
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
  // Note: `trackPlugin` is only invoked AFTER `registerArcCore` has registered
  // arcCorePlugin, so `fastify.arc` is always present at call time. The
  // declaration is optional (see arcCorePlugin.ts) so we narrow explicitly.
  const trackPlugin = (name: string, opts?: Record<string, unknown>) => {
    const arc = fastify.arc;
    if (!arc) return;
    arc.plugins.set(name, {
      name,
      options: opts,
      registeredAt: new Date().toISOString(),
    });
  };

  const arcModules = await registerArcCore(fastify, config, trackPlugin);

  // Expose the (dependency-ordered, frozen) module health checks on arc so the
  // worker probe can reuse the identical union. arcCorePlugin ran inside
  // registerArcCore, so `fastify.arc` is present here.
  if (fastify.arc) {
    fastify.arc.healthChecks = Object.freeze([...moduleHealthChecks]);
    // Expose the dependency-ordered module definitions so integrations can
    // collect their own arm at init time (e.g. streamline → collectModuleWorkflows).
    fastify.arc.moduleDefinitions = Object.freeze([...resolvedModules]);
  }

  // ── 5. Arc plugins (opt-in) ──
  await registerArcPlugins(fastify, config, trackPlugin, arcModules, moduleHealthChecks);

  // ── 6. Auth (scope + strategy + elevation + error handler) ──
  decorateRequestScope(fastify);
  await registerAuth(fastify, config, trackPlugin);
  await registerElevation(fastify, config, trackPlugin);
  await registerErrorHandler(fastify, config, trackPlugin, moduleErrorMappers);

  // ── 7–11. Resources lifecycle (plugins → bootstrap → resources → after → hooks) ──
  await registerResources(fastify, config, resolvedModules);

  // ── Reply helpers (opt-in) ──
  if (config.replyHelpers) {
    const { replyHelpersPlugin } = await import("../plugins/replyHelpers.js");
    await fastify.register(replyHelpersPlugin);
  }

  // ── BigInt serialization (opt-in) ──
  //
  // Modes (see `CreateAppConfig.serializeBigInt` JSDoc for full rationale):
  //   - 'string' — lossless, recommended for IDs / money / counters
  //   - 'number' — lossy above MAX_SAFE_INTEGER; ONLY for bounded ranges
  //   - true     — back-compat alias for 'number'; emits warn (slated for removal)
  //   - false / unset — no hook; JSON.stringify throws on bigint (default)
  if (config.serializeBigInt) {
    const mode: "number" | "string" = config.serializeBigInt === "string" ? "string" : "number";

    if (config.serializeBigInt === true) {
      arcLog("createApp").warn(
        "serializeBigInt: true is a back-compat alias for 'number' (lossy above " +
          "Number.MAX_SAFE_INTEGER = 9007199254740991). For IDs / money / counters / " +
          "ledger values use serializeBigInt: 'string' (lossless). The boolean form " +
          "will be removed in a future major.",
      );
    } else if (mode === "number") {
      arcLog("createApp").warn(
        "serializeBigInt: 'number' loses precision above Number.MAX_SAFE_INTEGER " +
          "(9007199254740991). Use 'string' instead unless you've audited that no " +
          "bigint payload field can exceed the safe range.",
      );
    }

    fastify.addHook("preSerialization", async (_request, _reply, payload) => {
      if (payload === null || payload === undefined) return payload;
      // JSON.stringify with a replacer walks nested values once; we
      // re-parse to hand Fastify a plain object/array tree (some
      // serializer plugins inspect the value before final stringify).
      try {
        return JSON.parse(
          JSON.stringify(payload, (_key, value) =>
            typeof value === "bigint"
              ? mode === "string"
                ? value.toString()
                : Number(value)
              : value,
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
