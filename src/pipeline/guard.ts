/**
 * guard() — Boolean check that short-circuits on failure.
 *
 * Guards run BEFORE transforms and the handler. If a guard fails (returns false
 * or throws), the request is rejected immediately.
 *
 * @example
 * ```typescript
 * import { guard } from '@classytic/arc';
 *
 * const isActive = guard('isActive', (ctx) => {
 *   if (!ctx.user?.isActive) throw new ForbiddenError('Account suspended');
 *   return true;
 * });
 *
 * // With operation filter
 * const requireBody = guard('requireBody', {
 *   operations: ['create', 'update'],
 *   handler: (ctx) => {
 *     if (!ctx.body || Object.keys(ctx.body).length === 0) {
 *       throw new ValidationError('Request body is required');
 *     }
 *     return true;
 *   },
 * });
 * ```
 */

import type { Guard, OperationFilter, PipelineContext } from "./types.js";

interface GuardOptions {
  operations?: OperationFilter;
  handler: (ctx: PipelineContext) => boolean | Promise<boolean>;
}

/**
 * Create a named guard.
 *
 * @param name - Guard name (for debugging/introspection)
 * @param handlerOrOptions - Handler function or options object
 */
export function guard(
  name: string,
  handlerOrOptions: ((ctx: PipelineContext) => boolean | Promise<boolean>) | GuardOptions,
): Guard {
  const opts =
    typeof handlerOrOptions === "function" ? { handler: handlerOrOptions } : handlerOrOptions;

  return {
    _type: "guard" as const,
    name,
    operations: opts.operations,
    handler: opts.handler,
  };
}
