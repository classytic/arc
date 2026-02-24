// Pipeline module — functional guard/transform/intercept pattern
export { guard } from './guard.js';
export { transform } from './transform.js';
export { intercept } from './intercept.js';
export { pipe, executePipeline } from './pipe.js';

export type {
  PipelineContext,
  PipelineStep,
  PipelineConfig,
  Guard,
  Transform,
  Interceptor,
  NextFunction,
  OperationFilter,
} from './types.js';
