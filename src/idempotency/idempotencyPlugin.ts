/**
 * Idempotency Plugin
 *
 * Duplicate request protection for mutating operations.
 * Uses idempotency keys to ensure safe retries.
 *
 * ## Auth Safety
 *
 * The idempotency check runs as a **route-level middleware**
 * (`idempotency.middleware`) that must be wired AFTER authentication in the
 * preHandler chain. This ensures the fingerprint includes the real caller
 * identity, preventing cross-user replay attacks.
 *
 * Arc's `createCrudRouter` does this automatically for mutation routes.
 * For custom routes, wire it manually:
 *
 * ```typescript
 * fastify.post('/orders', {
 *   preHandler: [fastify.authenticate, fastify.idempotency.middleware],
 * }, handler);
 * ```
 *
 * @example
 * import { idempotencyPlugin } from '@classytic/arc/idempotency';
 *
 * await fastify.register(idempotencyPlugin, {
 *   enabled: true,
 *   headerName: 'idempotency-key',
 *   ttlMs: 86400000, // 24 hours
 * });
 *
 * // Client sends:
 * // POST /api/orders
 * // Idempotency-Key: order-123-abc
 *
 * // If same key sent again within TTL, returns cached response
 */

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { RepositoryLike } from "../adapters/interface.js";
import { isReplyCommitted } from "../utils/reply-guards.js";
import { repositoryAsIdempotencyStore } from "./repository-idempotency-adapter.js";
import type { IdempotencyStore } from "./stores/interface.js";
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
  /** HTTP methods to apply idempotency to (default: ['POST', 'PUT', 'PATCH']) */
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
}

declare module "fastify" {
  interface FastifyRequest {
    /** The idempotency key for this request (if present) */
    idempotencyKey?: string;
    /** Whether this response was replayed from cache */
    idempotencyReplayed?: boolean;
    /** @internal Full key with fingerprint for store lookups */
    _idempotencyFullKey?: string;
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
      middleware: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
  } = opts;

  // Resolve the store:
  //   1. If `repository` is passed → consume it directly (inline adapter).
  //   2. Else if `store` is passed → use it.
  //   3. Else default to MemoryIdempotencyStore for dev/tests.
  const store: IdempotencyStore = repository
    ? repositoryAsIdempotencyStore(repository, ttlMs)
    : (explicitStore ?? new MemoryIdempotencyStore({ ttlMs }));

  // Skip if not enabled
  if (!enabled) {
    // Provide no-op utilities
    fastify.decorate("idempotency", {
      invalidate: async () => {},
      has: async () => false,
      middleware: async () => {},
    });
    fastify.decorateRequest("idempotencyKey", undefined);
    fastify.decorateRequest("idempotencyReplayed", false);
    fastify.log?.debug?.("Idempotency plugin disabled");
    return;
  }

  const methodSet = new Set(methods.map((m) => m.toUpperCase()));

  fastify.decorateRequest("idempotencyKey", undefined);
  fastify.decorateRequest("idempotencyReplayed", false);

  /**
   * Check if this request should use idempotency
   */
  function shouldApplyIdempotency(request: FastifyRequest): boolean {
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
   * Normalize body for consistent hashing (sort keys recursively)
   */
  function normalizeBody(obj: unknown): unknown {
    if (obj === null || typeof obj !== "object") {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(normalizeBody);
    }

    // Sort object keys
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      sorted[key] = normalizeBody((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  /**
   * Generate a fingerprint for the request (for key generation).
   * Includes caller identity so the same idempotency key from different
   * users doesn't replay one user's response to another.
   *
   * IMPORTANT: This must be called AFTER auth has populated request.user,
   * otherwise userId falls back to 'anon' and cross-user replay is possible.
   */
  function getRequestFingerprint(request: FastifyRequest): string {
    // Combine method + URL + body hash + user identity for uniqueness
    let bodyHash = "nobody";

    if (request.body && typeof request.body === "object") {
      // Normalize body (sort keys) for consistent hashing
      const normalized = normalizeBody(request.body);
      const bodyString = JSON.stringify(normalized);
      bodyHash = createHash("sha256").update(bodyString).digest("hex").substring(0, 16);
      // SECURITY: Only log hash, never log full body (can contain secrets)
      if (request.log?.debug) {
        request.log.debug({ bodyHash }, "Generated body hash");
      }
    }

    // Scope to caller identity to prevent cross-user replay
    const user = request.user as { id?: string; _id?: string } | undefined;
    const userId = user?.id ?? user?._id ?? "anon";

    // Namespace prefix prevents cross-deployment collisions on a shared store
    // (prod vs canary, api vs jobs, etc.) without adding a second store layer.
    const namespacePart = namespace ? `n=${namespace}:` : "";
    const fingerprint = `${namespacePart}${request.method}:${request.url}:${bodyHash}:u=${userId}`;
    return fingerprint;
  }

  // ---- Route-level middleware: check + lock (AFTER auth) ----
  const idempotencyMiddleware = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!shouldApplyIdempotency(request)) {
      return;
    }

    // Get idempotency key from header
    const keyHeader = request.headers[headerName.toLowerCase()];
    const idempotencyKey = typeof keyHeader === "string" ? keyHeader.trim() : undefined;

    if (!idempotencyKey) {
      // No key provided - proceed normally
      return;
    }

    // Store key on request for later use
    request.idempotencyKey = idempotencyKey;

    // Create full key with request fingerprint (user is now populated by auth)
    const fullKey = `${idempotencyKey}:${getRequestFingerprint(request)}`;

    // Check for cached result
    const cached = await store.get(fullKey);
    if (cached) {
      // Replay cached response
      request.idempotencyReplayed = true;

      // Set response headers
      reply.header(HEADER_IDEMPOTENCY_REPLAYED, "true");
      reply.header(HEADER_IDEMPOTENCY_KEY, idempotencyKey);

      // Replay original headers
      for (const [key, value] of Object.entries(cached.headers)) {
        if (!key.startsWith("x-idempotency")) {
          reply.header(key, value);
        }
      }

      reply.code(cached.statusCode).send(cached.body);
      return;
    }

    // Try to acquire lock
    const lockAcquired = await store.tryLock(fullKey, request.id, lockTimeoutMs);
    if (!lockAcquired) {
      // Another request is processing this key
      reply.code(409).header("Retry-After", retryAfterSeconds.toString()).send({
        error: "Request with this idempotency key is already in progress",
        code: "IDEMPOTENCY_CONFLICT",
        retryAfter: retryAfterSeconds,
      });
      return;
    }

    // Store full key for onSend hook
    request._idempotencyFullKey = fullKey;
  };

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
  });

  // Store response after successful request
  fastify.addHook("onSend", async (request, reply, payload) => {
    // Skip if this was a replayed response
    if (request.idempotencyReplayed) {
      return payload;
    }

    const fullKey = request._idempotencyFullKey;
    if (!fullKey) {
      return payload;
    }

    // Guard: if headers are already committed (test-harness race), we can
    // still update the idempotency store (side-effect matters), but skip
    // the reply.header() mutation at the end to avoid ERR_HTTP_HEADERS_SENT.
    const committed = isReplyCommitted(reply);

    // Only cache successful responses (2xx)
    const statusCode = reply.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      // Unlock without caching
      await store.unlock(fullKey, request.id);
      return payload;
    }

    // Extract headers to cache (exclude certain headers)
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

    // Parse body if it's a string
    let body: unknown;
    try {
      body = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch {
      body = payload;
    }

    // Store the result
    const result = createIdempotencyResult(statusCode, body, headersToCache, ttlMs);
    await store.set(fullKey, result);

    // Unlock (result is now cached)
    await store.unlock(fullKey, request.id);

    // Add idempotency key header to response (skip when reply already
    // committed to avoid ERR_HTTP_HEADERS_SENT under light-my-request)
    if (!committed) {
      reply.header(HEADER_IDEMPOTENCY_KEY, request.idempotencyKey);
    }

    return payload;
  });

  // Handle errors - ensure lock is released
  fastify.addHook("onError", async (request) => {
    const fullKey = request._idempotencyFullKey;
    if (fullKey) {
      await store.unlock(fullKey, request.id);
    }
  });

  // Cleanup on close
  fastify.addHook("onClose", async () => {
    await store.close?.();
  });

  fastify.log?.debug?.({ headerName, ttlMs, methods }, "Idempotency plugin enabled");
};

export default fp(idempotencyPlugin, {
  name: "arc-idempotency",
  fastify: "5.x",
});

export { idempotencyPlugin };
