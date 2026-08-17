/**
 * `@classytic/arc/cleanup` — the thin Data Cleanup Center framework
 * (data-cleanup design §6.5).
 *
 * Arc owns: the recipe registry (boot-time uniqueness), the deterministic
 * plan/manifest checksums, stable typed errors, the durable run/evidence/queue
 * PORTS, the orchestration service (validate → enqueue → worker: execute →
 * verify → finalize, with CAS transitions + cooperative cancellation), and the
 * Arc resource factory. Arc does NOT own recipe definitions or statutory rules
 * — those live in the host + domain kernels.
 *
 * Compose with `createDataCleanupModule({ recipes, runStore, evidenceStore,
 * permissions, writeFence?, jobQueue?, ... })`.
 */

export type { RecipeFromStepsInput } from "./compose.js";
export { recipeFromSteps } from "./compose.js";
export type { CleanupErrorCode } from "./errors.js";
export { CleanupCancelled, CleanupError, CleanupErrors } from "./errors.js";
export {
  MemoryCleanupEvidenceStore,
  MemoryCleanupJobQueue,
  MemoryCleanupRunStore,
} from "./memory.js";
export type { DataCleanupModuleDeps } from "./module.js";
export { createDataCleanupModule } from "./module.js";

export { canonicalJson, computeManifestDigest, computePlanDigest } from "./plan-digest.js";
export type { CleanupRecipeInfo, CleanupRegistry } from "./registry.js";
export { createCleanupRegistry } from "./registry.js";
export type {
  CancelInput,
  CleanupService,
  CleanupServiceDeps,
  ExecuteInput,
  PreviewInput,
} from "./service.js";
export { createCleanupService, GLOBAL_DESTRUCTIVE_KEY } from "./service.js";
export type {
  Availability,
  CleanupCancelRequest,
  CleanupContext,
  CleanupEvidenceStore,
  CleanupExecutionContext,
  CleanupFinalizationPayload,
  CleanupInput,
  CleanupJob,
  CleanupJobQueue,
  CleanupLease,
  CleanupLimits,
  CleanupLogger,
  CleanupManifest,
  CleanupOutcomeStatus,
  CleanupPermissionCheck,
  CleanupPermissions,
  CleanupPlan,
  CleanupPlanDraft,
  CleanupPlanItem,
  CleanupProgressSummary,
  CleanupRecipe,
  CleanupResult,
  CleanupRun,
  CleanupRunCreateResult,
  CleanupRunStatus,
  CleanupRunStore,
  CleanupRunTransitionPatch,
  CleanupStepProgress,
  CleanupStepResult,
  CleanupStepRunStatus,
  CleanupWriteFence,
  PurgeActor,
  PurgeEvidence,
  PurgeResourceResult,
  PurgeStrategyKind,
  PurgeVerificationSummary,
  VerificationCheck,
  VerificationResult,
} from "./types.js";
export { CLEANUP_TERMINAL_STATUSES, DEFAULT_CLEANUP_LIMITS } from "./types.js";
