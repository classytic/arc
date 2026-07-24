/**
 * `@classytic/arc/cleanup` — the thin Data Cleanup Center framework
 * (data-cleanup design §6.5).
 *
 * Arc owns: the recipe registry (boot-time uniqueness), the deterministic
 * plan digest, stable typed errors, the run/evidence store PORTS, the
 * orchestration service (preview → confirm → execute → verify → evidence),
 * and the Arc resource factory. Arc does NOT own recipe definitions or
 * statutory rules — those live in the host + domain kernels.
 *
 * Compose with `createDataCleanupModule({ recipes, runStore, evidenceStore,
 * permissions, writeFence, worker })`.
 */

export type {
  Availability,
  CleanupContext,
  CleanupEvidenceStore,
  CleanupExecutionContext,
  CleanupInput,
  CleanupLogger,
  CleanupManifest,
  CleanupOutcomeStatus,
  CleanupPermissionCheck,
  CleanupPermissions,
  CleanupPlan,
  CleanupPlanDraft,
  CleanupPlanItem,
  CleanupRecipe,
  CleanupResult,
  CleanupRun,
  CleanupRunStatus,
  CleanupRunStore,
  CleanupStepResult,
  CleanupWorker,
  CleanupWriteFence,
  PurgeActor,
  PurgeEvidence,
  PurgeResourceResult,
  PurgeVerificationSummary,
  VerificationCheck,
  VerificationResult,
} from "./types.js";

export { CleanupError, CleanupErrors } from "./errors.js";
export type { CleanupErrorCode } from "./errors.js";

export { computeManifestDigest, computePlanDigest } from "./plan-digest.js";

export { createCleanupRegistry } from "./registry.js";
export type { CleanupRegistry, CleanupRecipeInfo } from "./registry.js";

export { createCleanupService } from "./service.js";
export type {
  CleanupService,
  CleanupServiceDeps,
  ExecuteInput,
  PreviewInput,
} from "./service.js";
