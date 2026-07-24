/**
 * Data Cleanup Center — stable, typed errors.
 *
 * Every failure the framework raises carries a stable machine `code` (so
 * SDK/UI can branch) and an HTTP `status` (so the Arc resource maps cleanly).
 * The codes are part of the public contract — do not rename.
 */

export type CleanupErrorCode =
  /** No recipe registered under the requested id. */
  | "CLEANUP_UNKNOWN_RECIPE"
  /** Two recipes share an id at registry construction. */
  | "CLEANUP_DUPLICATE_RECIPE"
  /** The recipe's `available()` returned false. */
  | "CLEANUP_RECIPE_UNAVAILABLE"
  /** Execute called without the exact confirmation phrase. */
  | "CLEANUP_CONFIRMATION_REQUIRED"
  /** The re-planned digest differs from the client's — a new preview is required. */
  | "CLEANUP_PLAN_CHANGED"
  /** A destructive run is already in progress (single-run fence, §8). */
  | "CLEANUP_ALREADY_RUNNING"
  /** The run id does not exist. */
  | "CLEANUP_RUN_NOT_FOUND"
  /** The action isn't valid for the run's current status. */
  | "CLEANUP_INVALID_ACTION"
  /** Caller lacks permission for the operation. */
  | "CLEANUP_FORBIDDEN";

export class CleanupError extends Error {
  readonly code: CleanupErrorCode;
  readonly status: number;
  readonly meta?: Record<string, unknown>;

  constructor(code: CleanupErrorCode, status: number, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = "CleanupError";
    this.code = code;
    this.status = status;
    if (meta) this.meta = meta;
  }
}

export const CleanupErrors = {
  unknownRecipe(id: string): CleanupError {
    return new CleanupError("CLEANUP_UNKNOWN_RECIPE", 404, `No cleanup recipe registered under id '${id}'.`, { id });
  },
  duplicateRecipe(id: string): CleanupError {
    return new CleanupError(
      "CLEANUP_DUPLICATE_RECIPE",
      500,
      `Duplicate cleanup recipe id '${id}' — recipe ids must be unique in a registry.`,
      { id },
    );
  },
  unavailable(id: string, reason: string): CleanupError {
    return new CleanupError("CLEANUP_RECIPE_UNAVAILABLE", 409, `Cleanup recipe '${id}' is unavailable: ${reason}`, {
      id,
      reason,
    });
  },
  confirmationRequired(phrase: string): CleanupError {
    return new CleanupError(
      "CLEANUP_CONFIRMATION_REQUIRED",
      400,
      "This destructive cleanup requires the exact confirmation phrase.",
      { confirmationPhrase: phrase },
    );
  },
  planChanged(expected: string, actual: string): CleanupError {
    return new CleanupError(
      "CLEANUP_PLAN_CHANGED",
      409,
      "The cleanup plan changed since preview — re-preview and confirm the new plan.",
      { expectedDigest: expected, actualDigest: actual },
    );
  },
  alreadyRunning(runId: string): CleanupError {
    return new CleanupError(
      "CLEANUP_ALREADY_RUNNING",
      409,
      "Another destructive cleanup run is already in progress. Only one runs at a time.",
      { runId },
    );
  },
  runNotFound(id: string): CleanupError {
    return new CleanupError("CLEANUP_RUN_NOT_FOUND", 404, `Cleanup run '${id}' not found.`, { id });
  },
  invalidAction(action: string, status: string): CleanupError {
    return new CleanupError(
      "CLEANUP_INVALID_ACTION",
      409,
      `Action '${action}' is not valid for a run in status '${status}'.`,
      { action, status },
    );
  },
  forbidden(operation: string): CleanupError {
    return new CleanupError("CLEANUP_FORBIDDEN", 403, `Not authorized to ${operation} cleanup.`, { operation });
  },
} as const;
