/**
 * Request Context via AsyncLocalStorage
 *
 * Provides request-scoped context accessible anywhere in the call stack
 * without threading parameters through every function call.
 *
 * Uses Node.js native AsyncLocalStorage — zero-cost per request, no allocation
 * beyond the store object, and fully supported since Node 16.
 *
 * @example
 * ```typescript
 * import { requestContext } from '@classytic/arc/context';
 *
 * // Anywhere in the call stack — no parameter passing needed
 * async function auditAction(action: string) {
 *   const ctx = requestContext.get();
 *   await auditLog.write({
 *     action,
 *     userId: ctx?.user?.id,
 *     orgId: ctx?.organizationId,
 *     requestId: ctx?.requestId,
 *   });
 * }
 *
 * // Type-safe access to specific fields
 * const userId = requestContext.get()?.user?.id;
 * const orgId = requestContext.get()?.organizationId;
 * ```
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Shape of the request-scoped context store.
 * Populated by Arc's onRequest hook in arcCorePlugin.
 */
export interface RequestStore {
  /** Unique request identifier */
  requestId?: string;
  /** Authenticated user (if any) */
  user?: { id?: string; _id?: string; roles?: string[]; [key: string]: unknown } | null;
  /** Active organization ID (multi-tenant) */
  organizationId?: string;
  /** Active team ID (team-scoped resources) */
  teamId?: string;
  /** Current resource name (set by arcDecorator in CRUD routes) */
  resourceName?: string;
  /** Request start time (for timing) */
  startTime: number;
  /**
   * W3C Trace Context traceparent header (RFC 9457 / W3C Recommendation).
   * Format: `00-<trace-id>-<parent-id>-<flags>` (e.g. `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`).
   * Populated by `requestIdPlugin` when the header is present and valid.
   */
  traceparent?: string;
  /**
   * W3C Trace Context tracestate header.
   * Vendor-specific, comma-separated `key=value` pairs.
   * Populated by `requestIdPlugin` when the header is present.
   */
  tracestate?: string;
  /** Additional context — extensible by app */
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<RequestStore>();

/**
 * Request context API.
 *
 * - `get()` — returns current store or undefined if outside request scope
 * - `run(store, fn)` — run a function with a specific store (used by Arc internals)
 * - `getStore()` — alias for get() (matches Node.js API naming)
 */
export const requestContext = {
  /**
   * Get the current request context.
   * Returns undefined if called outside a request lifecycle.
   */
  get(): RequestStore | undefined {
    return storage.getStore();
  },

  /**
   * Alias for get() — matches Node.js AsyncLocalStorage API naming.
   */
  getStore(): RequestStore | undefined {
    return storage.getStore();
  },

  /**
   * Run a function within a specific request context.
   * Used internally by Arc's onRequest hook.
   */
  run<T>(store: RequestStore, fn: () => T): T {
    return storage.run(store, fn);
  },

  /**
   * The underlying AsyncLocalStorage instance.
   * Exposed for advanced use cases (testing, custom integrations).
   */
  storage,
};

/**
 * Returns the W3C Trace Context headers (`traceparent`, `tracestate`) from
 * the current request context as a plain `Record<string, string>`, suitable
 * for passing to `OutboxWriteOptions.headers` or forwarding to downstream
 * HTTP clients.
 *
 * Returns `undefined` when called outside a request scope or when no trace
 * context was propagated by the upstream caller.
 *
 * @example
 * ```typescript
 * // Propagate trace context through the outbox so downstream consumers
 * // can stitch together distributed traces.
 * const traceHeaders = getTraceHeaders();
 * await outbox.store(event, { headers: traceHeaders });
 * ```
 */
export function getTraceHeaders(): Record<string, string> | undefined {
  const store = requestContext.get();
  if (!store) return undefined;

  const headers: Record<string, string> = {};
  if (store.traceparent) headers.traceparent = store.traceparent;
  if (store.tracestate) headers.tracestate = store.tracestate;
  return Object.keys(headers).length > 0 ? headers : undefined;
}
