/**
 * RepositoryLike → OutboxStore adapter.
 *
 * Maps the `OutboxStore` vocabulary (save / claimPending / acknowledge /
 * fail / getDeadLettered / purge) onto arc's own `RepositoryLike` primitives
 * (create / getOne / findAll / deleteMany / findOneAndUpdate). `EventOutbox`
 * wraps a passed repository with this helper when you use the
 * `{ repository }` option; the function is also re-exported from
 * `@classytic/arc/events` so consumers can build and decorate the store
 * manually (metrics, tracing, multi-transport fan-out).
 *
 * Portability: filters compose via `@classytic/repo-core/filter` and
 * updates via `@classytic/repo-core/update`. The primary-key column name
 * is read from `repository.idField` — mongokit defaults to `_id`,
 * sqlitekit / pgkit / prismakit to the schema's declared PK. The adapter
 * therefore runs on any kit that implements `StandardRepo.findOneAndUpdate`
 * + `getOne` + `getAll` + `deleteMany` + `create`.
 *
 * `fail()` is a lease-gated read-then-write pair, preserving `firstFailedAt`
 * across retries without Mongo-specific `$ifNull`. The lease guarantees a
 * single writer during the failure window, so the two calls are safe under
 * concurrent relayers.
 *
 * DO NOT swap `findOneAndUpdate` for `StandardRepo.claim()` — it regresses all
 * three call sites. `claimPending` has no candidate id (finding + claiming in
 * one round trip is the point), so `claim` would double the round trips and
 * open a TOCTOU window. `acknowledge` and `fail` deliberately have loose or
 * absent source-state predicates; `claim` demands an exact `from`, which
 * tightens semantics. A filter-based `claimNext` in a kit would make the FIFO
 * loop adoptable — none ships one today.
 */

import type { OutboxClaimedEvent } from "@classytic/primitives/outbox";
import {
  InvalidOutboxEventError,
  type OutboxAcknowledgeOptions,
  type OutboxClaimOptions,
  type OutboxErrorInfo,
  type OutboxFailOptions,
  OutboxOwnershipError,
  type OutboxStatus,
  type OutboxStore,
  type OutboxWriteOptions,
} from "@classytic/primitives/outbox";
import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { and, anyOf, eq as eqFilter, lte, ne, or } from "@classytic/repo-core/filter";
import { update } from "@classytic/repo-core/update";
import { createIsDuplicateKeyError, createSafeGetOne } from "../utils/store-helpers.js";
import type { DeadLetteredEvent, DomainEvent } from "./EventTransport.js";

/**
 * Outbox row shape. The PK field is determined by the kit's
 * `repository.idField` (mongokit → `_id`, sqlitekit → `id`). Using a
 * generic index signature keeps the interface driver-agnostic without
 * fighting the type system over a dynamic key.
 */
interface OutboxDoc extends Record<string, unknown> {
  readonly event: DomainEvent;
  readonly type: string;
  status: "pending" | "delivered" | "dead_letter";
  attempts: number;
  // The visibility timestamp is NOT declared here: its column is configurable
  // (`visibleAtField`), so it rides the index signature above. Nothing reads it
  // off the doc — the filter and both writers go through `visibleAtField`.
  leaseOwner: string | null;
  /** Fencing token — one per claim epoch. Minted by the `$inc` in the claim CAS. */
  fenceToken?: number;
  leaseExpiresAt: Date | null;
  deliveredAt: Date | null;
  firstFailedAt: Date | null;
  lastFailedAt: Date | null;
  lastError: OutboxErrorInfo | null;
  dedupeKey: string | null;
  partitionKey: string | null;
  headers: Record<string, string> | null;
  createdAt: Date;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_CLAIM_LIMIT = 100;
const DEFAULT_PURGE_BATCH = 500;

/** Column this adapter reads/writes for the visibility timestamp. */
const DEFAULT_VISIBLE_AT_FIELD = "visibleAt";

export interface RepositoryOutboxStoreOptions {
  /**
   * Column holding the "not claimable before" timestamp. Default
   * `'visibleAt'`.
   *
   * Exists so a host with an EXISTING outbox table can adopt this adapter
   * without renaming a column and rebuilding its claim index — the one thing
   * that otherwise forces a migration on the table that guarantees delivery.
   * A store using `nextVisibleAt` (with a `{status, nextVisibleAt, createdAt}`
   * index) passes `{ visibleAtField: 'nextVisibleAt' }` and keeps both.
   *
   * The field is used in the claimable filter, on `save`, and on `fail`'s
   * retry scheduling — all three stay in lockstep by construction.
   */
  readonly visibleAtField?: string;
}

/**
 * What this adapter GUARANTEES, as opposed to what `OutboxStore` permits.
 *
 * Most of the contract is optional so a minimal or non-relational store can implement
 * the floor and no more. This adapter implements all of it, and saying so in the type
 * is not cosmetic: with a plain `OutboxStore` return every caller of `getDeadLettered`,
 * `requeue` or `countByStatus` has to write `store.requeue?.(id)`, and the `?.` silently
 * evaluates to `undefined` if the method ever disappears — an operator's replay that
 * quietly does nothing and reports success.
 */
export type RepositoryOutboxStore = OutboxStore &
  Required<
    Pick<
      OutboxStore,
      "fail" | "getDeadLettered" | "purge" | "requeue" | "countByStatus" | "oldestPendingAgeMs"
    >
  >;

export function repositoryAsOutboxStore(
  repository: RepositoryLike,
  options?: RepositoryOutboxStoreOptions,
): RepositoryOutboxStore {
  const visibleAtField = options?.visibleAtField ?? DEFAULT_VISIBLE_AT_FIELD;
  const missing: string[] = [];
  if (typeof repository.create !== "function") missing.push("create");
  if (typeof repository.getOne !== "function") missing.push("getOne");
  // `getAll` (on repo-core's MinimalRepo) is used for bounded reads —
  // claimPending, getPending, getDeadLettered, and purge batching. We
  // don't require `findAll` because mongokit's findAll has no skip/limit
  // (see 2.10.1 bug report): passing { limit: n } is silently dropped and
  // returns every row.
  if (typeof repository.getAll !== "function") missing.push("getAll");
  if (typeof repository.deleteMany !== "function") missing.push("deleteMany");
  if (typeof repository.findOneAndUpdate !== "function") missing.push("findOneAndUpdate");
  if (missing.length > 0) {
    throw new Error(
      `EventOutbox: repository is missing required methods: ${missing.join(", ")}. ` +
        "mongokit ≥3.10.2 satisfies all five; other kits must implement them to back the outbox.",
    );
  }
  const r = repository as Required<
    Pick<RepositoryLike, "create" | "getOne" | "getAll" | "deleteMany" | "findOneAndUpdate">
  >;

  // Primary-key column name — kits declare on `MinimalRepo.idField`.
  const idField = repository.idField ?? "_id";

  /**
   * Unwrap mongokit's pagination envelope ({ data, total, ... }) — some
   * kits may return a bare array when pagination is disabled. Handle both.
   */
  const unwrapDocs = <T>(result: unknown): T[] => {
    if (Array.isArray(result)) return result as T[];
    const envelope = result as { data?: T[] } | null | undefined;
    return envelope?.data ?? [];
  };

  const isDuplicateKeyError = createIsDuplicateKeyError(repository);
  const safeGetOne = createSafeGetOne(repository);
  const isWellFormed = (event: DomainEvent | undefined): boolean =>
    !!event && typeof event.type === "string" && !!event.meta?.id;

  /**
   * Filter matching every row that's eligible to be claimed by a relayer:
   * status=pending, visible now, and either unleased or under an expired
   * lease. Used by `getPending` and `claimPending` — defined once so the
   * two code paths stay in lockstep.
   */
  const claimableFilter = (now: Date) =>
    and(
      eqFilter("status", "pending"),
      lte(visibleAtField, now),
      or(eqFilter("leaseOwner", null), lte("leaseExpiresAt", now)),
    );

  /**
   * FENCED claim — the ONE claim implementation (`claimPending` delegates).
   * The token rides the SAME CAS that claims the row: `inc: { fenceToken: 1 }`
   * next to the attempts bump, so a takeover after lease expiry mints a
   * strictly greater token in the very statement that takes ownership —
   * no second round trip, no window. Minted by the store; a process cannot
   * fence itself.
   */
  const claimPendingFenced = async (
    options?: OutboxClaimOptions,
  ): Promise<OutboxClaimedEvent[]> => {
    const limit = options?.limit ?? DEFAULT_CLAIM_LIMIT;
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    const consumerId = options?.consumerId ?? "anonymous";
    const typeFilter = options?.types?.length ? anyOf("type", options.types) : null;

    // Two-phase batch claim — the portable optimum:
    //
    //   Phase 1: ONE round trip fetches the FIFO candidate window.
    //   Phase 2: per-id CAS claims run CONCURRENTLY — each
    //            findOneAndUpdate re-checks the full claimable filter, so
    //            a concurrent relayer that wins a doc just nulls it out
    //            here (skipped; the winner owns it).
    //
    // Wall-clock ≈ 2 DB round trips for the whole batch instead of the
    // previous `limit` SEQUENTIAL claim queries (~1s per 100 events at
    // 10ms RTT). A single limited atomic batch-claim is NOT portable —
    // Mongo's updateMany has no limit, so "claim exactly N in one
    // statement" can't be expressed across kits. Backends with stronger
    // primitives (SQL `FOR UPDATE SKIP LOCKED`) can supply their own
    // `OutboxStore` with a native `claimPending` — the store contract IS
    // the batch seam. `StandardRepo.claim` still doesn't apply: it needs
    // an id upfront, and here the CAS *selects* the ids.
    const now = new Date();
    const candidateFilter = typeFilter
      ? and(claimableFilter(now), typeFilter)
      : claimableFilter(now);
    const candidates = unwrapDocs<OutboxDoc>(
      await r.getAll({
        filters: candidateFilter,
        sort: { createdAt: 1 },
        page: 1,
        limit,
      }),
    );
    if (candidates.length === 0) return [];

    const results = await Promise.all(
      candidates.map((candidate) => {
        const claimNow = new Date();
        const leaseExpiresAt = new Date(claimNow.getTime() + leaseMs);
        return r.findOneAndUpdate(
          and(eqFilter(idField, candidate.event.meta.id), claimableFilter(claimNow)),
          update({
            set: { leaseOwner: consumerId, leaseExpiresAt },
            inc: { attempts: 1, fenceToken: 1 },
          }),
          { returnDocument: "after" },
        ) as Promise<OutboxDoc | null>;
      }),
    );

    // Promise.all preserves candidate order → claims stay FIFO.
    return results
      .filter((doc): doc is OutboxDoc => doc !== null)
      .filter((doc) => isWellFormed(doc.event))
      .map((doc) => ({ event: doc.event, fencingToken: doc.fenceToken ?? 0 }));
  };

  return {
    /**
     * Transactional: `save` forwards `options.session` to the backing
     * repository's `create`, so the event row joins the caller's transaction on
     * the SAME connection and commits or rolls back with the domain write.
     *
     * Declared explicitly because `OutboxWriteOptions.session` is best-effort by
     * contract — a caller cannot infer atomicity from the presence of an outbox,
     * only from this flag. See `OutboxStore.transactionalSave` in
     * `@classytic/primitives/outbox`.
     */
    transactionalSave: true,

    async save(event: DomainEvent, options?: OutboxWriteOptions): Promise<void> {
      if (!event?.type || typeof event.type !== "string") {
        throw new InvalidOutboxEventError("event.type is required");
      }
      if (!event.meta?.id || typeof event.meta.id !== "string") {
        throw new InvalidOutboxEventError("event.meta.id is required");
      }
      const now = new Date();
      const doc: OutboxDoc = {
        [idField]: event.meta.id,
        event,
        type: event.type,
        status: "pending",
        attempts: 0,
        [visibleAtField]: options?.visibleAt ?? now,
        leaseOwner: null,
        leaseExpiresAt: null,
        deliveredAt: null,
        firstFailedAt: null,
        lastFailedAt: null,
        lastError: null,
        dedupeKey: options?.dedupeKey ?? null,
        partitionKey: options?.partitionKey ?? null,
        headers: options?.headers ? { ...options.headers } : null,
        createdAt: now,
      };
      try {
        await r.create(doc, options?.session ? { session: options.session } : undefined);
      } catch (err) {
        if (isDuplicateKeyError(err)) return; // idempotent save on dup `_id` / `dedupeKey`
        throw err;
      }
    },

    async getPending(limit: number): Promise<DomainEvent[]> {
      const now = new Date();
      const result = await r.getAll({
        filters: claimableFilter(now),
        sort: { createdAt: 1 },
        page: 1,
        limit,
      });
      const data = unwrapDocs<OutboxDoc>(result);
      return data.map((d) => d.event).filter(isWellFormed);
    },

    async claimPending(options?: OutboxClaimOptions): Promise<DomainEvent[]> {
      return (await claimPendingFenced(options)).map((c) => c.event);
    },
    claimPendingFenced,

    async acknowledge(eventId: string, options?: OutboxAcknowledgeOptions): Promise<void> {
      const now = new Date();
      const baseFilter = and(eqFilter(idField, eventId), ne("status", "delivered"));
      let filter = options?.consumerId
        ? and(baseFilter, eqFilter("leaseOwner", options.consumerId))
        : baseFilter;
      // Fencing guard: the token must be the CURRENT claim epoch's. A stale
      // ex-holder whose consumerId happens to match (ids recur; epochs do
      // not) still misses the filter and lands in the mismatch throw below.
      if (options?.fencingToken !== undefined) {
        filter = and(filter, eqFilter("fenceToken", options.fencingToken));
      }

      const updated = await r.findOneAndUpdate(
        filter,
        update({
          set: {
            status: "delivered",
            deliveredAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        }),
        { returnDocument: "after" },
      );
      if (updated) return;

      const current = (await safeGetOne(eqFilter(idField, eventId))) as OutboxDoc | null;
      if (!current) return; // unknown id → contract no-op
      if (current.status === "delivered") return; // already acked → idempotent
      if (options?.consumerId && current.leaseOwner !== options.consumerId) {
        throw new OutboxOwnershipError(eventId, options.consumerId, current.leaseOwner);
      }
      if (options?.fencingToken !== undefined && current.fenceToken !== options.fencingToken) {
        throw new OutboxOwnershipError(
          eventId,
          `token ${options.fencingToken}`,
          `token ${current.fenceToken}`,
        );
      }
    },

    async fail(
      eventId: string,
      error: OutboxErrorInfo,
      options?: OutboxFailOptions,
    ): Promise<void> {
      const now = new Date();
      const targetStatus: OutboxDoc["status"] = options?.deadLetter ? "dead_letter" : "pending";
      const visibleAt = options?.retryAt ?? now;
      const baseFilter = eqFilter(idField, eventId);
      let filter = options?.consumerId
        ? and(baseFilter, eqFilter("leaseOwner", options.consumerId))
        : baseFilter;
      if (options?.fencingToken !== undefined) {
        filter = and(filter, eqFilter("fenceToken", options.fencingToken));
      }

      // Two-step read-then-write to preserve `firstFailedAt` portably.
      // Mongo's aggregation-pipeline `$ifNull` would do this in a single
      // atomic update, but it's unavailable on SQL kits. Lease ownership
      // (claimPending → fail) ensures single-writer during the failure
      // window, so the two calls are safe. Worst-case race under an
      // expired lease rewrites `firstFailedAt` once — the DLQ semantics
      // stay correct.
      const current = (await safeGetOne(baseFilter)) as OutboxDoc | null;
      if (!current) return;
      if (options?.consumerId && current.leaseOwner !== options.consumerId) {
        throw new OutboxOwnershipError(eventId, options.consumerId, current.leaseOwner);
      }

      const errorInfo: OutboxErrorInfo = error.code
        ? { message: error.message, code: error.code }
        : { message: error.message };
      const firstFailedAt = current.firstFailedAt ?? now;

      const updated = await r.findOneAndUpdate(
        filter,
        update({
          set: {
            status: targetStatus,
            // Same configured column the claimable filter reads — the retry
            // schedule and the claim predicate must never diverge.
            [visibleAtField]: visibleAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastFailedAt: now,
            lastError: errorInfo,
            firstFailedAt,
          },
        }),
        { returnDocument: "after" },
      );
      if (updated) return;

      // findOneAndUpdate returned null. The pre-write `safeGetOne` already
      // confirmed the row exists and (when consumerId was supplied) was
      // owned by this consumer, so a null result here means the lease was
      // stolen between the read and the write. Surface the same
      // OutboxOwnershipError that acknowledge() raises so the caller sees
      // a precise diagnostic instead of a silent no-op. Without consumerId
      // the filter is id-only and a null is only possible if the row was
      // purged mid-flight — fall through to the contract no-op.
      if (options?.consumerId) {
        const after = (await safeGetOne(baseFilter)) as OutboxDoc | null;
        if (after && after.leaseOwner !== options.consumerId) {
          throw new OutboxOwnershipError(eventId, options.consumerId, after.leaseOwner);
        }
      }
    },

    async getDeadLettered(limit: number): Promise<DeadLetteredEvent[]> {
      const result = await r.getAll({
        filters: eqFilter("status", "dead_letter"),
        sort: { [idField]: 1 },
        page: 1,
        limit,
      });
      const data = unwrapDocs<OutboxDoc>(result);
      return data
        .filter((d) => isWellFormed(d.event))
        .map((d) => ({
          event: d.event,
          error: {
            message: d.lastError?.message ?? "unknown",
            ...(d.lastError?.code !== undefined ? { code: d.lastError.code } : {}),
          },
          attempts: d.attempts,
          firstFailedAt: d.firstFailedAt ?? d.lastFailedAt ?? d.createdAt,
          lastFailedAt: d.lastFailedAt ?? d.firstFailedAt ?? d.createdAt,
        }));
    },

    async purge(olderThanMs: number): Promise<number> {
      const cutoff = new Date(Date.now() - olderThanMs);
      let totalDeleted = 0;
      for (;;) {
        const result = await r.getAll({
          filters: and(eqFilter("status", "delivered"), lte("deliveredAt", cutoff)),
          sort: { deliveredAt: 1 },
          page: 1,
          limit: DEFAULT_PURGE_BATCH,
          // `select` is a kit-native projection hint — mongokit accepts a
          // string field name, SQL kits accept a column list. Requesting
          // only the PK keeps the purge round-trip lean without coupling
          // the adapter to either projection dialect (kits that don't
          // recognize the hint simply hydrate every column — correct but
          // less efficient).
          select: idField,
        });
        const batch = unwrapDocs<OutboxDoc>(result);
        if (batch.length === 0) break;
        const ids = batch.map((d) => d[idField] as string);
        const res = (await r.deleteMany(anyOf(idField, ids))) as { deletedCount?: number };
        totalDeleted += res.deletedCount ?? 0;
        if (batch.length < DEFAULT_PURGE_BATCH) break;
      }
      return totalDeleted;
    },

    /**
     * Re-drive one dead-lettered event — the other half of `fail({ deadLetter: true })`.
     *
     * Filtered on `status: 'dead_letter'` as well as the id, so this is a no-op on a row
     * that is merely retrying. Requeuing a backing-off row would zero its attempt count
     * and defeat the failure policy, and the id alone cannot distinguish the two.
     *
     * `attempts` resets because the operator's whole claim is that the CAUSE is fixed:
     * carrying the old count forward would dead-letter the retry again after one more
     * blip, which reads as "the fix did not work".
     */
    async requeue(eventId: string): Promise<boolean> {
      const updated = await r.findOneAndUpdate(
        and(eqFilter(idField, eventId), eqFilter("status", "dead_letter")),
        update({
          set: {
            status: "pending",
            attempts: 0,
            leaseOwner: null,
            leaseExpiresAt: null,
            [visibleAtField]: new Date(),
            lastError: null,
          },
        }),
        { returnDocument: "after" },
      );
      return updated != null;
    },

    /** Rows in `status` — the count behind an operator dashboard or a dead-letter alert. */
    async countByStatus(status: OutboxStatus): Promise<number> {
      const filters = eqFilter("status", status);

      // `count` is a StandardRepo OPTIONAL — every kit that has it answers this in one
      // cheap query. Feature-detected rather than required, because making it mandatory
      // would exclude kits from the outbox for the sake of a dashboard number.
      const counter = (repository as { count?: (f: unknown) => Promise<number> }).count;
      if (typeof counter === "function") return counter.call(repository, filters);

      /**
       * Fallback for a kit without `count`. Two shapes, and the difference decides the
       * query — getting it wrong here produces a number that LIES, which is worse than
       * no number at all: the operator reads a healthy dashboard and stops looking.
       *
       * A paginated kit reports the match count in its envelope, so one row is enough
       * to read it — deliberately not a hydrate-and-length, since a `delivered` count
       * would drag the whole retention window into memory for one integer.
       *
       * A kit that returns a BARE ARRAY has no envelope to read, so the rows ARE the
       * count and every match has to come back. `unwrapDocs` documents that shape as
       * real, so it is not hypothetical. `select: idField` keeps it to one column.
       */
      const probe = (await r.getAll({
        filters,
        page: 1,
        limit: 1,
        select: idField,
      })) as { total?: number; meta?: { total?: number } } | unknown[] | null | undefined;

      if (Array.isArray(probe)) {
        // Bare array: re-read unbounded. Asking with `limit: 1` and returning
        // `.length` would cap every answer at 1 — a 400-row backlog reporting as 1,
        // and a dead-letter alert that can never fire.
        const all = await r.getAll({ filters, select: idField });
        return unwrapDocs(all).length;
      }

      const total = probe?.total ?? probe?.meta?.total;
      if (typeof total === "number") return total;

      /**
       * An envelope in a shape neither branch recognises. Throwing beats returning 0:
       * a zero is indistinguishable from a healthy queue, so it would silence exactly
       * the alert this method exists to raise.
       */
      throw new Error(
        "repositoryAsOutboxStore.countByStatus: the repository's `getAll` returned an " +
          "envelope with no `total` (and is not a bare array), so the count cannot be " +
          "read. Implement `count(filter)` on the repository — every kit that has it " +
          "answers this in one query.",
      );
    },

    /**
     * Age of the oldest PENDING row, or `null` when the queue is empty.
     *
     * The signal a pending count cannot give: a count of 40 looks the same whether the
     * relay is draining briskly or has been wedged for an hour behind one poison row.
     *
     * Measured from `createdAt`, not the last attempt — the question is how long the
     * event has gone undelivered, and restarting the clock on every retry would make a
     * permanently-failing row look permanently fresh, which is the exact row an alert
     * exists to surface.
     */
    async oldestPendingAgeMs(): Promise<number | null> {
      const result = await r.getAll({
        filters: eqFilter("status", "pending"),
        sort: { createdAt: 1 },
        page: 1,
        limit: 1,
      });
      const [oldest] = unwrapDocs<OutboxDoc>(result);
      if (oldest?.createdAt == null) return null;
      return Date.now() - new Date(oldest.createdAt).getTime();
    },
  };
}
