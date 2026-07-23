/**
 * Job queue integration — public barrel. See types.ts for the directory
 * map. The package subpath `@classytic/arc/integrations/jobs` resolves via
 * `src/integrations/jobs.ts`, which re-exports this file (build entry
 * unchanged by the split).
 */

export {
  type ExecuteTimedHandlerOptions,
  executeTimedHandler,
  type TimedHandlerLogger,
} from "./execution.js";
export { jobsPlugin } from "./plugin.js";
export {
  defineJob,
  type JobDefinition,
  type JobDispatcher,
  type JobDispatchOptions,
  type JobMeta,
  type JobRepeatOptions,
  type JobStatus,
  type JobsPluginOptions,
  type QueueStats,
} from "./types.js";
