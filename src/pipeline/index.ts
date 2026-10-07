// Pipeline module — functional guard/transform/intercept pattern
export { type GuardOptions, guard } from "./guard.js";
export { type InterceptOptions, intercept } from "./intercept.js";
export { executePipeline, pipe } from "./pipe.js";
export { type TransformOptions, transform } from "./transform.js";

export type {
  Guard,
  Interceptor,
  NextFunction,
  OperationFilter,
  PipelineConfig,
  PipelineContext,
  PipelineStep,
  Transform,
} from "./types.js";
