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
 * import { requestContext } from '@classytic/arc';
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
