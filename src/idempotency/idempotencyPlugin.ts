/**
 * Idempotency Plugin
 *
 * Duplicate request protection for mutating operations.
 * Uses idempotency keys to ensure safe retries.
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

import fp from 'fastify-plugin';
import { createHash } from 'crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { IdempotencyStore } from './stores/interface.js';
import { createIdempotencyResult } from './stores/interface.js';
import { MemoryIdempotencyStore } from './stores/memory.js';

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
  /** Custom store (default: MemoryIdempotencyStore) */
  store?: IdempotencyStore;
  /** Retry-After header value in seconds when request is in-flight (default: 1) */
  retryAfterSeconds?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The idempotency key for this request (if present) */
    idempotencyKey?: string;
    /** Whether this response was replayed from cache */
    idempotencyReplayed?: boolean;
  }

  interface FastifyInstance {
    /** Idempotency utilities */
    idempotency: {
      /** Manually invalidate an idempotency key */
      invalidate: (key: string) => Promise<void>;
      /** Check if a key has a cached response */
      has: (key: string) => Promise<boolean>;
    };
  }
}

const HEADER_IDEMPOTENCY_REPLAYED = 'x-idempotency-replayed';
const HEADER_IDEMPOTENCY_KEY = 'x-idempotency-key';

const idempotencyPlugin: FastifyPluginAsync<IdempotencyPluginOptions> = async (
  fastify: FastifyInstance,
  opts: IdempotencyPluginOptions = {}
) => {
  const {
    enabled = false,
    headerName = 'idempotency-key',
    ttlMs = 86400000, // 24 hours
    lockTimeoutMs = 30000, // 30 seconds
    methods = ['POST', 'PUT', 'PATCH'],
    include,
    exclude,
    store = new MemoryIdempotencyStore({ ttlMs }),
    retryAfterSeconds = 1,
  } = opts;

  // Skip if not enabled
  if (!enabled) {
    // Provide no-op utilities
    fastify.decorate('idempotency', {
      invalidate: async () => {},
      has: async () => false,
    });
    fastify.decorateRequest('idempotencyKey', undefined);
    fastify.decorateRequest('idempotencyReplayed', false);
    fastify.log?.debug?.('Idempotency plugin disabled');
    return;
  }

  const methodSet = new Set(methods.map((m) => m.toUpperCase()));

  // Decorate with utilities
  fastify.decorate('idempotency', {
    invalidate: async (key: string) => {
      await store.delete(key);
    },
    has: async (key: string) => {
      const result = await store.get(key);
      return !!result;
    },
  });

  fastify.decorateRequest('idempotencyKey', undefined);
  fastify.decorateRequest('idempotencyReplayed', false);

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
    if (obj === null || typeof obj !== 'object') {
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
   * Generate a fingerprint for the request (for key generation)
   */
  function getRequestFingerprint(request: FastifyRequest): string {
    // Combine method + URL + body hash for uniqueness
    let bodyHash = 'nobody';

    if (request.body && typeof request.body === 'object') {
      // Normalize body (sort keys) for consistent hashing
      const normalized = normalizeBody(request.body);
      const bodyString = JSON.stringify(normalized);
      bodyHash = createHash('sha256').update(bodyString).digest('hex').substring(0, 16);
      // SECURITY: Only log hash, never log full body (can contain secrets)
      if (request.log && request.log.debug) {
        request.log.debug({ bodyHash }, 'Generated body hash');
      }
    }

    const fingerprint = `${request.method}:${request.url}:${bodyHash}`;
    return fingerprint;
  }

  // Handle incoming requests
  // Use preHandler instead of onRequest to ensure body is parsed
  fastify.addHook('preHandler', async (request, reply) => {
    if (!shouldApplyIdempotency(request)) {
      return;
    }

    // Get idempotency key from header
    const keyHeader = request.headers[headerName.toLowerCase()];
    const idempotencyKey = typeof keyHeader === 'string' ? keyHeader.trim() : undefined;

    if (!idempotencyKey) {
      // No key provided - proceed normally
      return;
    }

    // Store key on request for later use
    request.idempotencyKey = idempotencyKey;

    // Create full key with request fingerprint
    const fullKey = `${idempotencyKey}:${getRequestFingerprint(request)}`;

    // Check for cached result
    const cached = await store.get(fullKey);
    if (cached) {
      // Replay cached response
      request.idempotencyReplayed = true;

      // Set response headers
      reply.header(HEADER_IDEMPOTENCY_REPLAYED, 'true');
      reply.header(HEADER_IDEMPOTENCY_KEY, idempotencyKey);

      // Replay original headers
      for (const [key, value] of Object.entries(cached.headers)) {
        if (!key.startsWith('x-idempotency')) {
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
      reply
        .code(409)
        .header('Retry-After', retryAfterSeconds.toString())
        .send({
          error: 'Request with this idempotency key is already in progress',
          code: 'IDEMPOTENCY_CONFLICT',
          retryAfter: retryAfterSeconds,
        });
      return;
    }

    // Store full key for onSend hook
    (request as FastifyRequest & { _idempotencyFullKey: string })._idempotencyFullKey = fullKey;
  });

  // Store response after successful request
  fastify.addHook('onSend', async (request, reply, payload) => {
    // Skip if this was a replayed response
    if (request.idempotencyReplayed) {
      return payload;
    }

    const fullKey = (request as FastifyRequest & { _idempotencyFullKey?: string })._idempotencyFullKey;
    if (!fullKey) {
      return payload;
    }

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
      'content-length',
      'transfer-encoding',
      'connection',
      'keep-alive',
      'date',
      'set-cookie',
    ]);

    const rawHeaders = reply.getHeaders();
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (!excludeHeaders.has(key.toLowerCase()) && typeof value === 'string') {
        headersToCache[key] = value;
      }
    }

    // Parse body if it's a string
    let body: unknown;
    try {
      body = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      body = payload;
    }

    // Store the result
    const result = createIdempotencyResult(statusCode, body, headersToCache, ttlMs);
    await store.set(fullKey, result);

    // Unlock (result is now cached)
    await store.unlock(fullKey, request.id);

    // Add idempotency key header to response
    reply.header(HEADER_IDEMPOTENCY_KEY, request.idempotencyKey);

    return payload;
  });

  // Handle errors - ensure lock is released
  fastify.addHook('onError', async (request) => {
    const fullKey = (request as FastifyRequest & { _idempotencyFullKey?: string })._idempotencyFullKey;
    if (fullKey) {
      await store.unlock(fullKey, request.id);
    }
  });

  // Cleanup on close
  fastify.addHook('onClose', async () => {
    await store.close?.();
  });

  fastify.log?.debug?.({ headerName, ttlMs, methods }, 'Idempotency plugin enabled');
};

export default fp(idempotencyPlugin, {
  name: 'arc-idempotency',
  fastify: '5.x',
});

export { idempotencyPlugin };
