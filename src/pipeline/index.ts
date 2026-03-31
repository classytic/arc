// Pipeline module — functional guard/transform/intercept pattern
export { guard } from "./guard.js";
export { intercept } from "./intercept.js";
export { executePipeline, pipe } from "./pipe.js";
export { transform } from "./transform.js";

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
