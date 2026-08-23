/**
 * A `transactional: true` write publishes its session on `transactionContext`.
 *
 * Arc shipped both halves of this and never connected them. `auditPlugin`
 * defaults `sessionProvider` to `() => transactionContext.get()` and documents
 * the result as "atomic audit works out of the box" — the audit row committing
 * or rolling back with the domain write. The outbox relay documents the same
 * pattern. But NOTHING in arc's request path ever called
 * `transactionContext.run(session, …)`, so the default resolved to `undefined`
 * on every request and those writes went out session-less, OUTSIDE the
 * transaction they were promised to join. A rollback left the audit row behind.
 *
 * The failure is invisible by construction: the write succeeds, the row exists,
 * and only a rolled-back transaction reveals that the two were never atomic.
 * These tests pin the ambient publication rather than the audit row itself, so
 * they hold for every consumer of the seam (audit, outbox, idempotency) instead
 * of one.
 */

import { describe, expect, it, vi } from "vitest";
import { transactionContext } from "../../src/context/transactionContext.js";
import { BaseCrudController } from "../../src/core/BaseCrudController.js";
import type { IRequestContext } from "../../src/types/index.js";

type AnyRecord = Record<string, unknown>;

/** The session a transactional kit hands back — identity is all that matters. */
const SESSION = { id: "session-1" } as const;

/**
 * A repository whose `withTransaction` behaves like a session-based kit
 * (mongokit): it passes a tx-bound repo AND a `TransactionHandle` carrying the
 * driver session.
 */
function sessionRepo(handle: { session?: unknown } = { session: SESSION }) {
  const repo = {
    capabilities: { transactions: true, transactionRetry: "managed" as const },
    async create(doc: AnyRecord) {
      return { _id: "r1", ...doc };
    },
    async withTransaction<T>(fn: (txRepo: unknown, uow?: unknown) => Promise<T>): Promise<T> {
      return fn(repo, handle);
    },
  };
  return repo;
}

/** Minimal request context — the persistence step reads almost nothing. */
function aRequest(): IRequestContext {
  return { body: { name: "x" }, params: {}, query: {}, headers: {}, metadata: {} } as never;
}

/**
 * Reach the protected persistence step directly. The alternative is driving a
 * full route, which would test routing rather than the seam under test.
 */
function persistenceOf(repo: unknown, transactional: boolean) {
  const controller = new BaseCrudController(repo as never, { transactional });
  return (fn: (repo: unknown, uow?: unknown) => Promise<unknown>) =>
    (
      controller as unknown as {
        runWritePersistence: (f: typeof fn) => Promise<unknown>;
      }
    ).runWritePersistence(fn);
}

describe("transactional writes publish the ambient session", () => {
  it("transactionContext.get() returns the session inside the write", async () => {
    const seen = vi.fn();
    const run = persistenceOf(sessionRepo(), true);

    await run(async () => {
      seen(transactionContext.get());
      return { ok: true };
    });

    // The exact handle the kit produced, not merely "something truthy".
    expect(seen).toHaveBeenCalledWith(SESSION);
  });

  it("a NON-transactional write leaves the context empty", async () => {
    // The other half: publishing unconditionally would tell an audit store it
    // was inside a transaction that does not exist, which is worse than the
    // bug — it would claim atomicity while writing to no session at all.
    const seen = vi.fn();
    const run = persistenceOf(sessionRepo(), false);

    await run(async () => {
      seen(transactionContext.get());
      return { ok: true };
    });

    expect(seen).toHaveBeenCalledWith(undefined);
  });

  it("the session is gone once the write returns", async () => {
    const run = persistenceOf(sessionRepo(), true);
    await run(async () => ({ ok: true }));

    expect(transactionContext.get()).toBeUndefined();
  });

  it("a connection-bound kit's EMPTY handle does not mask an enclosing scope", async () => {
    // SQLite-style kits pass `{}` — their tx-bound repo is the only join
    // point. Entering the scope with `undefined` there would blank out an
    // outer session a caller had legitimately installed.
    const outer = { id: "outer-session" };
    const seen = vi.fn();
    const run = persistenceOf(sessionRepo({}), true);

    await transactionContext.run(outer, async () => {
      await run(async () => {
        seen(transactionContext.get());
        return { ok: true };
      });
    });

    expect(seen).toHaveBeenCalledWith(outer);
  });

  it("the tx-bound repository still reaches the callback", async () => {
    // Guards the wrapping itself: publishing the session must not disturb
    // what `retryingTransaction` hands the persistence function.
    const repo = sessionRepo();
    const run = persistenceOf(repo, true);
    const seen = vi.fn();

    await run(async (txRepo, uow) => {
      seen({ isRepo: txRepo === repo, session: (uow as { session?: unknown })?.session });
      return { ok: true };
    });

    expect(seen).toHaveBeenCalledWith({ isRepo: true, session: SESSION });
  });
});
