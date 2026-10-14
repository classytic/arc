/**
 * The check → lock protocol every executor (HTTP plugin, MCP tools) runs against a store.
 * A store with `acquire` answers in one atomic round trip; any other store gets the
 * `get` → `tryLock` → recheck sequence, whose recheck closes the finish-before-lock race.
 */

import type { IdempotencyAcquisition, IdempotencyStore } from "./stores/interface.js";

export async function acquireIdempotencyKey(
  store: IdempotencyStore,
  key: string,
  requestId: string,
  lockTtlMs: number,
): Promise<IdempotencyAcquisition> {
  if (typeof store.acquire === "function") return store.acquire(key, requestId, lockTtlMs);
  return acquireBySteps(store, key, requestId, lockTtlMs);
}

/** `get` → `tryLock` → `get`, for stores without an atomic `acquire`. */
export async function acquireBySteps(
  store: Pick<IdempotencyStore, "get" | "tryLock" | "unlock">,
  key: string,
  requestId: string,
  lockTtlMs: number,
): Promise<IdempotencyAcquisition> {
  const cached = await store.get(key);
  if (cached) return { status: "completed", result: cached };
  if (!(await store.tryLock(key, requestId, lockTtlMs))) return { status: "locked" };
  let completed: Awaited<ReturnType<IdempotencyStore["get"]>>;
  try {
    completed = await store.get(key);
  } catch (err) {
    await store.unlock(key, requestId);
    throw err;
  }
  if (!completed) return { status: "acquired" };
  await store.unlock(key, requestId);
  return { status: "completed", result: completed };
}

/** Release a held lock — skipped after a completion that already released it. */
export async function releaseIdempotencyLock(
  store: IdempotencyStore,
  key: string,
  requestId: string,
  completed: boolean,
): Promise<void> {
  if (completed && store.completionReleasesLock === true) return;
  await store.unlock(key, requestId);
}
