/**
 * Pipeline handler wiring — wrap controller methods and action handlers
 * with pipeline execution, and resolve `PipelineConfig` into per-op steps.
 */

import type { RouteHandlerMethod } from "fastify";

import { executePipeline } from "../../pipeline/pipe.js";
import type { PipelineConfig, PipelineContext, PipelineStep } from "../../pipeline/types.js";
import type { IControllerResponse, IRequestContext, RequestWithExtras } from "../../types/index.js";
import { createRequestContext, sendControllerResponse } from "../fastifyAdapter.js";

/**
 * Resolve pipeline steps for a specific operation.
 * Flat-array config applies to every op; map config applies per-op.
 */
export function resolvePipelineSteps(
  pipeline: PipelineConfig | undefined,
  operation: string,
): PipelineStep[] {
  if (!pipeline) return [];
  if (Array.isArray(pipeline)) return pipeline;
  return pipeline[operation] ?? [];
}

/**
 * Wrap a controller method (one that takes `IRequestContext` and returns
 * `IControllerResponse<T>`) with pipeline execution. Used by CRUD ops and
 * string-handler custom routes.
 */
export function buildPipelineHandler<T>(
  controllerMethod: (ctx: IRequestContext) => Promise<IControllerResponse<T>>,
  steps: PipelineStep[],
  operation: string,
  resourceName: string,
): RouteHandlerMethod {
  return async (req, reply): Promise<void> => {
    const reqCtx = createRequestContext(req);
    const pipeCtx: PipelineContext = { ...reqCtx, resource: resourceName, operation };
    const response = await executePipeline(
      steps,
      pipeCtx,
      (ctx) => controllerMethod(ctx) as Promise<IControllerResponse<unknown>>,
      operation,
    );
    sendControllerResponse(reply, response as IControllerResponse<T>, req);
  };
}

/**
 * Wrap an action handler (one that takes `(id, data, req)` and returns a raw
 * result) with pipeline execution. Returns a function that produces a full
 * `IControllerResponse<unknown>` — the action router feeds this directly into
 * `sendControllerResponse`, so field masking, custom status codes, `meta`,
 * `details`, and structured error codes from pipeline interceptors flow
 * through to the client unchanged.
 *
 * CRUD and actions now share the same parity invariant: a pipeline that
 * returns `{ success: false, status: 422, error, details, meta }` reaches the
 * client with all four fields intact. Previously the action path stringified
 * failures into a generic `Error` and dropped everything except `statusCode`.
 *
 * Handler throws still bubble out — the caller's try/catch handles `onError`
 * shaping and the generic `ACTION_FAILED` fallback.
 */
export function buildActionPipelineHandler(
  handler: (id: string, data: Record<string, unknown>, req: RequestWithExtras) => Promise<unknown>,
  steps: PipelineStep[],
  operation: string,
  resourceName: string,
): (
  id: string,
  data: Record<string, unknown>,
  req: RequestWithExtras,
) => Promise<IControllerResponse<unknown>> {
  if (steps.length === 0) {
    return async (id, data, req) => ({
      status: 200,
      data: await handler(id, data, req),
    });
  }
  return async (id, data, req) => {
    const reqCtx = createRequestContext(req);
    const pipeCtx: PipelineContext = { ...reqCtx, resource: resourceName, operation };
    return executePipeline(
      steps,
      pipeCtx,
      async (_ctx) => ({
        status: 200,
        data: await handler(id, data, req),
      }),
      operation,
    );
  };
}
