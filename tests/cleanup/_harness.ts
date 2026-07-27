/**
 * Test harness for the cleanup service.
 *
 * The in-memory ports are arc's SHIPPED reference implementations
 * (`MemoryCleanupRunStore` & co. from `@classytic/arc/cleanup`) — the suite
 * exercises the very code hosts import, so the reference stores can never
 * silently drift from what the tests prove. Their atomic semantics
 * (conditional insert by concurrencyKey, EXCLUSIVE lease claim, lease-guarded
 * CAS, admission-guarded re-arm) are independently pinned by
 * `runCleanupRunStoreContract` in `memory-contract.test.ts`.
 */
import type { CleanupRecipe } from "../../src/cleanup/index.js";
import {
  MemoryCleanupEvidenceStore,
  MemoryCleanupJobQueue,
  MemoryCleanupRunStore,
} from "../../src/cleanup/index.js";

/** Arc's shipped in-memory run store (`.runs` exposes the raw state). */
export function memRunStore(nowFn: () => Date = () => new Date()): MemoryCleanupRunStore {
  return new MemoryCleanupRunStore(nowFn);
}

/** Arc's shipped in-memory evidence store (`.evidence` / `.manifests`). */
export function memEvidenceStore(): MemoryCleanupEvidenceStore {
  return new MemoryCleanupEvidenceStore();
}

/** Manual queue: captures enqueued runIds; the test drives the worker itself. */
export function manualQueue(): MemoryCleanupJobQueue {
  return new MemoryCleanupJobQueue();
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
