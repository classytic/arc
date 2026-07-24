/**
 * In-memory test harness for the cleanup service — models the ATOMIC semantics
 * the real ports must provide (conditional insert + CAS transitions), plus a
 * MANUAL job queue so tests drive the worker deterministically.
 */
import type {
  CleanupEvidenceStore,
  CleanupJob,
  CleanupJobQueue,
  CleanupManifest,
  CleanupProgressSummary,
  CleanupRecipe,
  CleanupRun,
  CleanupRunCreateResult,
  CleanupRunStatus,
  CleanupRunStore,
  CleanupRunTransitionPatch,
  PurgeEvidence,
} from "../../src/cleanup/index.js";
import { CLEANUP_TERMINAL_STATUSES } from "../../src/cleanup/index.js";

export function memRunStore() {
  const runs = new Map<string, CleanupRun>();
  const store: CleanupRunStore = {
    async createIfPermitted(run): Promise<CleanupRunCreateResult> {
      // Atomic single-active guard: a destructive world allows only one
      // non-terminal run at a time (matches a unique partial index).
      for (const r of runs.values()) {
        if (!CLEANUP_TERMINAL_STATUSES.includes(r.status)) {
          return { created: false, activeRunId: r.id };
        }
      }
      runs.set(run.id, run);
      return { created: true };
    },
    async get(id) {
      return runs.get(id) ?? null;
    },
    async compareAndTransition(id, expected, to, patch?: CleanupRunTransitionPatch) {
      const cur = runs.get(id);
      if (!cur || !expected.includes(cur.status)) return null;
      const next: CleanupRun = { ...cur, ...(patch ?? {}), status: to as CleanupRunStatus };
      runs.set(id, next);
      return next;
    },
    async requestCancel(id) {
      const cur = runs.get(id);
      if (!cur) return null;
      const next = { ...cur, cancelRequested: true };
      runs.set(id, next);
      return next;
    },
    async saveProgress(id, progress: CleanupProgressSummary) {
      const cur = runs.get(id);
      if (cur) runs.set(id, { ...cur, progress });
    },
  };
  return Object.assign(store, { runs });
}

export function memEvidenceStore() {
  const evidence: PurgeEvidence[] = [];
  const manifests: CleanupManifest[] = [];
  const seenOps = new Set<string>();
  const store: CleanupEvidenceStore = {
    async finalize({ evidence: e, manifest }) {
      // Idempotent by operationId (a retry/restart re-finalize is a no-op).
      const op = e.operationId ?? "";
      if (seenOps.has(op)) return;
      seenOps.add(op);
      evidence.push(e);
      manifests.push(manifest);
    },
  };
  return Object.assign(store, { evidence, manifests });
}

/** Manual queue: captures enqueued runIds; the test calls the drain fn. */
export function manualQueue() {
  const jobs: CleanupJob[] = [];
  const queue: CleanupJobQueue = {
    async enqueue(job) {
      jobs.push(job);
    },
  };
  return Object.assign(queue, { jobs });
}

/** Assert non-null without a `!` (biome forbids non-null assertions in tests). */
export function must<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

export const actor = { ref: "user:admin", kind: "user" as const };

/** A destructive recipe with test-overridable behavior. */
export function draftsRecipe(over: Partial<CleanupRecipe> = {}): CleanupRecipe {
  return {
    id: "cleanup.drafts",
    label: "Remove drafts",
    destructive: true,
    version: "1",
    available: async () => ({ available: true }),
    plan: async () => ({
      items: [{ resource: "orders", estimated: 3 }],
      retains: ["master data"],
      confirmationPhrase: "REMOVE DRAFTS",
    }),
    execute: async (_plan, ctx) => {
      await ctx.onStep({ resource: "orders", processed: 3, ok: true });
      return { status: "completed", results: [{ resource: "orders", processed: 3, ok: true }] };
    },
    verify: async () => ({ ok: true, checks: [{ name: "no drafts remain", ok: true }] }),
    ...over,
  };
}

export function fixedNow() {
  return () => new Date("2026-07-24T00:00:00.000Z");
}

export function seqId() {
  let n = 0;
  return () => `id-${n++}`;
}
