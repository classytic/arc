/**
 * pipe() — Compose guards, transforms, and interceptors into a pipeline.
 *
 * Execution order:
 *   auth → permission → orgScope → GUARDS → TRANSFORMS → handler (wrapped by INTERCEPTORS)
 *
 * @example
 * ```typescript
 * import { pipe, guard, transform, intercept, defineResource } from '@classytic/arc';
 *
 * // Compose a pipeline
 * const productResource = defineResource({
 *   name: 'product',
 *   adapter: productAdapter,
 *   pipe: pipe(isActive, slugify, timing),
 * });
 *
 * // Per-operation pipelines
 * const productResource = defineResource({
 *   name: 'product',
 *   adapter: productAdapter,
 *   pipe: {
 *     create: pipe(isActive, slugify),
 *     list: pipe(timing),
 *   },
 * });
 * ```
 */

import type { IControllerResponse } from "../types/index.js";
import { ForbiddenError } from "../utils/index.js";
import type {
  Guard,
  Interceptor,
  NextFunction,
  PipelineContext,
  PipelineStep,
  Transform,
} from "./types.js";

/**
 * Compose pipeline steps into an ordered array.
 * Accepts guards, transforms, and interceptors in any order.
 */
export function pipe(...steps: PipelineStep[]): PipelineStep[] {
  return steps;
}

/**
 * Check if a step applies to the given operation.
 */
function appliesTo(step: PipelineStep, operation: string): boolean {
  if (!step.operations || step.operations.length === 0) return true;
  return step.operations.includes(operation);
}

/**
 * Execute a pipeline against a request context.
 *
 * This is the core runtime that createCrudRouter uses to execute pipelines.
 * External usage is not needed — this is wired automatically when `pipe` is set.
 *
 * @param steps - Pipeline steps to execute
 * @param ctx - The pipeline context (extends IRequestContext)
 * @param handler - The actual controller method to call
 * @param operation - The CRUD operation name
 * @returns The controller response (possibly modified by interceptors)
 */
export async function executePipeline(
  steps: PipelineStep[],
  ctx: PipelineContext,
  handler: (ctx: PipelineContext) => Promise<IControllerResponse<unknown>>,
  operation: string,
): Promise<IControllerResponse<unknown>> {
  // Partition by type, filtered to applicable operations
  const guards: Guard[] = [];
  const transforms: Transform[] = [];
  const interceptors: Interceptor[] = [];

  for (const step of steps) {
    if (!appliesTo(step, operation)) continue;
    switch (step._type) {
      case "guard":
        guards.push(step);
        break;
      case "transform":
        transforms.push(step);
        break;
      case "interceptor":
        interceptors.push(step);
        break;
    }
  }

  // Phase 1: Guards — must all pass
  for (const g of guards) {
    const result = await g.handler(ctx);
    if (!result) {
      throw new ForbiddenError(`Guard '${g.name}' denied access`);
    }
  }

  // Phase 2: Transforms — mutate context
  let currentCtx = ctx;
  for (const t of transforms) {
    const result = await t.handler(currentCtx);
    if (result) {
      currentCtx = result;
    }
  }

  // Phase 3: Interceptors — wrap handler in onion layers
  // Build the chain from inside-out (last interceptor wraps closest to handler)
  let chain: NextFunction = () => handler(currentCtx);

  for (let i = interceptors.length - 1; i >= 0; i--) {
    const interceptor = interceptors[i]!;
    const next = chain;
    chain = () => interceptor.handler(currentCtx, next);
  }

  return chain();
}
