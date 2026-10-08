/**
 * ArcFactory - Production-ready Fastify application factory.
 *
 * Security plugins are opt-out, not opt-in. Arc is database-agnostic: connect
 * your database separately and pass adapters to `defineResource`.
 *
 * @example
 * const app = await createApp({
 *   preset: 'production',
 *   runtime: 'memory',
 *   auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
 *   resources: [productResource, orderResource],
 * });
 */

import { readEnv } from "@classytic/primitives/environment";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
  type RawServerDefault,
} from "fastify";
import qs from "qs";
import { arcAjvCustomOptions, markArcRootValidator } from "../core/routeValidator.js";
import {
  type ArcLoggerOptions,
  arcLog,
  configureArcLogger,
  createPinoWriter,
  runWithArcLogger,
} from "../logger/index.js";
import { enterArcLoggerScope } from "../logger/scope.js";
import { createRequestIdGenerator } from "../plugins/requestId.js";
import { parseJsonBody } from "../utils/jsonBody.js";
import {
  auditRuntimeCapabilities,
  initRuntimeCapabilityRegistry,
} from "../utils/runtimeCapabilities.js";
import { registerAssetRoots } from "./assets.js";
import { collectModuleHealthChecks } from "./module/index.js";
import { composeModules } from "./module/plan.js";
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

/**
 * The fail-loud switches — ON by default — and what each one costs when a deployment turns it OFF.
 * Reported together at production boot, so an opt-out is never silent.
 */
const STRICT_ENV_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ["ARC_STRICT_PERMISSIONS", "An ungated write route warns instead of failing boot."],
  ["ARC_STRICT_QUERY_PARAMS", "An unknown filter key is DROPPED, which WIDENS the read."],
  ["ARC_STRICT_IMMUTABLE_WRITES", "A PATCH of an immutable field returns 200, unchanged."],
];

// ── Constants ──

const MEMORY_STORE_NAMES = new Set(["memory", "memory-cache"]);

/**
 * Default pino redact paths (auth/cookie/API-key headers, nested
 * password/token/secret fields), applied only when the host supplies no
 * `logger.redact`. Opt out with `logger: { redact: [] }`; an explicit
 * `redact` always wins.
 */
export const DEFAULT_LOGGER_REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  'req.headers["x-internal-api-key"]',
  'req.headers["x-device-token"]',
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
 * Resolve the host's `logger` option for Fastify, layering the default redact
 * paths unless it is `false` or an object with its own `redact`.
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

  const missing: Array<{ key: string; hint: string }> = [];

  const events = options.stores?.events;
  if (!events || MEMORY_STORE_NAMES.has(events.name)) {
    missing.push({ key: "stores.events", hint: "a Redis Streams or pub/sub transport" });
  }

  // An unnamed adapter (bare repo-core `CacheAdapter`) is treated as external.
  if (options.arcPlugins?.caching) {
    const cache = options.stores?.cache;
    if (!cache || (cache.name !== undefined && MEMORY_STORE_NAMES.has(cache.name))) {
      missing.push({ key: "stores.cache", hint: "a Redis-backed cache adapter" });
    }
  }

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

  if (options.arcPlugins?.queryCache) {
    const qc = options.stores?.queryCache;
    if (!qc || (qc.name !== undefined && MEMORY_STORE_NAMES.has(qc.name))) {
      missing.push({ key: "stores.queryCache", hint: "a Redis-backed query-cache adapter" });
    }
  }

  // Schedules without a lock — EVERY replica fires EVERY tick (duplicate
  // invoices, charges). A hard failure like the stores, not a warning; a
  // deliberate single-node topology declares `singleReplica: true`.
  const schedules = options.arcPlugins?.schedules;
  if (
    schedules &&
    typeof schedules === "object" &&
    schedules.enabled !== false &&
    !schedules.lock &&
    !schedules.singleReplica
  ) {
    missing.push({
      key: "arcPlugins.schedules.lock",
      hint:
        "a LockAdapter for single-firer leases (e.g. createMongoLockAdapter) — " +
        "or `arcPlugins.schedules.singleReplica: true` if exactly one replica arms schedules",
    });
  }

  // Only what `createApp` can SEE is validated here; subsystems wired inside
  // `plugins()` / `bootstrap[]` are the host's checklist
  // (wiki/delivery-guarantees.md, "Distributed deployment checklist").

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
 *
 * **Boot is all-or-nothing.** If any phase throws, the partially-built
 * instance is closed before the error propagates — see the wrapper below.
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  /**
   * TOPOLOGY is declared, never guessed: a second replica on the in-memory runtime silently
   * loses cross-instance events and caches.
   */
  if (options.preset === "production" && options.runtime === undefined) {
    throw new Error(
      "createApp: preset 'production' requires an explicit `runtime` — 'memory' for a single " +
        "instance, 'distributed' before running a second replica (it requires shared stores and is " +
        "audited at boot).",
    );
  }

  /**
   * A relay/scheduler process declaring HTTP resources is a wiring error —
   * mounting routes anyway would hide the misdeployment behind a working endpoint.
   */
  const declaredRole = options.role ?? "all";
  if (
    (declaredRole === "relay" || declaredRole === "scheduler") &&
    (options.resources !== undefined || options.resourceDir !== undefined)
  ) {
    throw new Error(
      `createApp: role '${declaredRole}' declares HTTP resources — a ${declaredRole} ` +
        "process must not serve routes. Remove `resources`/`resourceDir`, or change the role.",
    );
  }

  /**
   * This app's own `arcLog` config, entered for the WHOLE boot. Held by
   * reference and mutated in `buildApp` once `fastify.log` exists — a copy
   * would send post-construction boot warnings to the console. Per-app so two
   * apps in one process keep separate writers.
   */
  const loggerScope: ArcLoggerOptions = {};
  if (options.debug !== undefined && options.debug !== false) {
    loggerScope.debug = options.debug;
  }

  // The instance escapes `buildApp` the moment Fastify constructs it, so a
  // throw from ANY later phase still has something to close.
  let partial: FastifyInstance | undefined;
  let disposeBoot: (() => Promise<void>) | undefined;
  try {
    return await runWithArcLogger(loggerScope, () =>
      buildApp(
        options,
        loggerScope,
        (instance) => {
          partial = instance;
        },
        (dispose) => {
          disposeBoot = dispose;
        },
      ),
    );
  } catch (err) {
    // ── Failed-boot cleanup ── a rejected `createApp` hands the caller no
    // instance to close, so release the half-built app's signal listeners and
    // sockets here. Module closers are once-guarded, so no double-close.
    // Best-effort: cleanup failures are logged; the ORIGINAL error is thrown.
    if (partial) {
      try {
        await partial.close();
      } catch (closeErr) {
        partial.log?.error?.(
          { err: closeErr },
          "[arc] cleanup of a partially-booted app failed; original boot error follows",
        );
      }
    }
    // Once-guarded: a no-op if `partial.close()` already ran it; the only
    // release path if boot failed before Fastify existed.
    if (disposeBoot) {
      try {
        await disposeBoot();
      } catch (disposeErr) {
        arcLog("createApp").error(
          "beforeBoot disposer failed during failed-boot cleanup; original boot error follows",
          disposeErr,
        );
      }
    }
    throw err;
  }
}

async function buildApp(
  options: CreateAppOptions,
  /** This app's live arcLog config — mutated below once `fastify.log` exists. */
  loggerScope: ArcLoggerOptions,
  onInstance: (instance: FastifyInstance) => void,
  onBootDisposer: (dispose: () => Promise<void>) => void,
): Promise<FastifyInstance> {
  // ── 0. Validation ──

  validateAuthOptions(options);
  const deferredWarnings = validateDistributedRuntime(options);

  // ── 0.5 Pre-boot hook — after validation, before Fastify, module resolution
  // or resource imports. See `CreateAppOptions.beforeBoot`.
  let disposeBoot: (() => Promise<void>) | undefined;
  if (options.beforeBoot) {
    const dispose = await options.beforeBoot();
    if (typeof dispose === "function") {
      let once: Promise<void> | undefined;
      disposeBoot = () => {
        once ??= Promise.resolve().then(dispose);
        return once;
      };
      onBootDisposer(disposeBoot);
    }
  }

  // ── 1. Merge preset + create Fastify ──

  const presetConfig = options.preset ? getPreset(options.preset) : {};
  const config: CreateAppOptions = { ...presetConfig, ...options };

  // Production defaults `trustProxy: false` (fail closed). Behind an LB that
  // makes `request.ip` the LB's address, so warn when the host inherited the
  // default without deciding; any explicit `trustProxy` silences it.
  const inheritedTrustProxyDefault =
    options.preset === "production" && options.trustProxy === undefined;

  /**
   * A NUMERIC `trustProxy` trusts NOTHING on Fastify >= 5.12.1 (hop-count
   * trust fails closed upstream), so the host silently gets the proxy's IP.
   * Warn rather than refuse — a boot failure on a transitive bump is harsher.
   */
  const numericTrustProxy = typeof config.trustProxy === "number";

  // ── 1.5 Resolve + order the module graph BEFORE any side-effecting phase,
  // so a broken composition aborts early and module `errorMappers` reach the
  // error handler (phase 6). Thunks fire exactly once, here. Bridges whose
  // domains are not all composed drop out silently (a deployment choice).
  // Every unmet `requires` (ports, presence-only modules) fails here, in one error.
  const { modules: resolvedModules, skipped: skippedBridges } = await composeModules(
    config.modules ?? [],
    config.ports,
  );
  const moduleErrorMappers = resolvedModules.flatMap((m) => m.errorMappers ?? []);
  // Also exposed on `fastify.arc` so the worker probe gets the identical union.
  const moduleHealthChecks = collectModuleHealthChecks(resolvedModules);

  const resolvedLogger = resolveLoggerConfig(config.logger);

  const fastify: FastifyInstance = Fastify<RawServerDefault>({
    logger: resolvedLogger,
    // Server-level, not a hook: `request.log` binds `reqId` at request
    // construction, before any onRequest hook — a hook-assigned id never
    // reaches the logs.
    genReqId: createRequestIdGenerator(),
    trustProxy: config.trustProxy ?? false,
    pluginTimeout: config.pluginTimeout ?? 10_000,
    ...(config.bodyLimit !== undefined ? { bodyLimit: config.bodyLimit } : {}),
    // Pass-throughs only — no arc defaults: Node already bounds slow-loris,
    // and an opinionated requestTimeout would 408 legitimate slow uploads.
    ...(config.requestTimeout !== undefined ? { requestTimeout: config.requestTimeout } : {}),
    ...(config.connectionTimeout !== undefined
      ? { connectionTimeout: config.connectionTimeout }
      : {}),
    ...(config.keepAliveTimeout !== undefined ? { keepAliveTimeout: config.keepAliveTimeout } : {}),
    // Arc intentionally replaces the default error handler; `true` silences
    // Fastify's FSTWRN004 for that override.
    allowErrorHandlerOverride: true,
    routerOptions: {
      querystringParser: (str: string) =>
        qs.parse(str, {
          depth: 5,
          parameterLimit: 100,
          arrayLimit: 20,
          allowPrototypes: false,
        }),
      // Must live under `routerOptions` (top-level is deprecated). Raised
      // above Fastify's stock default so signed-token URLs route.
      maxParamLength: config.maxParamLength ?? 400,
    },
    // The same options arc compiles its own routes with on a bare host (see routeValidator.ts).
    ajv: { customOptions: arcAjvCustomOptions(config.ajv?.keywords) },
  });
  markArcRootValidator(fastify);

  // Publish IMMEDIATELY so a later throw still has an instance to close.
  onInstance(fastify);
  // Registered first on the root, so it runs after every plugin's onClose —
  // whatever `beforeBoot` opened outlives everything that used it.
  if (disposeBoot) fastify.addHook("onClose", disposeBoot);

  // Seed on the ROOT before anything declares: children read through the
  // prototype chain, so encapsulated declarations reach this audit.
  initRuntimeCapabilityRegistry(fastify);

  // Route `arcLog` through the host's pino (transports, level, redaction),
  // on THIS APP's scope so co-resident apps keep their own writer.
  // `logger: false` keeps the console fallback.
  if (resolvedLogger !== false) {
    const writer = createPinoWriter(fastify.log);
    loggerScope.writer = writer;
    // Also seed the (last-app-wins) process fallback for arc code running
    // outside any app scope.
    configureArcLogger({
      ...(options.debug !== undefined && options.debug !== false ? { debug: options.debug } : {}),
      writer,
    });
  }

  // Carry the scope across the request lifecycle.
  fastify.addHook("onRequest", (_request, _reply, done) => {
    enterArcLoggerScope(loggerScope, done);
  });

  for (const warning of deferredWarnings) {
    fastify.log.warn(warning);
  }

  if (numericTrustProxy) {
    fastify.log.warn(
      `[arc] trustProxy: ${String(config.trustProxy)} (a hop COUNT) trusts nothing on ` +
        "Fastify >= 5.12.1 — hop-count trust cannot validate the immediate peer, so it " +
        "fails closed upstream to stop clients spoofing X-Forwarded-* with padded hops. " +
        "`request.ip` is therefore the PROXY's address: rate-limit keys collapse onto one " +
        "bucket and audit rows record the wrong client. Name the proxies instead — " +
        "trustProxy: 'loopback', '10.0.0.0/8', a comma-separated list, or `true` if every " +
        "upstream hop is genuinely trusted.",
    );
  }

  if (inheritedTrustProxyDefault) {
    fastify.log.warn(
      "[arc] preset: 'production' defaults to trustProxy: false (fail-closed). If this " +
        "app runs behind a load balancer or reverse proxy, request.ip is currently the " +
        "PROXY's address — rate-limit keys collapse onto one bucket and audit logs record " +
        "the wrong client. Set trustProxy explicitly: the proxies' addresses ('loopback', " +
        "'10.0.0.0/8', a comma-separated list), a resolver function, or false if clients " +
        "truly connect directly. A hop count trusts nothing on Fastify >= 5.12.1.",
    );
  }

  /**
   * Production names every fail-loud switch turned OFF. They are read before `createApp`, so this
   * reports rather than sets.
   */
  if (config.preset === "production") {
    const env = readEnv(process.env);
    const off = STRICT_ENV_FLAGS.filter(([name]) => !env.bool(name, true));
    if (off.length > 0) {
      fastify.log.warn(
        `[arc] preset: 'production' with fail-loud turned OFF: ${off.map(([n]) => n).join(", ")}. ` +
          `${off.map(([, what]) => what).join(" ")} ` +
          "They default ON; unset them to restore enforcement. Per-resource options still override.",
      );
    }
  }

  // Arc deliberately keeps Fastify's AJV validator compiler (no TypeBox
  // compiler swap) so every schema flavour validates identically. See
  // src/schemas/index.ts.

  // Accept `application/json` with an empty body (DELETE/GET clients). Parse
  // errors carry `statusCode: 400`, else bad client JSON would surface as 500.
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

  // ── 2.5 Static asset roots ──
  // AFTER security: helmet sets its headers in an `onRequest` hook while
  // `@fastify/static`'s `setHeaders` runs at send time, so the per-prefix
  // Cross-Origin-Resource-Policy override wins over the app-wide default.
  if (config.assets?.length) {
    await registerAssetRoots(fastify, config.assets);
  }

  // ── 3. Utility plugins ──
  await registerUtilityPlugins(fastify, config);

  // ── 4. Arc core + events ──
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

  if (fastify.arc) {
    fastify.arc.healthChecks = Object.freeze([...moduleHealthChecks]);
    // Integrations collect their own arm from these (e.g. collectModuleWorkflows).
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
  await registerResources(fastify, config, resolvedModules, skippedBridges);

  // ── Reply helpers (opt-in) ──
  if (config.replyHelpers) {
    const { replyHelpersPlugin } = await import("../plugins/replyHelpers.js");
    await fastify.register(replyHelpersPlugin);
  }

  // ── BigInt serialization (opt-in; modes documented on `serializeBigInt`) ──
  if (config.serializeBigInt) {
    const mode = config.serializeBigInt;

    if (mode === "number") {
      arcLog("createApp").warn(
        "serializeBigInt: 'number' loses precision above Number.MAX_SAFE_INTEGER " +
          "(9007199254740991). Use 'string' instead unless you've audited that no " +
          "bigint payload field can exceed the safe range.",
      );
    }

    fastify.addHook("preSerialization", async (_request, _reply, payload) => {
      if (payload === null || payload === undefined) return payload;
      // Re-parse: some serializer plugins inspect the value before stringify.
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
  // Capability audit LAST, after every declarant — it validates what hosts
  // actually wired, not just what createApp received.
  auditRuntimeCapabilities(fastify, config.runtime ?? "memory");

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
