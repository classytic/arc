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
 * `fail()` uses a lease-gated read-then-write pair to preserve
 * `firstFailedAt` across retries without relying on Mongo's aggregation-
 * pipeline `$ifNull`. Leases guarantee single-writer during the failure
 * window (`claimPending` filters out non-owned rows), so the two calls are
 * safe under concurrent relayers.
 */

import { and, anyOf, eq as eqFilter, lte, ne, or } from "@classytic/repo-core/filter";
import { update } from "@classytic/repo-core/update";
import type { RepositoryLike } from "../adapters/interface.js";
import { createIsDuplicateKeyError, createSafeGetOne } from "../adapters/store-helpers.js";
import type { DeadLetteredEvent, DomainEvent } from "./EventTransport.js";
import {
  InvalidOutboxEventError,
  type OutboxAcknowledgeOptions,
  type OutboxClaimOptions,
  type OutboxErrorInfo,
  type OutboxFailOptions,
  OutboxOwnershipError,
  type OutboxStore,
  type OutboxWriteOptions,
} from "./outbox.js";

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
  visibleAt: Date;
  leaseOwner: string | null;
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

export function repositoryAsOutboxStore(repository: RepositoryLike): OutboxStore {
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
   * Unwrap mongokit's pagination envelope ({ docs, total, ... }) — some
   * kits may return a bare array when pagination is disabled. Handle both.
   */
  const unwrapDocs = <T>(result: unknown): T[] => {
    if (Array.isArray(result)) return result as T[];
    const envelope = result as { docs?: T[] } | null | undefined;
    return envelope?.docs ?? [];
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
      lte("visibleAt", now),
      or(eqFilter("leaseOwner", null), lte("leaseExpiresAt", now)),
    );

  return {
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
        visibleAt: options?.visibleAt ?? now,
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
      const docs = unwrapDocs<OutboxDoc>(result);
      return docs.map((d) => d.event).filter(isWellFormed);
    },

    async claimPending(options?: OutboxClaimOptions): Promise<DomainEvent[]> {
      const limit = options?.limit ?? DEFAULT_CLAIM_LIMIT;
      const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
      const consumerId = options?.consumerId ?? "anonymous";
      const typeFilter = options?.types?.length ? anyOf("type", options.types) : null;

      const claimed: DomainEvent[] = [];
      // Atomic per-doc FIFO claim via findOneAndUpdate. The compound filter
      // excludes docs under an active lease, so concurrent relayers never
      // see the same doc.
      for (let i = 0; i < limit; i++) {
        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + leaseMs);
        const filter = typeFilter ? and(claimableFilter(now), typeFilter) : claimableFilter(now);
        const doc = (await r.findOneAndUpdate(
          filter,
          update({
            set: { leaseOwner: consumerId, leaseExpiresAt },
            inc: { attempts: 1 },
          }),
          { sort: { createdAt: 1 }, returnDocument: "after" },
        )) as OutboxDoc | null;
        if (!doc) break;
        if (isWellFormed(doc.event)) claimed.push(doc.event);
      }
      return claimed;
    },

    async acknowledge(eventId: string, options?: OutboxAcknowledgeOptions): Promise<void> {
      const now = new Date();
      const baseFilter = and(eqFilter(idField, eventId), ne("status", "delivered"));
      const filter = options?.consumerId
        ? and(baseFilter, eqFilter("leaseOwner", options.consumerId))
        : baseFilter;

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
      const filter = options?.consumerId
        ? and(baseFilter, eqFilter("leaseOwner", options.consumerId))
        : baseFilter;

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
            visibleAt,
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
      const docs = unwrapDocs<OutboxDoc>(result);
      return docs
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
  };
}
