/**
 * `CreateAppOptions` — the full configuration surface of `createApp()`:
 * environment, stores, auth, security, arc plugins, resources, lifecycle.
 */

import type { FastifyInstance, FastifyServerOptions } from "fastify";
import type { CacheStore } from "../../cache/interface.js";
import type { EventTransport } from "../../events/EventTransport.js";
import type { IdempotencyStore } from "../../idempotency/stores/interface.js";
import type { ElevationOptions } from "../../scope/elevation.js";
import type { AssetRoot } from "./assets.js";
import type { AuthOption } from "./auth.js";
import type { MultipartOptions, RawBodyOptions, UnderPressureOptions } from "./plugin-options.js";
import type { CorsOptions, HelmetOptions, RateLimitOpts } from "./security.js";

/**
 * Configuration for `createApp()`.
 *
 * @example
 * ```typescript
 * const app = await createApp({
 *   preset: 'production',
 *   auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
 *   resources: [productResource],
 * });
 * ```
 */
export interface CreateAppOptions {
  // ============================================
  // Environment & Logging
  // ============================================

  /** Environment preset: 'production', 'development', 'testing', 'edge', or 'worker' */
  preset?: "production" | "development" | "testing" | "edge" | "worker";

  /**
   * Route-mounting switch (2.23) — the worker-role primitive. `false`
   * registers every resource's shared runtime state (registry metadata +
   * adapter, hooks, cache-invalidation rules) WITHOUT mounting any routes,
   * so headless processes keep tenant-purge cascade, per-resource audit,
   * and events metadata intact. Set by `preset: 'worker'` /
   * `createWorker()`; hosts composing a custom worker shape may set it
   * directly. Default: true (routes mount).
   */
  mountRoutes?: boolean;

  /**
   * Runtime profile for store backends.
   * - 'memory' (default): Uses in-memory stores. Suitable for single-instance deployments.
   * - 'distributed': Requires durable adapters for events, and for any enabled
   *   shared subsystems such as caching/queryCache/rate limiting.
   *   Idempotency remains per-resource opt-in: memory-backed stores are rejected,
   *   while a missing idempotency store emits a startup warning because dedupe
   *   would be instance-local.
   */
  runtime?: "memory" | "distributed";

  /**
   * Deployment ROLE of this process (topology plan, Phase 2). Decides which
   * async machinery mounts; default `'all'` is the single-process case and
   * changes nothing.
   *
   * - `'api'` / `'worker'` — no module schedule arms run here (the outbox
   *   relay arm included); a worker fleet or scheduler deployment owns them.
   *   Register `jobsPlugin({ mode })` to match ('api' → 'producer').
   * - `'relay'` — ONLY `kind: 'relay'` schedule arms run (the outbox
   *   relays); declaring HTTP `resources` is boot-fatal.
   * - `'scheduler'` — every schedule arm runs; HTTP resources boot-fatal.
   * - `'all'` — everything (default).
   *
   * A skipped arm is logged by name at boot so a misdeployed process is
   * legible from its first lines.
   *
   * `createWorker` is the paved road for headless processes and forwards
   * this option untouched — one axis, not two mechanisms. Its default stays
   * `'all'` (its 2.23 contract: the headless process runs everything
   * non-HTTP); pass `role: 'worker'` there when a dedicated scheduler/relay
   * deployment owns the arms.
   */
  role?: "api" | "worker" | "relay" | "scheduler" | "all";

  /**
   * Store and transport instances for runtime profile validation.
   * When `runtime` is `'distributed'`, Arc validates that these are
   * not memory-backed. Provide Redis or other durable adapters.
   */
  stores?: {
    /** Event transport (e.g., RedisEventTransport) */
    events?: EventTransport;
    /** Cache store (e.g., RedisCacheStore) */
    cache?: CacheStore;
    /** Idempotency store (e.g., RedisIdempotencyStore) */
    idempotency?: IdempotencyStore;
    /** QueryCache store (e.g., RedisCacheStore). Default: MemoryCacheStore. */
    queryCache?: CacheStore;
  };

  /** Fastify logger configuration */
  logger?: FastifyServerOptions["logger"];

  /**
   * Enable Arc debug logging.
   *
   * - `true` — all Arc modules
   * - `string` — comma-separated module names (e.g., `'scope,elevation,sse'`)
   * - `false` or omit — disabled (default)
   *
   * Also configurable via `ARC_DEBUG` environment variable.
   *
   * @example
   * ```typescript
   * // All modules
   * const app = await createApp({ debug: true });
   *
   * // Specific modules
   * const app = await createApp({ debug: 'scope,elevation' });
   * ```
   */
  debug?: boolean | string;

  /**
   * Trust proxy headers (X-Forwarded-For, etc.). Pass-through to Fastify's
   * `trustProxy` server option — all its forms are supported, not just the
   * boolean:
   *
   * - `true` — trust ALL proxies (only safe when the app is never directly
   *   reachable; a spoofed `X-Forwarded-For` otherwise forges `request.ip`,
   *   which feeds rate-limit keys and audit logs)
   * - `1` — trust exactly one hop (typical single LB / reverse proxy)
   * - `'10.0.0.0/8'` / `['10.0.0.0/8', '172.16.0.0/12']` — trust only these
   *   CIDR ranges
   *
   * Default: `false` everywhere, including `preset: 'production'` (2.24
   * flip — fail-closed; the preset previously trusted every proxy). Apps
   * behind a proxy/LB must set this explicitly or `request.ip` is the
   * proxy's address; a boot warning fires when the production preset's
   * default is inherited without an explicit choice.
   *
   * ⚠ **A hop COUNT is no longer accepted.** Fastify 5.12.1 removed `number`
   * from this option and made hop-count trust fail closed, because it cannot
   * validate the immediate peer — a direct client could spoof `X-Forwarded-*`
   * simply by supplying enough hops. Name the proxies instead; arc warns at
   * boot if a number reaches it from untyped (JavaScript) config.
   *
   * @example
   * ```ts
   * createApp({ preset: 'production', trustProxy: 'loopback' });    // local proxy
   * createApp({ preset: 'production', trustProxy: '10.0.0.0/8' });  // VPC proxies
   * createApp({ preset: 'production', trustProxy: true });          // every hop trusted
   * ```
   */
  trustProxy?: boolean | string | string[];

  /** Fastify plugin/onReady timeout in ms (default: 10_000). Raise for slow boot work (index materialisation, WAL replay, external warm-up). */
  pluginTimeout?: number;

  /**
   * Max time in ms the server waits to RECEIVE an entire request
   * (headers + body). Pass-through to Fastify's `requestTimeout` (Node's
   * `server.requestTimeout`). Default `0` defers to Node's own 300s bound
   * — slow-loris requests are already cut off there, so arc doesn't
   * override; tighten (e.g. `30_000`) for APIs that never accept slow
   * uploads. Response duration (SSE, streaming) is NOT affected.
   */
  requestTimeout?: number;

  /**
   * Connection-establishment timeout in ms (Fastify `connectionTimeout`).
   * Default `0` = unbounded; Node's ~60s `headersTimeout` still caps idle
   * pre-request sockets.
   */
  connectionTimeout?: number;

  /**
   * Keep-alive idle timeout in ms (default 72_000). MUST exceed the idle
   * timeout of any LB in front (ALB default 60s), or the LB reuses sockets
   * the server just closed — intermittent 502s.
   */
  keepAliveTimeout?: number;

  /**
   * Max JSON body in bytes. Fastify default 1 MiB; over it is a 413
   * (`FST_ERR_CTP_BODY_TOO_LARGE`) raised BEFORE any handler runs.
   * Multipart uploads are bounded separately by `multipart.limits.fileSize`.
   */
  bodyLimit?: number;
  /**
   * Max characters in one URL path param. Arc defaults to 400; Fastify's own
   * 100 silently 404s signed-token URLs (HMAC ~250 chars, JWT, OAuth state).
   * Raise to ~1024 for long JWTs.
   */
  maxParamLength?: number;

  // ============================================
  // Authentication (New Clean API)
  // ============================================

  /**
   * Auth configuration, or `false` to disable entirely. Each strategy is a
   * discriminated union on `type` (`'jwt'` | `'better-auth'` | custom); see
   * [[auth]] for the strategy matrix and `authenticate` override.
   */
  auth?: AuthOption;

  // ============================================
  // Elevation (opt-in)
  // ============================================

  /**
   * Platform admin elevation — opt-in for apps with superadmins.
   *
   * When configured, platform admins can explicitly elevate their scope
   * by sending `x-arc-scope: platform` header. Without this header,
   * superadmins are treated as normal users.
   *
   * Set to `false` or omit to disable elevation entirely.
   *
   * @example
   * ```typescript
   * elevation: {
   *   platformRoles: ['superadmin'],
   *   onElevation: (event) => auditLog.write({
   *     action: 'platform_elevation',
   *     userId: event.userId,
   *     targetOrg: event.organizationId,
   *   }),
   * }
   * ```
   */
  elevation?: ElevationOptions | false;

  // ============================================
  // Security Plugins (opt-out)
  // ============================================

  /** Helmet security headers. Set to false to disable. */
  helmet?: HelmetOptions | false;

  /** CORS configuration. Set to false to disable. */
  cors?: CorsOptions | false;

  /** Rate limiting. Set to false to disable. */
  rateLimit?: RateLimitOpts | false;

  /**
   * Static asset roots, each served by its own `@fastify/static` registration.
   *
   * Arc supplies POLICY (per-prefix `Cross-Origin-Resource-Policy`, cache preset,
   * `Content-Disposition`) and delegates every transport mechanic — byte ranges,
   * ETag/304, immutable directives, pre-compressed variants — to the plugin.
   *
   * ```ts
   * assets: [{ prefix: "/uploads", root: "./var/uploads", crossOrigin: "same-site" }]
   * ```
   *
   * **Why this exists:** arc's default security headers include
   * `Cross-Origin-Resource-Policy: same-origin`, which makes a browser discard the
   * response when a cross-origin document tries to embed it — even though the
   * request returned 200 and CORS negotiated fine. A frontend on a different
   * origin cannot render an uploaded image until CORP is relaxed for that prefix.
   * Requires `@fastify/static`.
   */
  assets?: readonly AssetRoot[];

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

  /** Enable Arc plugins (requestId, health, gracefulShutdown, events, caching, sse) */
  arcPlugins?: {
    /** Request ID tracking (default: true) */
    requestId?: boolean;
    /**
     * Health endpoints (default: true).
     *
     * Three forms:
     *   - `true` (default) — register Arc's health plugin with no extra checks
     *     (`/_health/live` always 200, `/_health/ready` 200 unless explicit
     *     readiness probes are added later).
     *   - `false` — disable Arc's health plugin entirely; the host registers
     *     its own (or none).
     *   - `{ checks: HealthCheck[] }` — register Arc's health plugin AND
     *     attach the supplied readiness probes (Mongo connectivity, engine
     *     warmup, queue connectivity, etc.). Closes the pre-2.15.1 hole
     *     where adding checks meant `health: false` + manual re-registration.
     *
     * @example
     * ```typescript
     * arcPlugins: {
     *   health: {
     *     checks: [
     *       { name: 'mongo', check: async () => mongoose.connection.readyState === 1 },
     *       { name: 'catalog-engine', check: async () => catalog.isReady() },
     *     ],
     *   },
     * }
     * ```
     */
    health?: boolean | import("../../plugins/health.js").HealthOptions;
    /** Graceful shutdown handling (default: true) */
    gracefulShutdown?: boolean;
    /** Emit events for CRUD operations (default: true) */
    emitEvents?: boolean;
    /**
     * Event plugin configuration. Default: true (enabled with MemoryEventTransport).
     * Set to false to disable event plugin registration entirely.
     * Set to true for defaults (memory transport), or pass EventPluginOptions for fine control.
     * Transport is sourced from `stores.events` if provided, otherwise defaults to memory.
     *
     * When enabled, registers `eventPlugin` which provides `fastify.events` for
     * pub/sub. Combined with `emitEvents: true`, CRUD operations automatically
     * emit domain events (e.g., `product.created`, `order.updated`).
     *
     * @example
     * ```typescript
     * // Memory transport (default)
     * const app = await createApp({ arcPlugins: { events: true } });
     *
     * // With retry and logging
     * const app = await createApp({
     *   stores: { events: new RedisEventTransport({ url: 'redis://...' }) },
     *   arcPlugins: {
     *     events: {
     *       logEvents: true,
     *       retry: { maxRetries: 3, backoffMs: 1000 },
     *     },
     *   },
     * });
     * ```
     */
    events?: Omit<import("../../events/eventPlugin.js").EventPluginOptions, "transport"> | boolean;
    /**
     * Runtime options for module-contributed `scheduledJobs`. Module schedules
     * automatically use Arc's existing schedules plugin. Pass lock/holder
     * options for multi-replica safety, `true` for single-instance defaults,
     * or `false` to reject any module that declares schedules.
     *
     * `enabled: false` registers the scheduler as a NO-OP — the host's runtime
     * kill switch (e.g. an ops instance that must run zero background work
     * against a shared DB). Unlike `schedules: false`, it does NOT reject
     * modules that declare schedules; they are collected but never armed.
     */
    schedules?:
      | Omit<import("../../plugins/schedules.js").SchedulesPluginOptions, "schedules">
      | boolean;
    /**
     * Caching headers (ETag + Cache-Control). Default: false (opt-in).
     * Set to true for defaults, or pass CachingOptions for fine control.
     */
    caching?: import("../../plugins/caching.js").CachingOptions | boolean;
    /**
     * SSE event streaming. Default: false (opt-in).
     * Set to true for defaults, or pass SSEOptions for fine control.
     * Requires emitEvents to be enabled (or events plugin registered).
     */
    sse?: import("../../plugins/sse.js").SSEOptions | boolean;
    /**
     * Realtime resource change feed (2.22) — `GET /realtime/:resource`
     * streams that resource's created/updated/deleted events over SSE,
     * gated by its own `list` permission with per-event row filtering,
     * tenant scoping, and field-level masking. Default: false (opt-in).
     * Set true for defaults, or pass RealtimeOptions (path, heartbeat,
     * resource allowlist, operations). Requires events.
     */
    realtime?: import("../../plugins/realtime.js").RealtimeOptions | boolean;
    /**
     * QueryCache — TanStack Query-inspired server cache with SWR.
     * Default: false (opt-in). Set to true for memory store defaults.
     * Requires per-resource `cache` config on defineResource().
     */
    queryCache?: import("../../cache/queryCachePlugin.js").QueryCachePluginOptions | boolean;
    /**
     * Metrics endpoint (Prometheus-compatible). Default: false (opt-in).
     * Set to true for defaults (/_metrics), or pass MetricsOptions for custom path/prefix.
     */
    metrics?: import("../../plugins/metrics.js").MetricsOptions | boolean;
    /**
     * API versioning (header or prefix-based). Default: false (opt-in).
     * Pass VersioningOptions to enable.
     */
    versioning?: import("../../plugins/versioning.js").VersioningOptions;
  };

  /**
   * Error handler plugin. Normalizes AJV, Mongoose, and ArcError responses
   * into a consistent JSON envelope. Enabled by default.
   * Set to false to disable, or pass ErrorHandlerOptions for fine control.
   */
  errorHandler?: import("../../plugins/errorHandler.js").ErrorHandlerOptions | false;

  /**
   * Custom AJV keywords to allow in route schemas.
   *
   * Arc already allows `"example"` by default. Use this to add
   * additional non-standard keywords your query parsers or schema
   * generators may use (e.g., `x-internal` from MongoKit).
   *
   * @example
   * ```typescript
   * const app = await createApp({
   *   ajv: { keywords: ['x-internal'] },
   * });
   * ```
   */
  ajv?: {
    keywords?: string[];
  };

  /**
   * Enable `reply.sendList()` + `reply.stream()` response decorators.
   *
   * Arc emits raw data on success — HTTP status discriminates, no
   * `{ success, data }` envelope — so single-doc handlers just
   * `return doc` or `reply.send(doc)` and errors throw `ArcError`
   * (the global handler serializes to `ErrorContract`). The two
   * decorators below cover the cases that DO need framework support:
   *
   *   - `sendList(input)` normalises any kit-shaped paginated/array
   *     result to the canonical wire shape via repo-core's
   *     `toCanonicalList` so the server and `@classytic/arc-next`
   *     typed client share one declaration.
   *   - `stream(source, options)` sets `Content-Type` /
   *     `Content-Disposition` headers for file downloads in one call.
   *
   * Default: `false` (opt-in).
   *
   * @example
   * ```typescript
   * const app = await createApp({ replyHelpers: true });
   *
   * // List endpoint — kit-shaped pagination → canonical wire shape
   * app.get('/orders', async (req, reply) => {
   *   const result = await orderRepo.getAll(req.query);
   *   return reply.sendList(result);
   * });
   *
   * // File download
   * app.get('/orders/export.csv', async (req, reply) => {
   *   return reply.stream(csvReadable, {
   *     contentType: 'text/csv',
   *     filename: 'orders.csv',
   *   });
   * });
   * ```
   */
  replyHelpers?: boolean;

  /**
   * Serialize `bigint` in JSON responses — `JSON.stringify` throws on it.
   *
   * - `false` (default) — no conversion; a bigint reaching the wire throws.
   * - `'string'` — lossless decimal string. The choice for IDs, money,
   *   counters, ledgers. Clients reconstitute with `BigInt(value)`.
   * - `'number'` — LOSSY above `Number.MAX_SAFE_INTEGER` (2^53-1). Only for
   *   an audited, bounded range.
   */
  serializeBigInt?: boolean | "number" | "string";

  // ============================================
  // Resources & Lifecycle
  // ============================================

  /**
   * Domain modules — one entry per self-contained domain package.
   *
   * A `resources` entry is a route group; an `ArcModule` is a package's whole
   * contribution (engine init + resources + post-wiring), so the host stops
   * hand-threading pieces across `bootstrap` / `resources` / `afterResources`.
   * Modules expand into the SAME lifecycle phases in `dependsOn` order,
   * always before the app-level entry for that phase. See [[modules]].
   */
  modules?: ReadonlyArray<import("../module/index.js").ArcModuleInput>;

  /**
   * Resources to register. An ARRAY is resolved at module import, so every
   * adapter must be constructible synchronously. A FACTORY (sync or async,
   * receiving the Fastify instance) is resolved after `bootstrap[]` and before
   * routes are wired — the answer when an adapter depends on an engine that
   * boots asynchronously, since `defineResource()` then runs with that engine
   * already live. Boot order lives in CLAUDE.md; do not restate it here.
   *
   * @example
   * ```ts
   * resources: [productResource]                       // static
   * resources: async () => [defineResource({ ... })]   // engine-dependent
   * ```
   */
  resources?:
    | ReadonlyArray<import("../loadResources.js").ResourceLike>
    | ((
        fastify: FastifyInstance,
      ) =>
        | ReadonlyArray<import("../loadResources.js").ResourceLike>
        | Promise<ReadonlyArray<import("../loadResources.js").ResourceLike>>);

  /**
   * URL prefix for all auto-registered resources.
   * Applied only to resources in the `resources` array — not to `plugins()`.
   *
   * @example
   * ```ts
   * const app = await createApp({
   *   resourcePrefix: '/api/v1',
   *   resources: await loadResources(import.meta.url),
   * });
   * // product → /api/v1/products, order → /api/v1/orders
   * ```
   */
  resourcePrefix?: string;

  /**
   * Auto-discover resources from a directory instead of passing an explicit
   * `resources` array.
   *
   * Accepts either a filesystem path OR `import.meta.url` (a `file://` URL).
   * **Prefer the URL form in production** — bare strings resolve relative to
   * `process.cwd()`, which diverges from `dist/` at runtime and was the root
   * cause of a reported "deployed app serves 404 on every route" incident.
   *
   * When both `resourceDir` and `resources` are provided, `resources` wins —
   * explicit always beats convention, **including an explicit empty array**.
   * `resources: []` disables resource registration entirely even with
   * `resourceDir` set, which is the common case for shared base configs
   * that turn resource loading off in test / CLI / health-check subprocesses.
   * Auto-discovery from `resourceDir` fires only when `resources` is
   * `undefined` (absent).
   *
   * @example
   * ```ts
   * // Recommended (v2.10.9+): URL form works in both src/ and dist/
   * const app = await createApp({
   *   resourceDir: import.meta.url,
   *   resourcePrefix: '/api/v1',
   * });
   *
   * // String form — resolves against process.cwd(), mind the dist/ gap
   * const app = await createApp({
   *   resourceDir: 'src/resources',
   * });
   * ```
   */
  resourceDir?: string;

  /**
   * Throw instead of silently booting with zero resources when `resourceDir`
   * yields an empty result. Off by default to preserve back-compat — turning
   * it on in production catches the "typoed path / stale dist/ layout"
   * failure mode before the app accepts traffic.
   *
   * Only takes effect when `resourceDir` is set.
   *
   * @example
   * ```ts
   * await createApp({
   *   resourceDir: import.meta.url,
   *   strictResourceDir: process.env.NODE_ENV === 'production',
   * });
   * ```
   *
   * @default false
   */
  strictResourceDir?: boolean;

  /**
   * Throw instead of warn when two resources share the same `name`. Off by
   * default to preserve back-compat; turn on in production to catch stale
   * `dist/` files (a common source of `Mongoose model already exists`
   * collisions downstream of arc's own registry).
   *
   * @example
   * ```ts
   * await createApp({
   *   resources: await loadResources(import.meta.url),
   *   strictResources: process.env.NODE_ENV === 'production',
   * });
   * ```
   *
   * @default false
   */
  strictResources?: boolean;

  /**
   * Pre-boot hook — awaited BEFORE arc does anything else: before the
   * Fastify instance exists, before module thunks resolve, before resource
   * discovery imports a single host file.
   *
   * The canonical slot for the DB connection and anything that
   * module-EVAL-time code depends on. Engines that register Mongoose models
   * at import time (top-level `createXEngine(...)`) trigger eager
   * `createIndex()` calls from schema plugins — if the connection isn't
   * open yet those buffer and die with `buffering timed out`. Hosts used to
   * hand-orchestrate this with `await connectDatabase()` + dynamic
   * `await import(...)` tricks before calling `createApp`; with `beforeBoot`
   * the ordering is arc's contract instead:
   *
   * ```ts
   * const app = await createApp({
   *   beforeBoot: async () => { await connectDatabase(); },
   *   modules: [() => import('#modules/accounting.js')], // thunks resolve AFTER beforeBoot
   *   resources: async () => [...],
   * });
   * ```
   *
   * Runs after option validation (config bugs fail fast without touching
   * the DB). Cleanup stays host-owned — pair with `onClose`.
   */
  beforeBoot?: () => void | Promise<void>;

  /**
   * Custom plugin registration — runs after Arc core (security, auth, events)
   * but before `bootstrap` and `resources`.
   *
   * Use this for infrastructure setup: database connections, OpenAPI data,
   * webhook plugins, SSE wiring, etc.
   */
  plugins?: (fastify: FastifyInstance) => Promise<void>;

  /**
   * Bootstrap functions — run after `plugins()` but before `resources`.
   *
   * Use this for domain initialization that needs infrastructure ready
   * (DB connected, events wired, Redis available) but must complete
   * before resources register (e.g., engine singletons, event handlers,
   * seed data, connection verification).
   *
   * Boot order:
   * ```
   * 1. Arc core (security, auth, events)
   * 2. plugins()      ← infra (DB, SSE, data)
   * 3. bootstrap[]    ← domain init (singletons, event handlers)
   * 4. resources[]    ← auto-discovered routes
   * ```
   *
   * @example
   * ```ts
   * const app = await createApp({
   *   plugins: async (f) => { await connectDB(); await f.register(docsPlugin); },
   *   bootstrap: [inventoryInit, accountingInit, loyaltyInit],
   *   resources: await loadResources(import.meta.url),
   * });
   * ```
   */
  bootstrap?: Array<(fastify: FastifyInstance) => void | Promise<void>>;

  /**
   * Hook called after resources are registered but before the app is ready.
   * Use for post-registration wiring (e.g., cross-resource event subscriptions).
   */
  afterResources?: (fastify: FastifyInstance) => void | Promise<void>;

  /** Hook called after all plugins are loaded and the app is ready */
  onReady?: (fastify: FastifyInstance) => void | Promise<void>;

  /** Hook called when the app is shutting down */
  onClose?: (fastify: FastifyInstance) => void | Promise<void>;
}
