/**
 * WRITE VERBS — bind a CRUD slot to a domain command, keeping arc's pipeline:
 * `sanitize → tenant → actor stamp → before → around → [VERB] → after`, where
 * the verb stands exactly where `repository.create/update/delete` would.
 *
 * Without this seam a resource whose kernel owns a GUARDED write
 * (`updateDraft()` — refuses once posted) had two options and both dropped a
 * safety property SILENTLY:
 *
 * | you do this | you lose |
 * |---|---|
 * | keep the slot | the kernel's guard — a posted document stays editable through generic CRUD |
 * | override the method | the pipeline — field rules, tenant, actor stamps, hooks stop running |
 *
 * Both were observed on one resource, in that order: closing the first opened
 * the second, and a `PATCH` then wrote `status: "posted"` plus a forged
 * `number` through 8 `systemManaged` fields, answering 200.
 *
 * **Reachability is boot-fatal, not assumed** — a command nothing calls is the
 * same defect one layer up. `defineResource` refuses a controller that lacks
 * `_writes` dispatch, a slot whose method is overridden (the override answers
 * the route; wrap with `hooks` instead), and a malformed or disabled entry.
 *
 * @example
 * ```typescript
 * writes: {
 *   update: (id, data, ctx) => engine.invoices.updateDraft(id, data, resolveCtx(ctx.req)),
 * }
 * ```
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { TransactionHandle } from "@classytic/repo-core/repository";
import type { AnyRecord } from "../base.js";
import type { IRequestContext } from "../handlers.js";

/**
 * What every write verb receives besides its data.
 *
 * `create` gets exactly this shape; `update` / `delete` get the
 * {@link MutationWriteContext} extension, which adds the loaded target.
 */
export interface WriteContext<TDoc = AnyRecord> {
  /**
   * The arc request context. Resolve identity from `ctx.req.scope` via
   * `getUserId` / `getOrgId` — never from headers, and never from `req.user`.
   */
  req: IRequestContext;
  /**
   * The repository arc would have called. Passed so a verb can COMPOSE with
   * the default rather than replace it wholesale (validate, then delegate).
   * Typed as the repo-core contract; a verb owning a richer kit repository
   * usually closes over it directly instead of downcasting this one.
   */
  repository: RepositoryLike<TDoc>;
  /**
   * Present ONLY under `transactional: true`: repo-core's canonical
   * `TransactionHandle` for the transaction this write runs in — imported,
   * never restated, so a field added to the contract reaches write verbs
   * instead of being silently dropped at this boundary.
   * `uow.session` is the raw driver handle — the join point for work OUTSIDE
   * the repository, canonically an outbox row:
   * `outbox.store(event, { session: ctx.uow.session })` commits the event
   * atomically with the business write. Connection-bound backends (SQLite)
   * provide an empty handle; their tx-bound `ctx.repository` is the only
   * join point.
   */
  uow?: TransactionHandle;
}

/**
 * Context for `update` and `delete` verbs — operations with a mutable target.
 *
 * Both fields are REQUIRED, not optional: arc's `loadMutableTarget` preflight
 * (access control, tenant scope, ownership) THROWS before the verb when the
 * target cannot be produced, so by the time a verb runs the target exists.
 * Typing them optional would push a defensive null-check into every command
 * for a case that cannot occur.
 */
export interface MutationWriteContext<TDoc = AnyRecord> extends WriteContext<TDoc> {
  /**
   * The REPOSITORY PRIMARY KEY — identical to the verb's own `id` argument.
   *
   * This is what `repository.update(id, …)` / `.delete(id, …)` would have
   * received, which repo-core types as "update by primary key". It is NOT
   * necessarily the value in the URL: a resource declaring `idField: 'slug'`
   * routes on the slug while its repository keys off `_id`, and arc translates
   * between them (`resolveMutationRepoId`) before either the repository or a
   * verb is called. Handing a verb the raw route param would give a domain
   * command a value its own repository cannot resolve.
   *
   * The route param is still reachable — `ctx.req.params.id`.
   */
  id: string;
  /**
   * The document as arc loaded it to run its permission and tenant checks.
   * Handed over rather than re-fetched by the verb on purpose: a second read
   * can observe a different document than the one the request was authorised
   * against.
   */
  existing: TDoc;
}

/**
 * Per-slot write commands. Every field is optional and independent: declare
 * `update` alone and `create` / `delete` keep calling the repository.
 *
 * **Return contract, and it differs from the repository's on purpose.**
 * A repository signals "not found" by returning `null`; a domain command
 * signals failure by THROWING a typed error. So when a verb is declared:
 *
 *   - `create` — must return the created document. A nullish return is a
 *     CONTRACT VIOLATION and arc throws (a 201 carrying `undefined` data and
 *     after-hooks fed a non-document would be worse than the loud failure).
 *   - `update` — returning the updated document is preferred (it becomes the
 *     response directly). A `void` return is also success — arc issues ONE
 *     repository re-read to answer the request, so a void-returning command
 *     costs one extra read per update. It is never translated into a 404.
 *   - `delete` — `undefined` is success. `deleteDraft()` returns `void`, and
 *     treating that as a miss would answer 404 for a delete that happened.
 */
export interface ResourceWrites<TDoc = AnyRecord> {
  create?(data: Partial<TDoc>, ctx: WriteContext<TDoc>): Promise<TDoc>;
  update?(
    id: string,
    data: Partial<TDoc>,
    ctx: MutationWriteContext<TDoc>,
  ): Promise<TDoc | null | undefined>;
  delete?(id: string, ctx: MutationWriteContext<TDoc>): Promise<unknown>;
}

/**
 * The three slots a write verb may be declared for. Kept in lockstep with the
 * runtime list (`MUTATION_OPERATIONS` in `constants.ts`) by a `satisfies`
 * check at its use sites — drift is a compile error, not a runtime surprise.
 */
export type WriteVerbKey = "create" | "update" | "delete";
