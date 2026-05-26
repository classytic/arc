/**
 * Transaction Context via AsyncLocalStorage
 *
 * Provides a Unit-of-Work (UoW) hook so any code in the call stack can
 * retrieve the active database session/transaction without it being threaded
 * through every function parameter.
 *
 * Arc is DB-agnostic — the session type is `unknown` so any backend
 * (Mongoose session, Prisma transaction, pg client, Drizzle client) can
 * participate. Kit adapters call `runInTransaction(session, fn)` to install
 * the active context; the outbox's `store()` reads it automatically when no
 * explicit `options.session` is passed.
 *
 * @example
 * ```typescript
 * // In a Mongoose-backed service (mongokit adapter)
 * import { transactionContext } from '@classytic/arc/context';
 *
 * await mongoose.connection.withSession(async (session) => {
 *   await session.withTransaction(async () => {
 *     await transactionContext.run(session, async () => {
 *       await orders.insertOne(order, { session });
 *       // outbox.store() auto-picks up `session` — no manual threading
 *       await outbox.store(orderCreatedEvent);
 *     });
 *   });
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Opt-out: explicit session always wins over the ALS context
 * await outbox.store(event, { session: explicitSession });
 * ```
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** DB session/transaction handle. Typed as unknown — arc is DB-agnostic. */
export type DbSession = unknown;

const storage = new AsyncLocalStorage<DbSession>();

/**
 * Transaction context API.
 *
 * - `run(session, fn)` — install an active DB session for the duration of `fn`
 * - `get()` — read the current session (undefined if outside a transaction scope)
 */
export const transactionContext = {
  /**
   * Run `fn` with `session` as the active DB transaction context.
   * Any call to `get()` within `fn`'s async call stack returns `session`.
   */
  run<T>(session: DbSession, fn: () => T): T {
    return storage.run(session, fn);
  },

  /**
   * Get the current DB session, or `undefined` if not inside a
   * `transactionContext.run(...)` scope.
   */
  get(): DbSession | undefined {
    return storage.getStore();
  },

  /** The underlying AsyncLocalStorage instance. Exposed for advanced integrations. */
  storage,
};
