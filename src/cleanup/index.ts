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

export type { CleanupErrorCode } from "./errors.js";
export { CleanupCancelled, CleanupError, CleanupErrors } from "./errors.js";
export type { DataCleanupModuleDeps } from "./module.js";
export { createDataCleanupModule } from "./module.js";

export { canonicalJson, computeManifestDigest, computePlanDigest } from "./plan-digest.js";
export type { CleanupRecipeInfo, CleanupRegistry } from "./registry.js";
export { createCleanupRegistry } from "./registry.js";
export type {
  CleanupService,
  CleanupServiceDeps,
  ExecuteInput,
  PreviewInput,
} from "./service.js";
export { createCleanupService } from "./service.js";
export type {
  Availability,
  CleanupContext,
  CleanupEvidenceStore,
  CleanupExecutionContext,
  CleanupInput,
  CleanupJob,
  CleanupJobQueue,
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
  CleanupStepResult,
  CleanupWriteFence,
  PurgeActor,
  PurgeEvidence,
  PurgeResourceResult,
  PurgeVerificationSummary,
  VerificationCheck,
  VerificationResult,
} from "./types.js";
export { CLEANUP_TERMINAL_STATUSES, DEFAULT_CLEANUP_LIMITS } from "./types.js";
