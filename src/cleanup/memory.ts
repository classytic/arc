/**
 * In-memory reference implementations of the cleanup ports.
 *
 * These exist for three reasons, in order of importance:
 *
 *   1. **A correctness reference.** `CleanupRunStore`'s atomic semantics
 *      (conditional insert by `concurrencyKey`, EXCLUSIVE lease claim,
 *      lease-guarded CAS, admission-guarded re-arm) are subtle, and getting
 *      them wrong means *double-executing a destructive operation*. These
 *      classes are the executable spec — read them, then mirror the semantics
 *      in your DB adapter and prove it with `runCleanupRunStoreContract`
 *      (`@classytic/arc/testing/cleanup`).
 *   2. **Unit-testing recipes without a database.** Wire a real
 *      `createCleanupService` around these and drive `processRun` directly.
 *   3. **Single-process dev/demo.** NOT for production: state dies with the
 *      process, so a restart loses in-flight runs and their evidence.
 *
 * Mirrors arc's existing `MemoryEventTransport` / `MemoryOutboxStore`
 * convention — the memory implementation ships next to the port it implements.
 *
 * Reads return a SHALLOW COPY so a caller mutating the returned run cannot
 * corrupt stored state (a real store round-trips through the database). Nested
 * values — `sealedPlan` above all — are shared and treated as immutable, which
 * is exactly the framework's contract for a sealed plan.
 */

import type {
  CleanupCancelRequest,
  CleanupEvidenceStore,
  CleanupJob,
  CleanupJobQueue,
  CleanupLease,
  CleanupManifest,
  CleanupProgressSummary,
  CleanupRun,
  CleanupRunCreateResult,
  CleanupRunStatus,
  CleanupRunStore,
  CleanupRunTransitionPatch,
  PurgeEvidence,
} from "./types.js";
import { CLEANUP_TERMINAL_STATUSES } from "./types.js";

/**
 * In-memory {@link CleanupRunStore}. Single-process only — see the module
 * docblock for the production caveat.
 */
export class MemoryCleanupRunStore implements CleanupRunStore {
  /** Live run state, keyed by run id. Exposed for tests/inspection. */
  readonly runs = new Map<string, CleanupRun>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  /** Another NON-TERMINAL run already holding the same concurrency key. */
  #keyConflict(run: Pick<CleanupRun, "id" | "concurrencyKey">): CleanupRun | undefined {
    if (!run.concurrencyKey) return undefined;
    for (const other of this.runs.values()) {
      if (
        other.id !== run.id &&
        other.concurrencyKey === run.concurrencyKey &&
        !CLEANUP_TERMINAL_STATUSES.includes(other.status)
      ) {
        return other;
      }
    }
    return undefined;
  }

  #read(id: string): CleanupRun | undefined {
    return this.runs.get(id);
  }

  /** Store `next` and hand back a copy the caller may freely mutate. */
  #commit(next: CleanupRun): CleanupRun {
    this.runs.set(next.id, next);
    return { ...next };
  }

  async createIfPermitted(run: CleanupRun): Promise<CleanupRunCreateResult> {
    const conflict = this.#keyConflict(run);
    if (conflict) return { created: false, activeRunId: conflict.id };
    this.runs.set(run.id, run);
    return { created: true };
  }

  async get(id: string): Promise<CleanupRun | null> {
    const run = this.#read(id);
    return run ? { ...run } : null;
  }

  async claim(id: string, lease: CleanupLease): Promise<CleanupRun | null> {
    const current = this.#read(id);
    if (!current || CLEANUP_TERMINAL_STATUSES.includes(current.status)) return null;
    // A live lease means another worker owns this run — never steal it.
    const leaseLive =
      current.leaseExpiresAt !== undefined &&
      current.leaseExpiresAt.getTime() > this.#now().getTime();
    const claimable =
      current.status === "queued" ||
      ((current.status === "running" || current.status === "finalizing") && !leaseLive);
    if (!claimable) return null;
    return this.#commit({
      ...current,
      leaseToken: lease.token,
      leaseExpiresAt: lease.expiresAt,
      attempt: current.attempt + 1,
    });
  }

  async compareAndTransition(
    id: string,
    expected: readonly CleanupRunStatus[],
    to: CleanupRunStatus,
    patch?: CleanupRunTransitionPatch,
    leaseToken?: string,
  ): Promise<CleanupRun | null> {
    const current = this.#read(id);
    if (!current || !expected.includes(current.status)) return null;
    // A stalled ex-owner waking past lease expiry must not clobber the new owner.
    if (leaseToken !== undefined && current.leaseToken !== leaseToken) return null;
    return this.#commit({ ...current, ...(patch ?? {}), status: to });
  }

  async reArmIfPermitted(id: string, patch: CleanupRunTransitionPatch): Promise<CleanupRun | null> {
    const current = this.#read(id);
    if (!current || (current.status !== "failed" && current.status !== "cancelled")) return null;
    // Same admission policy as creation — a retry must not slip a second
    // destructive run past the global guard.
    if (this.#keyConflict(current)) return null;
    return this.#commit({
      ...current,
      ...patch,
      status: "queued",
      cancelRequested: false,
      cancelRequestedBy: undefined,
      cancelReason: undefined,
      cancelRequestedAt: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      finalization: undefined,
    });
  }

  async requestCancel(id: string, request?: CleanupCancelRequest): Promise<CleanupRun | null> {
    const current = this.#read(id);
    if (!current) return null;
    return this.#commit({
      ...current,
      cancelRequested: true,
      // Idempotent audit metadata — the FIRST request wins.
      cancelRequestedBy: current.cancelRequestedBy ?? request?.actor,
      cancelReason: current.cancelReason ?? request?.reason,
      cancelRequestedAt: current.cancelRequestedAt ?? request?.requestedAt,
    });
  }

  async saveProgress(
    id: string,
    progress: CleanupProgressSummary,
    lease?: CleanupLease,
  ): Promise<void> {
    const current = this.#read(id);
    if (!current) return;
    if (lease && current.leaseToken !== lease.token) return; // stale ex-owner
    this.#commit({
      ...current,
      progress,
      ...(lease ? { leaseExpiresAt: lease.expiresAt } : {}),
    });
  }
}

/**
 * In-memory {@link CleanupEvidenceStore} — idempotent by
 * `evidence.operationId`, exactly as the port requires.
 */
export class MemoryCleanupEvidenceStore implements CleanupEvidenceStore {
  readonly evidence: PurgeEvidence[] = [];
  readonly manifests: CleanupManifest[] = [];
  readonly #seenOperations = new Set<string>();

  async finalize(input: { evidence: PurgeEvidence; manifest: CleanupManifest }): Promise<void> {
    const operationId = input.evidence.operationId ?? "";
    // A retry / restart that re-finalizes the same operation is a no-op.
    if (this.#seenOperations.has(operationId)) return;
    this.#seenOperations.add(operationId);
    this.evidence.push(input.evidence);
    this.manifests.push(input.manifest);
  }
}

/**
 * A MANUAL in-memory {@link CleanupJobQueue}: it records enqueued jobs and runs
 * nothing on its own, so a test drives the worker deterministically
 * (`for (const job of queue.jobs) await service.processRun(job.runId)`).
 *
 * Note this is NOT the service's default queue — omitting `jobQueue` entirely
 * gives you a microtask-deferred in-process queue that DOES auto-run
 * `processRun` off the request path.
 */
export class MemoryCleanupJobQueue implements CleanupJobQueue {
  readonly jobs: CleanupJob[] = [];

  async enqueue(job: CleanupJob): Promise<void> {
    this.jobs.push(job);
  }

  /** Take everything enqueued so far, clearing the buffer. */
  drain(): CleanupJob[] {
    return this.jobs.splice(0, this.jobs.length);
  }
}
