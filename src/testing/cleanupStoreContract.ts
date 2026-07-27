/**
 * Cleanup Run-Store Contract Suite
 *
 * `CleanupRunStore` is the durability substrate of the Data Cleanup Center: its
 * atomic guarantees are the only thing standing between a crash and a
 * *double-executed destructive operation*. The semantics are subtle —
 * conditional insert by `concurrencyKey`, EXCLUSIVE lease claim with crash
 * recovery, lease-guarded CAS, admission-guarded re-arm — and a plausible-looking
 * adapter can get them wrong in ways no ordinary test catches.
 *
 * Any implementation can import this suite and run it against a live instance.
 * Passing it IS the contract.
 *
 * @example
 * ```typescript
 * import { runCleanupRunStoreContract } from '@classytic/arc/testing/cleanup';
 * import { mongoCleanupRunStore } from '../src/cleanup/mongo-run-store.js';
 *
 * runCleanupRunStoreContract('mongoCleanupRunStore', async () => {
 *   const store = mongoCleanupRunStore(connection);
 *   return { store, teardown: async () => connection.dropCollection('cleanup_runs') };
 * });
 * ```
 *
 * Time is exercised through lease `expiresAt` values in the past/future rather
 * than a clock hook, so the suite works unmodified against a real database
 * comparing to wall-clock `now`.
 *
 * This module statically imports `vitest`. Only load it from test code — arc's
 * production bundle never references this subpath, so the import tree stays
 * clean under tree-shaking.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CleanupPlan, CleanupRun, CleanupRunStore } from "../cleanup/types.js";

// ============================================================================
// Types
// ============================================================================

export interface CleanupRunStoreContractSetupResult {
  store: CleanupRunStore;
  teardown?: () => Promise<void>;
}

export type CleanupRunStoreContractSetup = () => Promise<CleanupRunStoreContractSetupResult>;

// ============================================================================
// Fixtures
// ============================================================================

const ACTOR = { ref: "user:contract", kind: "user" as const };

function plan(recipeId: string): CleanupPlan {
  return {
    recipeId,
    parameters: {},
    items: [{ resource: "orders", estimated: 1 }],
    retains: [],
    blockers: [],
    rebuildActions: [],
    warnings: [],
    estimatedTotal: 1,
    confirmationPhrase: recipeId,
    digest: `digest-${recipeId}`,
  };
}

/** A queued run. `concurrencyKey` is opt-in so key-free runs can be exercised. */
function makeRun(id: string, overrides: Partial<CleanupRun> = {}): CleanupRun {
  return {
    id,
    recipeId: "contract.recipe",
    recipeVersion: "1",
    status: "queued",
    planDigest: `digest-${id}`,
    sealedPlan: plan("contract.recipe"),
    parameters: {},
    actor: ACTOR,
    requestedBy: ACTOR.ref,
    reason: "contract suite",
    operationId: `op-${id}`,
    destructive: true,
    attempt: 0,
    progress: { processed: 0, steps: 0 },
    cancelRequested: false,
    queuedAt: new Date(),
    ...overrides,
  };
}

const future = (ms = 60_000) => new Date(Date.now() + ms);
const past = (ms = 60_000) => new Date(Date.now() - ms);

// ============================================================================
// Suite
// ============================================================================

export function runCleanupRunStoreContract(
  name: string,
  setup: CleanupRunStoreContractSetup,
): void {
  describe(`CleanupRunStore contract: ${name}`, () => {
    let store: CleanupRunStore;
    let teardown: (() => Promise<void>) | undefined;
    // Unique ids keep tests independent when one store serves the whole suite.
    let seq = 0;
    const uid = (label: string) => `${label}-${Date.now()}-${seq++}`;

    beforeAll(async () => {
      const result = await setup();
      store = result.store;
      teardown = result.teardown;
    });

    afterAll(async () => {
      if (teardown) await teardown();
    });

    describe("createIfPermitted — admission control", () => {
      it("inserts a run and makes it readable", async () => {
        const run = makeRun(uid("insert"), { concurrencyKey: undefined });
        expect(await store.createIfPermitted(run)).toEqual({ created: true });

        const stored = await store.get(run.id);
        expect(stored?.id).toBe(run.id);
        expect(stored?.status).toBe("queued");
      });

      it("returns null from get() for an unknown id", async () => {
        expect(await store.get(uid("missing"))).toBeNull();
      });

      it("refuses a second non-terminal run holding the same concurrencyKey", async () => {
        const key = uid("key");
        const first = makeRun(uid("first"), { concurrencyKey: key });
        const second = makeRun(uid("second"), { concurrencyKey: key });

        expect(await store.createIfPermitted(first)).toEqual({ created: true });

        const result = await store.createIfPermitted(second);
        expect(result.created).toBe(false);
        // The blocking run must be named so the caller can report it. Narrow the
        // union (a plain value check doesn't narrow the discriminant) before
        // reading the refusal-only field.
        if (result.created === false) {
          expect(result.activeRunId).toBe(first.id);
        }
        // ...and the refused run must NOT have been written.
        expect(await store.get(second.id)).toBeNull();
      });

      it("admits the key again once the holder reaches a terminal status", async () => {
        const key = uid("key-free");
        const first = makeRun(uid("holder"), { concurrencyKey: key });
        await store.createIfPermitted(first);
        await store.compareAndTransition(first.id, ["queued"], "completed");

        const next = makeRun(uid("next"), { concurrencyKey: key });
        expect(await store.createIfPermitted(next)).toEqual({ created: true });
      });

      it("never serializes runs that carry no concurrencyKey", async () => {
        const a = makeRun(uid("keyless-a"), { concurrencyKey: undefined });
        const b = makeRun(uid("keyless-b"), { concurrencyKey: undefined });
        expect(await store.createIfPermitted(a)).toEqual({ created: true });
        expect(await store.createIfPermitted(b)).toEqual({ created: true });
      });
    });

    describe("claim — exclusive worker lease", () => {
      it("grants the lease on a queued run and counts the attempt", async () => {
        const run = makeRun(uid("claim"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);

        const token = uid("token");
        const claimed = await store.claim(run.id, { token, expiresAt: future() });
        expect(claimed).not.toBeNull();
        expect(claimed?.leaseToken).toBe(token);
        expect(claimed?.attempt).toBe(run.attempt + 1);
      });

      it("refuses a run whose lease is still live (another worker owns it)", async () => {
        const run = makeRun(uid("owned"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        await store.claim(run.id, { token: uid("owner"), expiresAt: future() });
        await store.compareAndTransition(run.id, ["queued"], "running");

        const stolen = await store.claim(run.id, { token: uid("thief"), expiresAt: future() });
        expect(stolen).toBeNull();
      });

      it("recovers a running run whose lease EXPIRED (crash recovery)", async () => {
        const run = makeRun(uid("crashed"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        // Previous owner died holding an already-expired lease.
        await store.claim(run.id, { token: uid("dead"), expiresAt: past() });
        await store.compareAndTransition(run.id, ["queued"], "running");

        const token = uid("recovered");
        const reclaimed = await store.claim(run.id, { token, expiresAt: future() });
        expect(reclaimed).not.toBeNull();
        expect(reclaimed?.leaseToken).toBe(token);
      });

      it("recovers a finalizing run whose lease expired", async () => {
        const run = makeRun(uid("finalizing"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        await store.claim(run.id, { token: uid("dead"), expiresAt: past() });
        await store.compareAndTransition(run.id, ["queued"], "running");
        await store.compareAndTransition(run.id, ["running"], "finalizing");

        const reclaimed = await store.claim(run.id, {
          token: uid("recovered"),
          expiresAt: future(),
        });
        expect(reclaimed).not.toBeNull();
        expect(reclaimed?.status).toBe("finalizing");
      });

      it("refuses a terminal run", async () => {
        const run = makeRun(uid("terminal"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        await store.compareAndTransition(run.id, ["queued"], "completed");

        expect(await store.claim(run.id, { token: uid("t"), expiresAt: future() })).toBeNull();
      });

      it("refuses an unknown run", async () => {
        expect(await store.claim(uid("ghost"), { token: "t", expiresAt: future() })).toBeNull();
      });
    });

    describe("compareAndTransition — guarded status change", () => {
      it("applies the status and the patch when the current status matches", async () => {
        const run = makeRun(uid("cas"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);

        const started = new Date();
        const updated = await store.compareAndTransition(run.id, ["queued"], "running", {
          startedAt: started,
        });
        expect(updated?.status).toBe("running");
        expect(updated?.startedAt?.getTime()).toBe(started.getTime());
        expect((await store.get(run.id))?.status).toBe("running");
      });

      it("refuses when the current status is not in `expected`", async () => {
        const run = makeRun(uid("wrong-state"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);

        expect(await store.compareAndTransition(run.id, ["running"], "completed")).toBeNull();
        expect((await store.get(run.id))?.status).toBe("queued");
      });

      it("refuses a stale ex-owner's write (lease-token mismatch)", async () => {
        const run = makeRun(uid("stale"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        await store.claim(run.id, { token: uid("dead"), expiresAt: past() });
        await store.compareAndTransition(run.id, ["queued"], "running");

        // New owner takes over.
        const live = uid("live");
        await store.claim(run.id, { token: live, expiresAt: future() });

        // The stalled ex-owner wakes and tries to complete the run — it MUST lose.
        const clobbered = await store.compareAndTransition(
          run.id,
          ["running"],
          "completed",
          { completedAt: new Date() },
          "a-stale-token",
        );
        expect(clobbered).toBeNull();
        expect((await store.get(run.id))?.status).toBe("running");

        // The live owner's write, carrying the right token, succeeds.
        const ok = await store.compareAndTransition(
          run.id,
          ["running"],
          "completed",
          undefined,
          live,
        );
        expect(ok?.status).toBe("completed");
      });
    });

    describe("requestCancel — durable cancellation flag", () => {
      it("sets the flag with audit metadata WITHOUT changing status", async () => {
        const run = makeRun(uid("cancel"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        await store.compareAndTransition(run.id, ["queued"], "running");

        const requestedAt = new Date();
        await store.requestCancel(run.id, {
          actor: ACTOR,
          reason: "operator changed their mind",
          requestedAt,
        });

        const stored = await store.get(run.id);
        expect(stored?.cancelRequested).toBe(true);
        expect(stored?.cancelReason).toBe("operator changed their mind");
        expect(stored?.cancelRequestedBy?.ref).toBe(ACTOR.ref);
        // Cancellation is cooperative — the executor settles the status itself.
        expect(stored?.status).toBe("running");
      });

      it("is idempotent — the FIRST request's audit metadata wins", async () => {
        const run = makeRun(uid("cancel-twice"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);

        await store.requestCancel(run.id, {
          actor: ACTOR,
          reason: "first",
          requestedAt: new Date(),
        });
        await store.requestCancel(run.id, {
          actor: { ref: "user:other", kind: "user" },
          reason: "second",
          requestedAt: new Date(),
        });

        const stored = await store.get(run.id);
        expect(stored?.cancelReason).toBe("first");
        expect(stored?.cancelRequestedBy?.ref).toBe(ACTOR.ref);
      });
    });

    describe("saveProgress — heartbeat + bounded summary", () => {
      it("updates progress and extends the lease for the current owner", async () => {
        const run = makeRun(uid("progress"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        const token = uid("owner");
        await store.claim(run.id, { token, expiresAt: future(1000) });

        const renewed = future(120_000);
        await store.saveProgress(run.id, { processed: 7, steps: 2 }, { token, expiresAt: renewed });

        const stored = await store.get(run.id);
        expect(stored?.progress.processed).toBe(7);
        expect(stored?.progress.steps).toBe(2);
        expect(stored?.leaseExpiresAt?.getTime()).toBe(renewed.getTime());
      });

      it("ignores a write from a stale ex-owner", async () => {
        const run = makeRun(uid("progress-stale"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        const live = uid("live");
        await store.claim(run.id, { token: live, expiresAt: future() });
        await store.saveProgress(
          run.id,
          { processed: 5, steps: 1 },
          { token: live, expiresAt: future() },
        );

        await store.saveProgress(
          run.id,
          { processed: 999, steps: 999 },
          { token: "a-stale-token", expiresAt: future() },
        );

        expect((await store.get(run.id))?.progress.processed).toBe(5);
      });
    });

    describe("reArmIfPermitted — retry under the creation admission policy", () => {
      it("re-queues a failed run and clears cancel + lease + finalization state", async () => {
        const run = makeRun(uid("rearm"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        const token = uid("owner");
        await store.claim(run.id, { token, expiresAt: future() });
        await store.compareAndTransition(run.id, ["queued"], "running", undefined, token);
        await store.requestCancel(run.id, {
          actor: ACTOR,
          reason: "stop",
          requestedAt: new Date(),
        });
        await store.compareAndTransition(run.id, ["running"], "failed", undefined, token);

        const requeued = await store.reArmIfPermitted(run.id, {
          queuedAt: new Date(),
          cancelRequested: false,
        });

        expect(requeued?.status).toBe("queued");
        // A retry must start clean: a leftover cancel flag would abort it instantly,
        // and a leftover lease would block the next worker's claim.
        expect(requeued?.cancelRequested).toBe(false);
        expect(requeued?.leaseToken).toBeUndefined();
        expect(requeued?.finalization).toBeUndefined();
      });

      it("re-queues a cancelled run", async () => {
        const run = makeRun(uid("rearm-cancelled"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        await store.compareAndTransition(run.id, ["queued"], "cancelled");

        const requeued = await store.reArmIfPermitted(run.id, { queuedAt: new Date() });
        expect(requeued?.status).toBe("queued");
      });

      it("refuses a run that is not in a terminal status", async () => {
        const run = makeRun(uid("rearm-live"), { concurrencyKey: undefined });
        await store.createIfPermitted(run);
        expect(await store.reArmIfPermitted(run.id, { queuedAt: new Date() })).toBeNull();
      });

      it("refuses when another non-terminal run holds the same concurrencyKey", async () => {
        const key = uid("rearm-key");
        const failed = makeRun(uid("rearm-blocked"), { concurrencyKey: key });
        await store.createIfPermitted(failed);
        await store.compareAndTransition(failed.id, ["queued"], "failed");

        // Someone else takes the slot while the failed run sits there.
        const active = makeRun(uid("rearm-active"), { concurrencyKey: key });
        expect(await store.createIfPermitted(active)).toEqual({ created: true });

        // Retrying the old run must NOT slip a second destructive run past the guard.
        expect(await store.reArmIfPermitted(failed.id, { queuedAt: new Date() })).toBeNull();
      });
    });
  });
}
