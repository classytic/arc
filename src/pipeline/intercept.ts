/**
 * intercept() — Wraps handler execution (before + after pattern).
 *
 * Interceptors wrap the handler like an onion — they can run code before
 * the handler, after the handler, modify the response, measure timing, etc.
 *
 * @example
 * ```typescript
 * import { intercept } from '@classytic/arc/pipeline';
 *
 * const timing = intercept('timing', async (ctx, next) => {
 *   const start = performance.now();
 *   const result = await next();
 *   result.meta = { ...result.meta, durationMs: Math.round(performance.now() - start) };
 *   return result;
 * });
 *
 * const cache = intercept('cache', {
 *   operations: ['list', 'get'],
 *   handler: async (ctx, next) => {
 *     const cached = await redis.get(cacheKey(ctx));
 *     if (cached) return JSON.parse(cached);
 *     const result = await next();
 *     await redis.setex(cacheKey(ctx), 60, JSON.stringify(result));
 *     return result;
 *   },
 * });
 * ```
 */

import type { IControllerResponse } from "../types/index.js";
import type { Interceptor, NextFunction, OperationFilter, PipelineContext } from "./types.js";

interface InterceptOptions {
  operations?: OperationFilter;
  handler: (ctx: PipelineContext, next: NextFunction) => Promise<IControllerResponse<unknown>>;
}

/**
 * Create a named interceptor.
 *
 * @param name - Interceptor name (for debugging/introspection)
 * @param handlerOrOptions - Handler function or options object
 */
export function intercept(
  name: string,
  handlerOrOptions:
    | ((ctx: PipelineContext, next: NextFunction) => Promise<IControllerResponse<unknown>>)
    | InterceptOptions,
): Interceptor {
  const opts =
    typeof handlerOrOptions === "function" ? { handler: handlerOrOptions } : handlerOrOptions;

  return {
    _type: "interceptor" as const,
    name,
    operations: opts.operations,
    handler: opts.handler,
  };
}
