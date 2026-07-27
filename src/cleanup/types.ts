/**
 * Data Cleanup Center — core types (data-cleanup design §5).
 *
 * A **recipe** is a business cleanup operation ("remove draft sales data",
 * "reset pre-go-live transactions"). Operators pick recipes, never collection
 * names or Mongo filters. Each recipe is a pure PROVIDER — arc owns the thin
 * framework (registry, plan digest, run/evidence ports, resource factory);
 * the recipe (and the kernels it delegates to) owns the domain knowledge.
 *
 * The lifecycle is always:
 *
 *   Preview → Confirm with reason → Execute safely → Verify → Record evidence
 *
 * These types are deliberately framework-free (no Fastify, no Mongo) so the
 * same recipe/registry runs in tests, a worker, or an Arc resource unchanged.
 *
 * **Durability model (this is a DESTRUCTIVE-operation engine).** The ports are
 * shaped so the promised guarantees actually hold across process boundaries and
 * crashes:
 *   - `execute()` VALIDATES + persists a run + ENQUEUES a serializable
 *     `{ runId }` job. The recipe runs in `processRun(runId)` — on a worker,
 *     off the request path. Nothing captures a closure into the queue.
 *   - Every status change is a compare-and-set (`compareAndTransition`) so a
 *     `completed` write can never clobber a `cancelled` one.
 *   - The single-destructive-run guard is an ATOMIC conditional insert
 *     (`createIfPermitted`), not a check-then-create race.
 *   - The sealed plan + inputs are persisted ON the run, so a worker (or a
 *     retry) replays the SAME authorized operation, never a reconstruction.
 *   - Cancellation is a durable `cancelRequested` flag the executor polls; an
 *     in-process `AbortSignal` is only an optimization.
 *   - Finalization (terminal status + evidence + manifest) is idempotent by
 *     `operationId` and recoverable from a `finalizing` state after a restart.
 */

import type {
  PurgeActor,
  PurgeEvidence,
  PurgeResourceResult,
  PurgeStrategyKind,
  PurgeVerificationSummary,
} from "@classytic/primitives/retention";

export type {
  PurgeActor,
  PurgeEvidence,
  PurgeResourceResult,
  PurgeStrategyKind,
  PurgeVerificationSummary,
};

/** Ambient context every recipe method receives. Host-injected — never global. */
export interface CleanupContext {
  /** Who requested the operation. */
  readonly actor: PurgeActor;
  /** Injected clock — recipes never call `new Date()` directly (testability). */
  readonly now: Date;
  /** Cooperative cancellation — checked between chunks/steps. */
  readonly signal?: AbortSignal | undefined;
  /** Optional structured logger. */
  readonly logger?: CleanupLogger | undefined;
  /**
   * Opaque host-provided ambient values (e.g. the resolved company/branch
   * scope). MUST be JSON-serializable — it is persisted on the run so a worker
   * (different process) can rebuild the exact operation context. Recipes read
   * what they declared they need; the framework never inspects it.
   */
  readonly ambient?: Readonly<Record<string, unknown>> | undefined;
}

export interface CleanupLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Execution-time context — adds progress reporting + the run/operation ids +
 * cooperative cancellation.
 */
export interface CleanupExecutionContext extends CleanupContext {
  /** Durable run id this execution belongs to. */
  readonly runId: string;
  /** Stable operation id threaded through logs, audit, and evidence. */
  readonly operationId: string;
  /**
   * Report one committed chunk. Updates the run's BOUNDED progress summary
   * (counts / current resource / cursor / heartbeat) — it does NOT retain
   * every step in memory. Also refreshes the cancellation view: after a chunk
   * commits, call this so the executor learns of a cancel request promptly.
   */
  onStep(step: CleanupStepResult): Promise<void>;
  /**
   * Throw `CleanupCancelled` if a cancel has been requested for this run. Cheap
   * to call between chunks; backed by the durable `cancelRequested` flag (the
   * source of truth) plus the in-process `signal`.
   */
  throwIfCancelled(): Promise<void>;
}

/** Whether a recipe may run right now, and why not. */
export interface Availability {
  readonly available: boolean;
  /** Required when `available` is false — surfaced to the operator. */
  readonly reason?: string | undefined;
}

/** Operator-supplied recipe parameters (branch, module set, before-date, …). */
export interface CleanupInput {
  readonly parameters?: Readonly<Record<string, unknown>> | undefined;
}

/** One logical line in the preview — a business record class, never a collection. */
export interface CleanupPlanItem {
  /** Logical module / resource label, e.g. `'orders'`, `'journal entries'`. */
  readonly resource: string;
  /** Estimated records affected. */
  readonly estimated: number;
  /** What is retained for this line (e.g. `'measures kept, PII redacted'`). */
  readonly retained?: string | undefined;
  /** Domain blockers preventing this line (e.g. `'OPEN_TRANSFER'`). */
  readonly blockers?: readonly string[] | undefined;
}

/**
 * A recipe's plan BEFORE the framework seals it — the recipe returns this; the
 * service computes {@link CleanupPlan.digest} + stamps {@link CleanupPlan.recipeId}.
 */
export interface CleanupPlanDraft {
  readonly items: readonly CleanupPlanItem[];
  /** Top-level categories the recipe explicitly RETAINS. */
  readonly retains?: readonly string[] | undefined;
  /**
   * Top-level blockers. A NON-EMPTY blockers list is a HARD STOP — the service
   * refuses `execute` with `CLEANUP_BLOCKED`. Preview surfaces them so the
   * operator resolves them (or the recipe stops listing them) before running.
   */
  readonly blockers?: readonly string[] | undefined;
  /** Projection/scaffolding rebuilds the recipe will perform after cleanup. */
  readonly rebuildActions?: readonly string[] | undefined;
  /** Non-blocking warnings for the operator. */
  readonly warnings?: readonly string[] | undefined;
  /**
   * The exact phrase the operator must type to confirm a destructive run.
   * Defaults (in the service) to the recipe id when omitted.
   */
  readonly confirmationPhrase?: string | undefined;
}

/** A sealed, digest-stamped plan. The digest makes confirmation tamper-evident. */
export interface CleanupPlan {
  readonly recipeId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly items: readonly CleanupPlanItem[];
  readonly retains: readonly string[];
  readonly blockers: readonly string[];
  readonly rebuildActions: readonly string[];
  readonly warnings: readonly string[];
  readonly estimatedTotal: number;
  readonly confirmationPhrase: string;
  /** Deterministic checksum of the plan's material content — see `computePlanDigest`. */
  readonly digest: string;
}

/** One committed step's outcome — reported via `onStep`, folded into the summary. */
export interface CleanupStepResult {
  readonly resource: string;
  readonly processed: number;
  readonly ok: boolean;
  readonly error?: string | undefined;
  /** Opaque resume cursor the recipe may surface for observability. */
  readonly cursor?: string | undefined;
  readonly startedAt?: Date | undefined;
  readonly completedAt?: Date | undefined;
}

/**
 * BOUNDED progress summary persisted on the run (design "Node.js memory"): a
 * fixed-size aggregate, never an unbounded per-chunk array. Detailed steps, if a
 * host wants them, go to a separate capped sink — not this document.
 */
export interface CleanupProgressSummary {
  /** Running total of processed records across all steps. */
  readonly processed: number;
  /** Count of steps reported so far. */
  readonly steps: number;
  /** Resource the last step touched. */
  readonly currentResource?: string | undefined;
  /** Last resume cursor reported. */
  readonly lastCursor?: string | undefined;
  /** When the last step landed — liveness/heartbeat. */
  readonly heartbeatAt?: Date | undefined;
  /** Count of failed steps (a run with any is never a clean success). */
  readonly failed?: number | undefined;
}

/** One verification invariant's outcome. */
export interface VerificationCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string | undefined;
}

/** The recipe's own post-checks — a delete count alone is never success (§9). */
export interface VerificationResult {
  readonly ok: boolean;
  readonly checks: readonly VerificationCheck[];
}

export type CleanupOutcomeStatus = "completed" | "partial" | "failed" | "cancelled";

/** What `execute` returns — the per-step results + a terminal status. */
export interface CleanupResult {
  readonly status: Exclude<CleanupOutcomeStatus, "cancelled">;
  readonly results: readonly CleanupStepResult[];
}

/**
 * The finalization payload persisted ON the run BEFORE it enters `finalizing`
 * (same CAS patch). This is what makes a `finalizing` crash recoverable
 * WITHOUT re-executing the recipe: a recovering worker replays ONLY
 * `evidenceStore.finalize()` + the terminal CAS from this durable snapshot —
 * never `recipe.execute()` again.
 */
export interface CleanupFinalizationPayload {
  readonly status: CleanupOutcomeStatus;
  readonly results: readonly CleanupStepResult[];
  readonly verification: VerificationResult;
  /** Count of verification checks dropped by `maxChecks` truncation. */
  readonly checksTruncated?: number | undefined;
  readonly failureReason?: string | undefined;
}

/**
 * A cleanup recipe — the unit operators choose. Pure provider: the four
 * methods are the only surface arc calls. A recipe delegates the actual
 * domain work to kernel-provided steps; it never runs a raw Mongo cascade.
 */
export interface CleanupRecipe {
  /** Stable machine id, e.g. `'cleanup.pre-live-reset'`. Unique in a registry. */
  readonly id: string;
  /** Plain-language name for the UI. */
  readonly label: string;
  /** Whether this recipe removes data (gates confirmation + single-run fence). */
  readonly destructive: boolean;
  /**
   * Recipe/plan-schema version. Persisted on the run; a retry that finds a
   * different current version requires a fresh preview rather than replaying an
   * incompatible sealed plan. Defaults to `'1'`.
   */
  readonly version?: string;
  /**
   * The purge strategy this recipe's evidence records (`'hard'` deletion,
   * `'soft'` deactivation, `'anonymize'` redaction). Defaults to `'hard'`.
   * A pure projection-rebuild recipe should declare `'soft'` (nothing about the
   * SOURCE data is removed) or, better, the closest honest label — evidence
   * must never overstate destructiveness.
   */
  readonly evidenceStrategy?: PurgeStrategyKind;
  /** Whether this recipe may run right now (e.g. pre-go-live only). */
  available(ctx: CleanupContext): Promise<Availability>;
  /** Compute a preview WITHOUT mutating anything. Idempotent + side-effect-free. */
  plan(input: CleanupInput, ctx: CleanupContext): Promise<CleanupPlanDraft>;
  /** Execute the sealed plan. Must be chunked, idempotent, and cancellation-aware. */
  execute(plan: CleanupPlan, ctx: CleanupExecutionContext): Promise<CleanupResult>;
  /** Verify the post-state — the recipe owns what "clean" means. */
  verify(plan: CleanupPlan, ctx: CleanupContext): Promise<VerificationResult>;
}

// ── Durable run + evidence (§5, §8) ──────────────────────────────────────────

export type CleanupRunStatus =
  | "planned"
  | "queued"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

/** Terminal states — no further transition is valid. */
export const CLEANUP_TERMINAL_STATUSES: readonly CleanupRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export interface CleanupRun {
  readonly id: string;
  readonly recipeId: string;
  readonly recipeVersion: string;
  readonly status: CleanupRunStatus;
  readonly planDigest: string;
  /** The immutable sealed plan — replayed verbatim by the worker / a retry. */
  readonly sealedPlan: CleanupPlan;
  /** The operator-supplied parameters (also inside sealedPlan; kept explicit). */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** The authorizing actor — persisted so a worker attributes the op correctly. */
  readonly actor: PurgeActor;
  /** Serializable ambient scope captured at request time (branch/company). */
  readonly ambient?: Readonly<Record<string, unknown>> | undefined;
  readonly requestedBy: string;
  readonly reason: string;
  readonly operationId: string;
  /**
   * Whether the recipe was destructive at request time — persisted so a
   * GENERIC store can enforce the single-destructive-run policy without
   * consulting the registry (and so non-destructive rebuilds need not
   * serialize behind it).
   */
  readonly destructive: boolean;
  /**
   * Admission-control key the store serializes on (e.g. `'global-destructive'`).
   * Absent for runs that need no mutual exclusion. Hosts may shard it later
   * (`'branch:<id>'`) without an arc change.
   */
  readonly concurrencyKey?: string | undefined;
  /** How many times a worker has claimed this run (1 = first execution). */
  readonly attempt: number;
  /**
   * Exclusive worker lease. A run in `running`/`finalizing` with an UNEXPIRED
   * lease is owned — `claim` refuses it. Progress + status writes carry the
   * token so a stalled ex-owner that wakes past expiry cannot clobber the new
   * owner's writes.
   */
  readonly leaseToken?: string | undefined;
  readonly leaseExpiresAt?: Date | undefined;
  readonly progress: CleanupProgressSummary;
  /** Durable cancellation request — the source of truth the executor polls. */
  readonly cancelRequested: boolean;
  /** Who requested the cancel + why + when (audit — §8, cancel evidence). */
  readonly cancelRequestedBy?: PurgeActor | undefined;
  readonly cancelReason?: string | undefined;
  readonly cancelRequestedAt?: Date | undefined;
  /** Durable finalization snapshot — see {@link CleanupFinalizationPayload}. */
  readonly finalization?: CleanupFinalizationPayload | undefined;
  readonly queuedAt?: Date | undefined;
  readonly startedAt?: Date | undefined;
  readonly completedAt?: Date | undefined;
  readonly failureReason?: string | undefined;
}

/** Immutable proof of a completed run (§5) — deterministically checksummed. */
export interface CleanupManifest {
  readonly runId: string;
  readonly recipeId: string;
  readonly recipeVersion: string;
  readonly operationId: string;
  readonly planDigest: string;
  readonly status: CleanupOutcomeStatus;
  readonly actor: PurgeActor;
  readonly reason: string;
  readonly results: readonly CleanupStepResult[];
  readonly verification: VerificationResult;
  /**
   * Count of verification checks DROPPED by the `maxChecks` cap. Present and
   * non-zero whenever `verification.checks` is not the complete set — evidence
   * must say so rather than silently show only the retained checks.
   */
  readonly checksTruncated?: number | undefined;
  readonly completedAt: Date;
  /**
   * Integrity CHECKSUM of the manifest content (not tamper-PROOF: plain SHA-256
   * does not stop an attacker with write access from replacing the record and
   * recomputing the digest — pair with access control / keyed signatures for
   * that). Detects accidental corruption + drift.
   */
  readonly manifestDigest: string;
}

// ── Host-implemented ports ───────────────────────────────────────────────────

export type CleanupRunCreateResult =
  | { readonly created: true }
  | { readonly created: false; readonly activeRunId: string };

/** Fields a status transition may also patch. */
export interface CleanupRunTransitionPatch {
  readonly queuedAt?: Date;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly failureReason?: string;
  readonly progress?: CleanupProgressSummary;
  /** Reset the cancellation flag — used when a terminal run is re-armed on retry. */
  readonly cancelRequested?: boolean;
  /** Persist the durable finalization snapshot (set entering `finalizing`). */
  readonly finalization?: CleanupFinalizationPayload;
}

/** An exclusive worker lease on a run. */
export interface CleanupLease {
  /** Opaque token identifying THIS worker's ownership of the run. */
  readonly token: string;
  /** When the lease lapses and the run becomes claimable again. */
  readonly expiresAt: Date;
}

/** Metadata persisted with a durable cancel request (audit). */
export interface CleanupCancelRequest {
  readonly actor?: PurgeActor | undefined;
  readonly reason?: string | undefined;
  readonly requestedAt: Date;
}

/**
 * Durable store for cleanup runs. The host owns persistence (Mongo/SQL/…) AND
 * the atomicity of these operations — the framework's safety rests on them:
 *
 *   - `createIfPermitted` MUST be atomic: for a run with a `concurrencyKey` it
 *     inserts ONLY if no other run with the same key is in a non-terminal
 *     state, backed by a unique partial index / conditional insert / lock. A
 *     check-then-create is NOT sufficient. Runs WITHOUT a key are always
 *     admitted.
 *   - `claim` MUST be atomic and EXCLUSIVE: grant the lease ONLY if the run is
 *     `queued`, OR is `running`/`finalizing` with an ABSENT or EXPIRED lease
 *     (`leaseExpiresAt <= now`). On grant it sets `leaseToken`/`leaseExpiresAt`,
 *     increments `attempt`, and returns the run (status UNCHANGED — the service
 *     branches on it: `finalizing` recovers finalization only, never
 *     re-executes). A run whose lease is live is OWNED — return `null`.
 *   - `compareAndTransition` MUST be a compare-and-set: apply the transition
 *     ONLY if the current status is one of `expected` AND, when `leaseToken`
 *     is given, the run's current lease token matches. This is the ONLY way
 *     status changes — it makes cancel-vs-complete AND stale-ex-owner races
 *     safe.
 *   - `reArmIfPermitted` MUST apply the same admission policy as
 *     `createIfPermitted` atomically with the terminal→`queued` transition
 *     (a retry must not slip past the single-destructive-run guard).
 */
export interface CleanupRunStore {
  /** Atomic conditional insert (admission control by `concurrencyKey`, §8). */
  createIfPermitted(run: CleanupRun): Promise<CleanupRunCreateResult>;
  get(id: string): Promise<CleanupRun | null>;
  /**
   * Atomically acquire the exclusive worker lease (see contract above).
   * Returns the claimed run with the lease applied, or `null` if the run is
   * owned, terminal, or missing.
   */
  claim(id: string, lease: CleanupLease): Promise<CleanupRun | null>;
  /**
   * CAS the status: set `status=to` (+ `patch`) ONLY if current status ∈
   * `expected` and (when given) `leaseToken` matches the run's current lease.
   * Returns the updated run, or `null` if the CAS lost the race.
   */
  compareAndTransition(
    id: string,
    expected: readonly CleanupRunStatus[],
    to: CleanupRunStatus,
    patch?: CleanupRunTransitionPatch,
    leaseToken?: string,
  ): Promise<CleanupRun | null>;
  /**
   * Atomically re-arm a terminal (`failed`/`cancelled`) run back to `queued`
   * under the SAME admission policy as `createIfPermitted` (its
   * `concurrencyKey` must not collide with another non-terminal run). Clears
   * the cancel flag/metadata + lease. Returns `{created:false}`-style refusal
   * via `null` + the blocking run id in the second tuple slot is NOT modeled —
   * a `null` simply means "not permitted or not in a terminal state."
   */
  reArmIfPermitted(id: string, patch: CleanupRunTransitionPatch): Promise<CleanupRun | null>;
  /**
   * Set `cancelRequested = true` (+ audit metadata, idempotent — first request
   * wins). Does NOT change `status`.
   */
  requestCancel(id: string, request?: CleanupCancelRequest): Promise<CleanupRun | null>;
  /**
   * Overwrite the small bounded progress summary (frequent, non-status).
   * When `lease` is given, ALSO extend `leaseExpiresAt` (heartbeat renewal) —
   * and apply ONLY if the run's current lease token matches `lease.token`.
   */
  saveProgress(id: string, progress: CleanupProgressSummary, lease?: CleanupLease): Promise<void>;
}

/**
 * Durable store for the evidence + manifest a run leaves behind. `finalize`
 * MUST be idempotent by `evidence.operationId` — a retry / restart that
 * re-finalizes the same operation is a no-op (or an upsert), never a duplicate.
 * Ideally the host writes both in one transaction (with the terminal run
 * transition); the framework tolerates a `finalizing` intermediate + re-run.
 */
export interface CleanupEvidenceStore {
  finalize(input: { evidence: PurgeEvidence; manifest: CleanupManifest }): Promise<void>;
}

/** A serializable job — everything the worker needs is the run id. */
export interface CleanupJob {
  readonly runId: string;
}

/**
 * Durable job queue (§8). `execute()` enqueues a `{ runId }`; a worker later
 * dequeues and calls `service.processRun(runId)` — a DIFFERENT process can do
 * this because the run carries the whole sealed operation. The default in-proc
 * queue defers to a microtask (still off the request path within one process);
 * production injects BullMQ / SQS / a repo-backed queue for cross-process
 * durability, claim/lease, and restart recovery.
 */
export interface CleanupJobQueue {
  enqueue(job: CleanupJob): Promise<void>;
}

/**
 * A company/target write fence (§8) — blocks new writes for the duration of a
 * destructive run. Acquire/release keyed by the operation id so a crashed run's
 * fence is recoverable by op id.
 *
 * `acquire` MAY return a fencing token; when it does, the service passes the
 * SAME token back to `release`, and the fence MUST refuse a release carrying a
 * stale token. This closes the distributed race where a stalled ex-owner wakes
 * after lease expiry and releases the fence out from under the new owner.
 * Implementations without cross-process workers may return `undefined` and
 * ignore the token.
 */
export interface CleanupWriteFence {
  // biome-ignore lint/suspicious/noConfusingVoidType: void keeps plain `async acquire() {}` no-op fences assignable; the token is opt-in.
  acquire(operationId: string): Promise<string | undefined | void>;
  release(operationId: string, token?: string): Promise<void>;
}

export interface CleanupPermissions {
  /** May preview/observe runs. */
  view: CleanupPermissionCheck;
  /** May execute a run. Superadmin in the reference host. */
  execute: CleanupPermissionCheck;
  /** May cancel/retry a run. Defaults to `execute` when omitted. */
  manage?: CleanupPermissionCheck;
}

/** Host permission predicate — receives whatever the host passes as the request scope. */
export type CleanupPermissionCheck = (scope: unknown) => boolean | Promise<boolean>;

/** Framework size caps that keep runs + documents bounded (design "memory"). */
export interface CleanupLimits {
  /** Max plan items. Default 500. */
  readonly maxPlanItems: number;
  /** Max per-run result rows folded into the manifest. Default 1000. */
  readonly maxResults: number;
  /** Max verification checks. Default 200. */
  readonly maxChecks: number;
  /** Max reason string length. Default 2000. */
  readonly maxReasonLength: number;
  /** Max nesting depth of the parameters object. Default 8. */
  readonly maxParamDepth: number;
}

export const DEFAULT_CLEANUP_LIMITS: CleanupLimits = {
  maxPlanItems: 500,
  maxResults: 1000,
  maxChecks: 200,
  maxReasonLength: 2000,
  maxParamDepth: 8,
};
