/**
 * Named Middleware — Priority-based, conditional middleware execution.
 *
 * Named middleware replaces flat arrays with structured, inspectable middleware
 * that runs in priority order and supports conditional execution.
 *
 * @example
 * ```typescript
 * import { middleware } from '@classytic/arc';
 *
 * const verifyEmail = middleware('verifyEmail', {
 *   operations: ['create', 'update'],
 *   priority: 5,
 *   when: (req) => !req.user?.emailVerified,
 *   handler: async (req, reply) => {
 *     reply.code(403).send({ error: 'Email verification required' });
 *   },
 * });
 *
 * const rateLimit = middleware('rateLimit', {
 *   priority: 1,
 *   handler: async (req, reply) => {
 *     // rate limit logic
 *   },
 * });
 *
 * const productResource = defineResource({
 *   name: 'product',
 *   adapter,
 *   middlewares: sortMiddlewares([verifyEmail, rateLimit]),
 * });
 * ```
 */

import type { MiddlewareConfig, MiddlewareHandler, RequestWithExtras } from '../types/index.js';

export interface NamedMiddleware {
  /** Unique name for debugging/introspection */
  readonly name: string;
  /** Operations this middleware applies to (default: all) */
  readonly operations?: Array<'list' | 'get' | 'create' | 'update' | 'delete' | string>;
  /** Priority — lower numbers run first (default: 10) */
  readonly priority: number;
  /** Conditional execution — return true to run, false to skip */
  readonly when?: (request: RequestWithExtras) => boolean | Promise<boolean>;
  /** The middleware handler */
  readonly handler: MiddlewareHandler;
}

interface MiddlewareOptions {
  operations?: NamedMiddleware['operations'];
  priority?: number;
  when?: NamedMiddleware['when'];
  handler: MiddlewareHandler;
}

/**
 * Create a named middleware with priority and conditions.
 */
export function middleware(
  name: string,
  options: MiddlewareOptions,
): NamedMiddleware {
  return {
    name,
    operations: options.operations,
    priority: options.priority ?? 10,
    when: options.when,
    handler: options.handler,
  };
}

/**
 * Sort named middlewares by priority (ascending — lower runs first).
 * Returns a MiddlewareConfig map keyed by operation, ready to pass to `defineResource()`.
 */
export function sortMiddlewares(middlewares: NamedMiddleware[]): MiddlewareConfig {
  const sorted = [...middlewares].sort((a, b) => a.priority - b.priority);

  const operations = ['list', 'get', 'create', 'update', 'delete'] as const;
  const result: MiddlewareConfig = {};

  for (const op of operations) {
    const applicable = sorted.filter(
      (m) => !m.operations || m.operations.length === 0 || m.operations.includes(op),
    );
    if (applicable.length > 0) {
      result[op] = applicable.map((m) => {
        if (!m.when) return m.handler;
        // Wrap with conditional check
        const wrapped: MiddlewareHandler = async (request, reply) => {
          const shouldRun = await m.when!(request);
          if (shouldRun) {
            return m.handler(request, reply);
          }
        };
        return wrapped;
      });
    }
  }

  return result;
}
