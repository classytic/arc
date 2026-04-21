/**
 * transform() — Modifies request data before the handler.
 *
 * Transforms run AFTER guards but BEFORE the handler. They can modify
 * the request body, params, or context.
 *
 * @example
 * ```typescript
 * import { transform } from '@classytic/arc/pipeline';
 *
 * const slugify = transform('slugify', {
 *   operations: ['create'],
 *   handler: (ctx) => {
 *     if (ctx.body?.name && !ctx.body?.slug) {
 *       ctx.body.slug = ctx.body.name.toLowerCase().replace(/\s+/g, '-');
 *     }
 *   },
 * });
 *
 * const trimStrings = transform('trimStrings', (ctx) => {
 *   if (ctx.body && typeof ctx.body === 'object') {
 *     for (const [key, value] of Object.entries(ctx.body)) {
 *       if (typeof value === 'string') {
 *         (ctx.body as Record<string, unknown>)[key] = value.trim();
 *       }
 *     }
 *   }
 * });
 * ```
 */

import type { OperationFilter, PipelineContext, Transform } from "./types.js";

interface TransformOptions {
  operations?: OperationFilter;
  handler: (
    ctx: PipelineContext,
  ) => PipelineContext | undefined | Promise<PipelineContext | undefined>;
}

/**
 * Create a named transform.
 *
 * @param name - Transform name (for debugging/introspection)
 * @param handlerOrOptions - Handler function or options object
 */
export function transform(
  name: string,
  handlerOrOptions:
    | ((ctx: PipelineContext) => PipelineContext | undefined | Promise<PipelineContext | undefined>)
    | TransformOptions,
): Transform {
  const opts =
    typeof handlerOrOptions === "function" ? { handler: handlerOrOptions } : handlerOrOptions;

  return {
    _type: "transform" as const,
    name,
    operations: opts.operations,
    handler: opts.handler,
  };
}
