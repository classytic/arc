/**
 * Idempotency — duplicate-request protection for mutations.
 *
 * AUTH ORDER MATTERS: `idempotency.middleware` must run AFTER authentication
 * in the preHandler chain, so the fingerprint includes the real caller and a
 * key cannot replay another user's response. `createCrudRouter` wires this for
 * mutation routes; custom routes do it themselves:
 * `preHandler: [fastify.authenticate, fastify.idempotency.middleware]`.
 *
 * GUARANTEE — best-effort effectively-once, NOT exactly-once. A distributed
 * lock makes concurrent same-key requests 409, the key includes the caller's
 * scope, a different body under one key is refused, and a completed result
 * replays. The business effect is not exactly-once, because
 * the domain write and the idempotency record are different systems:
 * - a crash after the DB write but before the record (preSerialization) lets a
 *   retry re-execute;
 * - a handler outrunning `lockTimeoutMs` can overlap its own retry — size that
 *   above the slowest protected handler.
 *
 * Where re-execution is unacceptable: write the record in the SAME transaction
 * as the business write (the store contract is exported), or make the handler
 * naturally idempotent (upsert, compare-and-set).
 */

import { createHash } from "node:crypto";
import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { ARC_ERROR_CODES, type ErrorContract } from "@classytic/repo-core/errors";
import { fingerprintRequest, IdempotencyError } from "@classytic/repo-core/idempotency";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { createDomainError } from "../utils/errors.js";
import { requireSingleHeaderValue } from "../utils/headers.js";
import { operationIdentity as scopedOperationIdentity } from "../utils/operationIdentity.js";
import { repositoryAsIdempotencyStore } from "./repository-idempotency-adapter.js";
import {
  declaresIdempotencyFence,
  idempotencyConfigProblem,
  type RouteIdempotencyConfig,
  requestDedupedByHandler,
  requestRequiresIdempotencyKey,
} from "./requirement.js";
import type { IdempotencyResult, IdempotencyStore } from "./stores/interface.js";
import { createIdempotencyResult } from "./stores/interface.js";
import { MemoryIdempotencyStore } from "./stores/memory.js";

export interface IdempotencyPluginOptions {
  /** Enable idempotency (default: false) */
  enabled?: boolean;
  /** Header name for idempotency key (default: 'idempotency-key') */
  headerName?: string;
  /** TTL for cached responses in ms (default: 86400000 = 24h) */
  ttlMs?: number;
  /** Lock timeout in ms (default: 30000 = 30s) */
  lockTimeoutMs?: number;
  /**
   * HTTP methods a key is honoured on when the route does not declare `config.idempotency`
   * (default: ['POST', 'PUT', 'PATCH']). A route declaring `required: true` is fenced whatever
   * its method — DELETE included — and whatever `include` / `exclude` say.
   */
  methods?: string[];
  /** URL patterns to include (regex). If set, only matching URLs use idempotency */
  include?: RegExp[];
  /** URL patterns to exclude (regex). Excluded patterns take precedence */
  exclude?: RegExp[];
  /**
   * Repository managing the idempotency collection. Arc consumes it directly
   * — no wrapper classes. Requires `getOne`, `deleteMany`, and
   * `findOneAndUpdate` (mongokit ≥3.8 implements all three). Pass any
   * `RepositoryLike` that matches.
   *
   * Use `store` (below) when your backend isn't a repository (Redis, memory
   * for tests, custom). `repository` takes precedence when both are passed.
   */
  repository?: RepositoryLike;
  /**
   * Non-repository store. Use for Redis (the canonical multi-instance
   * backend when you don't already have a DB repository), memory (tests),
   * or custom implementations of `IdempotencyStore`.
   *
   * Default: `MemoryIdempotencyStore`.
   */
  store?: IdempotencyStore;
  /** Retry-After header value in seconds when request is in-flight (default: 1) */
  retryAfterSeconds?: number;
  /**
   * Namespace key folded into the fingerprint — use when two deployments share
   * a single store but should not replay each other's responses (e.g. `api`
   * vs `jobs` with the same Redis, or prod vs canary sharing one cluster).
   *
   * Omit for the common case where the store is per-deployment.
   */
  namespace?: string;
  /**
   * Boot-time store self-check (default: true). Writes one probe entry,
   * verifies it reads back under ITS OWN key and NOT under a different key,
   * then deletes it. Registration THROWS if the store fails — because the
   * failure mode this catches is silent and catastrophic: a repository
   * whose schema strips the key filter (observed live: a pathless Mongoose
   * schema under `strictQuery: true`) collapses every idempotency key onto
   * one shared row, and every request then replays the most recent cached
   * response across keys AND across users. A store that cannot round-trip
   * a key must never be allowed to serve traffic.
   *
   * Disable only for a store that genuinely cannot accept a probe write at
   * boot — and if you disable it, the adapter's per-read identity checks
   * remain as the runtime backstop.
   */
  selfCheck?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The idempotency key for this request (if present) */
    idempotencyKey?: string;
    /** Whether this response was replayed from cache */
    idempotencyReplayed?: boolean;
    /** @internal The operation's storage key */
    _idempotencyFullKey?: string;
    /** @internal `fingerprintRequest` of this request's body, stored with its response */
    _idempotencyFingerprint?: string;
  }

  interface FastifyContextConfig {
    /**
     * Per-route idempotency. `required: true` (or, on an action route, `requiredActions`
     * naming the `body.action` values) refuses a call with no idempotency key (400
     * `arc.idempotency_key_required`) and dedupes a keyed one, on any method. Boot refuses the
     * declaration when nothing would enforce it: the plugin disabled, or the route's
     * `preHandler` lacking `fastify.idempotency.middleware`.
     */
    idempotency?: RouteIdempotencyConfig;
  }

  interface FastifyInstance {
    /** Idempotency utilities */
    idempotency: {
      /** Manually invalidate an idempotency key */
      invalidate: (key: string) => Promise<void>;
      /** Check if a key has a cached response */
      has: (key: string) => Promise<boolean>;
      /**
       * Route-level preHandler for idempotency check + lock.
       * Wire AFTER authenticate in the preHandler chain so that
       * `request.user` is populated before the fingerprint is computed.
       *
       * `createCrudRouter` injects this automatically for mutation routes.
       * For custom routes, add it manually:
       * ```typescript
       * fastify.post('/orders', {
       *   preHandler: [fastify.authenticate, fastify.idempotency.middleware],
       * }, handler);
       * ```
       */
      middleware: (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<undefined | FastifyReply>;
      /**
       * The resolved backing store. Exposed so non-HTTP executors (MCP
       * tools via `mcpPlugin`'s execution wiring, jobs, workflows) can run
       * the same check → lock → execute → record protocol against the same
       * backend. `undefined` when the plugin is disabled.
       */
      store?: import("./stores/interface.js").IdempotencyStore;
    };
  }
}

const HEADER_IDEMPOTENCY_REPLAYED = "x-idempotency-replayed";
const HEADER_IDEMPOTENCY_KEY = "x-idempotency-key";

const idempotencyPlugin: FastifyPluginAsync<IdempotencyPluginOptions> = async (
  fastify: FastifyInstance,
  opts: IdempotencyPluginOptions = {},
) => {
  const {
    enabled = false,
    headerName = "idempotency-key",
    ttlMs = 86400000, // 24 hours
    lockTimeoutMs = 30000, // 30 seconds
    methods = ["POST", "PUT", "PATCH"],
    include,
    exclude,
    repository,
    store: explicitStore,
    retryAfterSeconds = 1,
    namespace,
    selfCheck = true,
  } = opts;

  // Resolve the store:
  //   1. If `repository` is passed → consume it directly (inline adapter).
  //   2. Else if `store` is passed → use it.
  //   3. Else default to MemoryIdempotencyStore for dev/tests.
  const store: IdempotencyStore = repository
    ? repositoryAsIdempotencyStore(repository, ttlMs)
    : (explicitStore ?? new MemoryIdempotencyStore({ ttlMs }));
  /**
   * Who owns the store's lifecycle — arc closes ONLY what arc built.
   *
   * A host-supplied `store` may outlive this app: two arc apps in one process
   * (a documented topology) can share one, and `MemoryIdempotencyStore.close()`
   * CLEARS its maps. Closing on the first app's shutdown therefore wiped the
   * second app's live idempotency records — replayable requests silently
   * became re-executable. A store handed in from outside is the host's to
   * close. The same rule now applies to the events transport and the
   * query-cache store, which had the identical defect.
   *
   * The `repository` path builds its own adapter here, so arc owns that
   * wrapper — but the adapter has no `close`, and the underlying repository
   * (host-owned) is never touched.
   */
  const ownsStore = !explicitStore;

  // ── Boot-time store self-check — falsify the store before it serves ──
  //
  // Round-trip probe: a store that cannot (a) return a written entry under
  // its own key, and (b) return NOTHING under a different key, will
  // silently replay cached responses across keys and users in production.
  // That exact failure was observed live (filter-stripping repository —
  // see IdempotencyStoreMisconfiguredError) and produced "success"
  // responses for operations that never executed.
  //
  // TWO OUTCOMES, DELIBERATELY NOT COLLAPSED:
  //
  //   - a CORRECTNESS violation (the probe proved the store ignores the key
  //     filter) is deterministic, a pure function of schema/config, and
  //     catastrophic in production → REFUSE TO BOOT;
  //   - an AVAILABILITY failure (the probe could not complete — connection
  //     not ready, timeout, permissions) says nothing about key filtering →
  //     WARN and continue.
  //
  // Collapsing them was a real fault in the first cut of this check, caught
  // on the very next boot: a mongoose connection that dropped mid-boot made
  // the probe read return nothing, and the plugin killed the whole app while
  // reporting "the store is not persisting or not filtering by key" — a
  // false diagnosis AND a new hard dependency of BOOT on DB availability
  // that this plugin never had before (it previously touched the store only
  // on the first keyed request). A liveness problem is the app's own
  // health-check to own; it must not be laundered into a correctness verdict.
  //
  // Continuing on an availability failure is safe because it is not the last
  // line of defense: `repositoryAsIdempotencyStore` verifies key identity on
  // EVERY read at runtime and throws `IdempotencyStoreMisconfiguredError`
  // rather than serving a cross-key row. The boot check exists to convert
  // that runtime refusal into an earlier, louder, deployment-time one — not
  // to be the only thing standing between a bad schema and a replayed
  // response.
  if (enabled && selfCheck) {
    const probeSuffix = createHash("sha256")
      .update(`${process.pid}:${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 12);
    const probeKeyA = `__arc_idempotency_selfcheck__:${probeSuffix}:a`;
    const probeKeyB = `__arc_idempotency_selfcheck__:${probeSuffix}:b`;
    /** Correctness verdicts rethrow; everything else degrades to a warning. */
    class SelfCheckViolation extends Error {}
    try {
      await store.set(probeKeyA, createIdempotencyResult(299, { probe: true }, {}, 60_000));
      const own = await store.get(probeKeyA);
      // NOTE: a missing/incorrect own-key read is AMBIGUOUS — an unreachable
      // store looks identical to a non-persisting one from here — so it is
      // deliberately NOT a violation. The unambiguous signal is the foreign
      // read below.
      if (own?.statusCode !== 299) {
        fastify.log?.warn?.(
          { probe: "own-key" },
          "idempotencyPlugin self-check: probe entry did not read back under its own key. " +
            "This is usually the store being unreachable at boot (connection not ready), not a " +
            "misconfiguration — continuing, with the adapter's per-read key-identity checks as the " +
            "runtime backstop. If keyed requests later fail with IDEMPOTENCY_STORE_MISCONFIGURED, " +
            "the store's key filter is being stripped (see IdempotencyStoreMisconfiguredError).",
        );
      } else {
        // Only meaningful once the own-key read PROVED the probe is stored:
        // otherwise a foreign miss is trivially satisfied by an empty store.
        const foreign = await store.get(probeKeyB);
        if (foreign) {
          throw new SelfCheckViolation(
            "idempotencyPlugin self-check: a probe read under key B returned key A's entry — the store " +
              "is ignoring the key filter, which in production replays cached responses across keys and " +
              "users (observed cause: a pathless Mongoose schema under strictQuery:true strips every " +
              "filter to {}). Declare the key path on the schema (e.g. _id: String) and set " +
              "strictQuery: false in the schema options.",
          );
        }
      }
    } catch (err) {
      // A cross-key hit detected by the ADAPTER surfaces as
      // IdempotencyStoreMisconfiguredError from `set`/`get` above — same
      // verdict, different messenger. Matched structurally (by `code`) so a
      // custom store can report it without importing arc's class.
      const isMisconfiguration =
        err instanceof SelfCheckViolation ||
        (err as { code?: string } | null)?.code === "IDEMPOTENCY_STORE_MISCONFIGURED";
      if (isMisconfiguration) throw err;
      fastify.log?.warn?.(
        { err },
        "idempotencyPlugin self-check could not complete (store unreachable at boot?) — continuing. " +
          "The adapter's per-read key-identity checks remain the runtime backstop.",
      );
    } finally {
      // Best-effort cleanup — must never mask the actual check result.
      //
      // Scoped to THIS boot's probe keys, deliberately. Sweeping the whole
      // reserved prefix looks tidier (it would also collect residue from an
      // interrupted earlier boot) but it deletes probes belonging to OTHER
      // replicas booting at the same moment: a rolling deploy has several
      // starting against one shared store, and a replica whose probe is
      // swept between its `set` and its `get` observes "did not read back
      // under its own key" and refuses to boot. The self-check would take
      // down the deployment it exists to protect. Residue is not a problem
      // worth that: probes carry a 60s TTL and `get` already filters expired
      // entries, so an interrupted boot's leftovers age out on their own.
      await store.deleteByPrefix(`__arc_idempotency_selfcheck__:${probeSuffix}:`).catch(() => {});
    }
  }

  // Skip if not enabled — but never let a route believe it is fenced.
  if (!enabled) {
    fastify.addHook("onRoute", (route) => {
      if (!declaresIdempotencyFence(route.config)) return;
      throw new Error(
        `[arc] ${String(route.method)} ${route.url} declares config.idempotency.required, but the ` +
          "idempotency plugin is disabled — its key would be accepted and never deduplicated. " +
          "Enable idempotencyPlugin({ enabled: true }) or drop the declaration.",
      );
    });
    // Provide no-op utilities
    fastify.decorate("idempotency", {
      invalidate: async () => {},
      has: async () => false,
      middleware: async () => {},
      // No store when disabled — MCP wiring reads this and skips
      // idempotent execution rather than half-working against a store
      // the HTTP surface isn't using.
      store: undefined,
    });
    fastify.decorateRequest("idempotencyKey", undefined);
    fastify.decorateRequest("idempotencyReplayed", false);
    fastify.decorateRequest("_idempotencyFullKey", undefined);
    fastify.decorateRequest("_idempotencyFingerprint", undefined);
    fastify.log?.debug?.("Idempotency plugin disabled");
    return;
  }

  const methodSet = new Set(methods.map((m) => m.toUpperCase()));

  fastify.decorateRequest("idempotencyKey", undefined);
  fastify.decorateRequest("idempotencyReplayed", false);
  fastify.decorateRequest("_idempotencyFullKey", undefined);
  fastify.decorateRequest("_idempotencyFingerprint", undefined);

  /**
   * Check if this request should use idempotency
   */
  function shouldApplyIdempotency(request: FastifyRequest): boolean {
    // A route that declares the fence is fenced — specific beats the plugin-wide defaults.
    if (requestRequiresIdempotencyKey(request)) return true;

    // Check method
    if (!methodSet.has(request.method)) {
      return false;
    }

    const url = request.url;

    // Check exclusions first (take precedence)
    if (exclude?.some((pattern) => pattern.test(url))) {
      return false;
    }

    // Check inclusions (if specified, only matching URLs apply)
    if (include && !include.some((pattern) => pattern.test(url))) {
      return false;
    }

    return true;
  }

  /**
   * The OPERATION this key names — namespace, method, URL and caller. The body is NOT part of
   * it: the same key with a different body is the same operation asked twice, which is refused
   * (see `bodyFingerprint`), never executed again under a fresh storage key.
   *
   * Must run AFTER auth has populated `request.user`, or every caller shares `anon`.
   */
  function operationIdentity(request: FastifyRequest): string {
    const user = request.user as { id?: string; _id?: string } | undefined;
    return scopedOperationIdentity(
      `${request.method}:${request.url}`,
      request.scope,
      user?.id ?? user?._id,
      namespace,
    );
  }

  /**
   * `fingerprintRequest` from `@classytic/repo-core/idempotency` — the ONE body fingerprint
   * every layer uses. A body too deep to fingerprint is refused, not truncated.
   */
  function bodyFingerprint(request: FastifyRequest): string {
    try {
      return fingerprintRequest(request.body ?? null);
    } catch (err) {
      if (err instanceof IdempotencyError && err.code === "UNFINGERPRINTABLE") {
        throw createDomainError(
          ARC_ERROR_CODES.IDEMPOTENCY_BODY_UNFINGERPRINTABLE,
          err.message,
          400,
        );
      }
      throw err;
    }
  }

  function replay(
    request: FastifyRequest,
    reply: FastifyReply,
    cached: IdempotencyResult,
    fingerprint: string,
  ): void {
    if (cached.requestFingerprint && cached.requestFingerprint !== fingerprint) {
      throw createDomainError(
        ARC_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        `Idempotency key '${request.idempotencyKey}' was already used for a different request body. Use a new key for a new request.`,
        422,
      );
    }
    request.idempotencyReplayed = true;
    reply.header(HEADER_IDEMPOTENCY_REPLAYED, "true");
    reply.header(HEADER_IDEMPOTENCY_KEY, request.idempotencyKey);
    for (const [key, value] of Object.entries(cached.headers)) {
      if (!key.startsWith("x-idempotency")) reply.header(key, value);
    }
    reply
      .code(cached.statusCode)
      .send(
        cached.bodyEncoding === "base64" && typeof cached.body === "string"
          ? Buffer.from(cached.body, "base64")
          : cached.body,
      );
  }

  // ---- Route-level middleware: check + lock (AFTER auth) ----
  const idempotencyMiddleware = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<undefined | FastifyReply> => {
    // Get idempotency key from header
    const keyHeader = requireSingleHeaderValue(request.headers, headerName);
    const idempotencyKey = keyHeader?.trim();

    // A route that declares `config.idempotency.required` refuses a keyless call — a retry
    // of it would execute twice.
    if (!idempotencyKey && requestRequiresIdempotencyKey(request)) {
      throw createDomainError(
        ARC_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
        `This operation requires an '${headerName}' header, stable across retries of the same request.`,
        400,
      );
    }

    if (requestDedupedByHandler(request)) {
      if (idempotencyKey) request.idempotencyKey = idempotencyKey;
      return;
    }

    if (!shouldApplyIdempotency(request)) {
      return;
    }

    if (!idempotencyKey) {
      // No key provided - proceed normally
      return;
    }

    // Store key on request for later use
    request.idempotencyKey = idempotencyKey;

    // The operation's storage key (user is now populated by auth) and the body it carries.
    const fullKey = `${idempotencyKey}:${operationIdentity(request)}`;
    const requestFingerprint = bodyFingerprint(request);

    // Check for cached result
    const cached = await store.get(fullKey);
    if (cached) {
      replay(request, reply, cached, requestFingerprint);
      return reply;
    }

    // Try to acquire lock
    const lockAcquired = await store.tryLock(fullKey, request.id, lockTimeoutMs);
    if (!lockAcquired) {
      // Another request is processing this key
      reply
        .code(409)
        .header("Retry-After", retryAfterSeconds.toString())
        .send({
          code: ARC_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          message: "Request with this idempotency key is already in progress",
          status: 409,
          meta: { retryAfter: retryAfterSeconds },
        } satisfies ErrorContract);
      return reply;
    }

    // Store full key for preSerialization (body cache) + onResponse (unlock)
    request._idempotencyFullKey = fullKey;
    request._idempotencyFingerprint = requestFingerprint;

    // A previous holder can finish between our first read and acquiring the lock.
    // Recheck under ownership before allowing either an execution or a changed-body retry.
    try {
      const completed = await store.get(fullKey);
      if (completed) {
        await store.unlock(fullKey, request.id);
        request._idempotencyFullKey = undefined;
        replay(request, reply, completed, requestFingerprint);
        return reply;
      }
    } catch (err) {
      await store.unlock(fullKey, request.id);
      request._idempotencyFullKey = undefined;
      throw err;
    }

    // Echo the idempotency key on the response. Set here in the middleware —
    // NOT in a later hook — so it survives empty 2xx responses (204,
    // reply.send() with no body) where preSerialization is skipped by
    // Fastify. Route is already confirmed to use idempotency since we
    // reached this point.
    reply.header(HEADER_IDEMPOTENCY_KEY, idempotencyKey);
  };

  // A route that declares the fence must actually run it — a host route registered without the
  // middleware would accept the key and execute every retry.
  fastify.addHook("onRoute", (route) => {
    const problem = idempotencyConfigProblem(route.config);
    if (problem) {
      throw new Error(
        `[arc] ${String(route.method)} ${route.url}: config.idempotency: ${problem}.`,
      );
    }
    if (!declaresIdempotencyFence(route.config)) return;
    const preHandlers = Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler];
    if (preHandlers.includes(idempotencyMiddleware)) return;
    throw new Error(
      `[arc] ${String(route.method)} ${route.url} declares config.idempotency.required but its ` +
        "preHandler does not run fastify.idempotency.middleware, so a retry would execute twice. " +
        "Add it after authentication: preHandler: [fastify.authenticate, fastify.idempotency.middleware].",
    );
  });

  // Decorate with utilities + middleware
  fastify.decorate("idempotency", {
    invalidate: async (key: string) => {
      // Delete all entries for this raw idempotency key regardless of fingerprint
      await store.deleteByPrefix(`${key}:`);
    },
    has: async (key: string) => {
      // Check if any entry exists for this raw idempotency key
      const result = await store.findByPrefix(`${key}:`);
      return !!result;
    },
    middleware: idempotencyMiddleware,
    // Shared backend for non-HTTP executors (MCP tools, jobs) — same
    // store, same TTL/lock semantics, different fingerprint namespace.
    store,
  });

  // Object responses record before serialization; skipped response shapes record in onSend.
  // Header writes stay in the middleware. Completion precedes flush; onResponse releases locks.
  const recordedResponses = new WeakSet<FastifyRequest>();
  async function recordResponse(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    binary = false,
  ): Promise<void> {
    // Replayed responses don't hold a lock and don't need re-caching.
    if (request.idempotencyReplayed || recordedResponses.has(request)) return;

    const fullKey = request._idempotencyFullKey;
    if (!fullKey) return;

    // Only cache successful responses (2xx). Non-2xx still unlocks —
    // handled by onResponse below.
    const statusCode = reply.statusCode;
    if (statusCode < 200 || statusCode >= 300) return;

    // Extract headers to cache (exclude connection / per-hop / date / cookies)
    const headersToCache: Record<string, string> = {};
    const excludeHeaders = new Set([
      "content-length",
      "transfer-encoding",
      "connection",
      "keep-alive",
      "date",
      "set-cookie",
    ]);

    const rawHeaders = reply.getHeaders();
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (!excludeHeaders.has(key.toLowerCase()) && typeof value === "string") {
        headersToCache[key] = value;
      }
    }

    const body = binary && Buffer.isBuffer(payload) ? payload.toString("base64") : payload;

    const result = createIdempotencyResult(
      statusCode,
      body,
      headersToCache,
      ttlMs,
      request._idempotencyFingerprint,
    );
    await store.set(fullKey, { ...result, ...(binary ? { bodyEncoding: "base64" as const } : {}) });
    recordedResponses.add(request);
  }
  fastify.addHook("preSerialization", async (request, reply, payload) => {
    await recordResponse(request, reply, payload);
    return payload;
  });

  // Fastify skips preSerialization for empty, string and binary responses. No headers are
  // changed here: completion must be persisted before the response flush and lock release.
  fastify.addHook("onSend", async (request, reply, payload) => {
    if (
      !request._idempotencyFullKey ||
      request.idempotencyReplayed ||
      recordedResponses.has(request) ||
      reply.statusCode < 200 ||
      reply.statusCode >= 300
    )
      return payload;
    if (
      payload !== null &&
      payload !== undefined &&
      typeof payload !== "string" &&
      !Buffer.isBuffer(payload)
    ) {
      throw new Error(
        "[arc idempotency] Streaming responses require config.idempotency.dedup: 'handler' and a domain-owned completion record.",
      );
    }
    await recordResponse(request, reply, payload, Buffer.isBuffer(payload));
    return payload;
  });

  // Universal unlock — fires for EVERY response after flush, regardless of:
  //   - status code (2xx / 4xx / 5xx)
  //   - body presence (empty 204s, status-only replies, streamed bodies)
  //   - error path (after onError runs — that hook used to be the backup
  //     for error cases but is now subsumed by this one)
  //
  // Running after flush means no header-race risk. Running for every path
  // means no silent lock leaks (the bug class that prompted the 2.10.2
  // re-cut). `store.unlock` is expected to be idempotent per the store
  // contract, so the handful of paths that previously called unlock from
  // both onError + onSend are safely collapsed here.
  fastify.addHook("onResponse", async (request) => {
    // Replays never acquired a lock.
    if (request.idempotencyReplayed) return;
    const fullKey = request._idempotencyFullKey;
    if (!fullKey) return;
    await store.unlock(fullKey, request.id);
  });

  // Cleanup on close — only for a store arc constructed. See `ownsStore`.
  fastify.addHook("onClose", async () => {
    if (ownsStore) await store.close?.();
  });

  fastify.log?.debug?.({ headerName, ttlMs, methods }, "Idempotency plugin enabled");
};

export default fp(idempotencyPlugin, {
  name: "arc-idempotency",
  fastify: "5.x",
});

export { idempotencyPlugin };
