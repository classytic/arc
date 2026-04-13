/**
 * defineGuard — typed resource-level guard with context extraction
 *
 * Creates a preHandler + typed extractor pair. The guard runs once as a
 * preHandler (via `routeGuards` or per-route `preHandler`), computes a
 * typed context, and stashes it on the request. Downstream handlers
 * retrieve it via `guard.from(req)` — typed, no re-computation.
 *
 * @example
 * ```typescript
 * import { defineGuard } from '@classytic/arc/utils';
 *
 * const flowGuard = defineGuard({
 *   name: 'flow',
 *   resolve: (req) => {
 *     const orgId = req.headers['x-organization-id'] as string;
 *     if (!orgId) throw new Error('Missing organization');
 *     return { orgId, actorId: req.user?.id ?? 'system' };
 *   },
 * });
 *
 * defineResource({
 *   routeGuards: [flowGuard.preHandler],
 *   routes: [{
 *     method: 'GET', path: '/', raw: true,
 *     handler: async (req, reply) => {
 *       const ctx = flowGuard.from(req); // typed as { orgId: string; actorId: string }
 *       reply.send({ org: ctx.orgId });
 *     },
 *   }],
 * });
 * ```
 */

import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";

/** Hidden property key for guard context storage on the request object. */
const GUARD_STORE_KEY = "__arcGuardContext";

interface GuardConfig<T> {
  /** Unique name — used as the storage key on the request. */
  readonly name: string;
  /**
   * Resolve the guard context from the request. Throw to abort the request
   * (Fastify's error handler will produce the appropriate HTTP response).
   * Return a value to stash it for `from()` extraction.
   */
  readonly resolve: (req: FastifyRequest, reply: FastifyReply) => T | Promise<T>;
}

interface Guard<T> {
  /** Use in `routeGuards` or per-route `preHandler` arrays. */
  readonly preHandler: RouteHandlerMethod;
  /**
   * Extract the resolved context from a request. Throws if the guard
   * hasn't run yet (i.e. not in the preHandler chain).
   */
  from(req: FastifyRequest): T;
  /** The guard name (for debugging). */
  readonly name: string;
}

/**
 * Create a typed guard. See module JSDoc for usage.
 */
export function defineGuard<T>(config: GuardConfig<T>): Guard<T> {
  const { name, resolve } = config;

  const preHandler: RouteHandlerMethod = async (req, reply) => {
    const ctx = await resolve(req, reply);
    // Only stash if the guard didn't abort (reply.sent check)
    if (!reply.sent) {
      const store =
        ((req as unknown as Record<string, unknown>)[GUARD_STORE_KEY] as
          | Record<string, unknown>
          | undefined) ?? {};
      store[name] = ctx;
      (req as unknown as Record<string, unknown>)[GUARD_STORE_KEY] = store;
    }
  };

  return {
    preHandler,
    name,
    from(req: FastifyRequest): T {
      const store = (req as unknown as Record<string, unknown>)[GUARD_STORE_KEY] as
        | Record<string, unknown>
        | undefined;
      if (!store || !(name in store)) {
        throw new Error(
          `Guard '${name}' not resolved on this request. ` +
            `Add it to routeGuards or the route's preHandler array.`,
        );
      }
      return store[name] as T;
    },
  };
}
