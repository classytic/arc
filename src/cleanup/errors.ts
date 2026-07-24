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
  /** Execute called with an empty reason. */
  | "CLEANUP_REASON_REQUIRED"
  /** The re-planned digest differs from the client's — a new preview is required. */
  | "CLEANUP_PLAN_CHANGED"
  /** The plan carries unresolved blockers — a hard stop (§4.4). */
  | "CLEANUP_BLOCKED"
  /** The plan exceeds a framework size limit (items / results / reason / depth). */
  | "CLEANUP_PLAN_TOO_LARGE"
  /** A destructive run is already in progress (single-run fence, §8). */
  | "CLEANUP_ALREADY_RUNNING"
  /** The run id does not exist. */
  | "CLEANUP_RUN_NOT_FOUND"
  /** The action isn't valid for the run's current status (lost a CAS, etc.). */
  | "CLEANUP_INVALID_ACTION"
  /** No authenticated actor could be resolved for a destructive action (fail-closed). */
  | "CLEANUP_ACTOR_REQUIRED"
  /** Caller lacks permission for the operation. */
  | "CLEANUP_FORBIDDEN";

/**
 * A framework error carrying BOTH `status` (read directly in code/tests) and
 * `statusCode` (the Fastify convention arc's global error handler recognizes,
 * step 4 of its classifier — a numeric `statusCode` + a separatored domain
 * `code` maps to that exact status + code on the wire, never `arc.internal_error`).
 */
export class CleanupError extends Error {
  readonly code: CleanupErrorCode;
  readonly status: number;
  /** Alias of {@link status} — the property arc's error handler classifies on. */
  readonly statusCode: number;
  readonly meta?: Record<string, unknown>;

  constructor(
    code: CleanupErrorCode,
    status: number,
    message: string,
    meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CleanupError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
    if (meta) this.meta = meta;
  }
}

/**
 * Internal control-flow signal thrown by `throwIfCancelled()` when a run's
 * durable `cancelRequested` flag is set. NOT a wire error — `processRun`
 * catches it and CAS-transitions the run to `cancelled`.
 */
export class CleanupCancelled extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`Cleanup run ${runId} was cancelled.`);
    this.name = "CleanupCancelled";
    this.runId = runId;
  }
}

export const CleanupErrors = {
  unknownRecipe(id: string): CleanupError {
    return new CleanupError(
      "CLEANUP_UNKNOWN_RECIPE",
      404,
      `No cleanup recipe registered under id '${id}'.`,
      { id },
    );
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
    return new CleanupError(
      "CLEANUP_RECIPE_UNAVAILABLE",
      409,
      `Cleanup recipe '${id}' is unavailable: ${reason}`,
      {
        id,
        reason,
      },
    );
  },
  confirmationRequired(phrase: string): CleanupError {
    return new CleanupError(
      "CLEANUP_CONFIRMATION_REQUIRED",
      400,
      "This destructive cleanup requires the exact confirmation phrase.",
      { confirmationPhrase: phrase },
    );
  },
  reasonRequired(): CleanupError {
    return new CleanupError("CLEANUP_REASON_REQUIRED", 400, "A non-empty reason is required.");
  },
  blocked(blockers: readonly string[]): CleanupError {
    return new CleanupError(
      "CLEANUP_BLOCKED",
      409,
      `Cleanup plan has unresolved blockers and cannot run: ${blockers.join(", ")}.`,
      { blockers: [...blockers] },
    );
  },
  planTooLarge(detail: string): CleanupError {
    return new CleanupError(
      "CLEANUP_PLAN_TOO_LARGE",
      413,
      `Cleanup plan exceeds a size limit: ${detail}.`,
      {
        detail,
      },
    );
  },
  actorRequired(): CleanupError {
    return new CleanupError(
      "CLEANUP_ACTOR_REQUIRED",
      401,
      "A destructive cleanup requires an authenticated actor; none could be resolved.",
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
    return new CleanupError("CLEANUP_FORBIDDEN", 403, `Not authorized to ${operation} cleanup.`, {
      operation,
    });
  },
} as const;
