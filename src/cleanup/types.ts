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
 */

import type {
  PurgeActor,
  PurgeEvidence,
  PurgeResourceResult,
  PurgeVerificationSummary,
} from "@classytic/primitives/retention";

export type { PurgeActor, PurgeEvidence, PurgeResourceResult, PurgeVerificationSummary };

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
   * scope, a DB session). Recipes read what they declared they need; the
   * framework never inspects it.
   */
  readonly ambient?: Readonly<Record<string, unknown>> | undefined;
}

export interface CleanupLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Execution-time context — adds progress reporting + the run/operation ids. */
export interface CleanupExecutionContext extends CleanupContext {
  /** Durable run id this execution belongs to. */
  readonly runId: string;
  /** Stable operation id threaded through logs, audit, and evidence. */
  readonly operationId: string;
  /** Persist one completed step's result (call after each committed chunk). */
  onStep(step: CleanupStepResult): void | Promise<void>;
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
  /** Top-level blockers that would abort the run if not resolved. */
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
  /** Deterministic hash of the plan's material content — see `computePlanDigest`. */
  readonly digest: string;
}

/** One committed step's outcome — appended to the run's progress. */
export interface CleanupStepResult {
  readonly resource: string;
  readonly processed: number;
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly startedAt?: Date | undefined;
  readonly completedAt?: Date | undefined;
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

export type CleanupOutcomeStatus = "completed" | "partial" | "failed";

/** What `execute` returns — the per-step results + a terminal status. */
export interface CleanupResult {
  readonly status: CleanupOutcomeStatus;
  readonly results: readonly CleanupStepResult[];
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
  /** Whether this recipe may run right now (e.g. pre-go-live only). */
  available(ctx: CleanupContext): Promise<Availability>;
  /** Compute a preview WITHOUT mutating anything. Idempotent + side-effect-free. */
  plan(input: CleanupInput, ctx: CleanupContext): Promise<CleanupPlanDraft>;
  /** Execute the sealed plan. Must be chunked, idempotent, and abort-aware. */
  execute(plan: CleanupPlan, ctx: CleanupExecutionContext): Promise<CleanupResult>;
  /** Verify the post-state — the recipe owns what "clean" means. */
  verify(plan: CleanupPlan, ctx: CleanupContext): Promise<VerificationResult>;
}

// ── Durable run + evidence (§5) ──────────────────────────────────────────────

export type CleanupRunStatus =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface CleanupRun {
  readonly id: string;
  readonly recipeId: string;
  readonly status: CleanupRunStatus;
  readonly planDigest: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly operationId: string;
  readonly progress: readonly CleanupStepResult[];
  readonly startedAt?: Date | undefined;
  readonly completedAt?: Date | undefined;
}

/** Immutable proof of a completed run (§5) — deterministically hashable. */
export interface CleanupManifest {
  readonly runId: string;
  readonly recipeId: string;
  readonly planDigest: string;
  readonly actor: PurgeActor;
  readonly reason: string;
  readonly results: readonly CleanupStepResult[];
  readonly verification: VerificationResult;
  readonly completedAt: Date;
  readonly manifestDigest: string;
}

// ── Host-implemented ports ───────────────────────────────────────────────────

/** Durable store for cleanup runs. The host owns persistence (Mongo/SQL/…). */
export interface CleanupRunStore {
  create(run: CleanupRun): Promise<void>;
  get(id: string): Promise<CleanupRun | null>;
  /** Shallow-merge a patch onto the run (status/times/progress). */
  update(id: string, patch: Partial<CleanupRun>): Promise<void>;
  /**
   * The single currently-active destructive run, if any — the "one destructive
   * run at a time" guard (§8). Return `null` when none is running.
   */
  findActiveDestructive(): Promise<CleanupRun | null>;
}

/** Durable store for the evidence + manifest a completed run leaves behind. */
export interface CleanupEvidenceStore {
  recordEvidence(evidence: PurgeEvidence): Promise<void>;
  recordManifest(manifest: CleanupManifest): Promise<void>;
}

/**
 * A company/target write fence (§8) — blocks new writes for the duration of a
 * destructive run so cleanup isn't racing live traffic. Acquire/release keyed
 * by the operation id so a crashed run's fence is recoverable by op id.
 */
export interface CleanupWriteFence {
  acquire(operationId: string): Promise<void>;
  release(operationId: string): Promise<void>;
}

/**
 * Runs the recipe's `execute` off the request path (§8) — a worker/queue. The
 * default in-process worker awaits inline; a host wires BullMQ/`createWorker`.
 */
export interface CleanupWorker {
  submit(task: () => Promise<void>): Promise<void>;
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
