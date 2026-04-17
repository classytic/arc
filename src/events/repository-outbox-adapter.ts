/**
 * Internal: RepositoryLike → OutboxStore inline adapter.
 *
 * Maps the `OutboxStore` vocabulary (save / claimPending / acknowledge /
 * fail / getDeadLettered / purge) onto arc's own `RepositoryLike` primitives
 * (create / getOne / findAll / deleteMany / findOneAndUpdate). Not exported
 * publicly — `EventOutbox` wraps a passed repository with this helper when
 * you use the `{ repository }` option.
 *
 * Requires mongokit ≥3.8 (or equivalent) — `findOneAndUpdate` is essential
 * for the atomic FIFO claim-lease loop.
 */

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

interface OutboxDoc {
  readonly _id: string;
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
  if (typeof repository.findAll !== "function") missing.push("findAll");
  if (typeof repository.deleteMany !== "function") missing.push("deleteMany");
  if (typeof repository.findOneAndUpdate !== "function") missing.push("findOneAndUpdate");
  if (missing.length > 0) {
    throw new Error(
      `EventOutbox: repository is missing required methods: ${missing.join(", ")}. ` +
        "mongokit ≥3.8 satisfies all five; other kits must implement them to back the outbox.",
    );
  }
  const r = repository as Required<
    Pick<RepositoryLike, "create" | "getOne" | "findAll" | "deleteMany" | "findOneAndUpdate">
  >;

  const isDuplicateKeyError = createIsDuplicateKeyError(repository);
  const safeGetOne = createSafeGetOne(repository);
  const isWellFormed = (event: DomainEvent | undefined): boolean =>
    !!event && typeof event.type === "string" && !!event.meta?.id;

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
        _id: event.meta.id,
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
      const docs = (await r.findAll(
        {
          status: "pending",
          visibleAt: { $lte: now },
          $or: [{ leaseOwner: null }, { leaseExpiresAt: { $lte: now } }],
        },
        { sort: { createdAt: 1 }, limit },
      )) as OutboxDoc[];
      return docs.map((d) => d.event).filter(isWellFormed);
    },

    async claimPending(options?: OutboxClaimOptions): Promise<DomainEvent[]> {
      const limit = options?.limit ?? DEFAULT_CLAIM_LIMIT;
      const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
      const consumerId = options?.consumerId ?? "anonymous";
      const typeFilter = options?.types?.length
        ? ({ type: { $in: options.types } } as Record<string, unknown>)
        : {};

      const claimed: DomainEvent[] = [];
      // Atomic per-doc FIFO claim via findOneAndUpdate. The compound filter
      // excludes docs under an active lease, so concurrent relayers never
      // see the same doc.
      for (let i = 0; i < limit; i++) {
        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + leaseMs);
        const doc = (await r.findOneAndUpdate(
          {
            status: "pending",
            visibleAt: { $lte: now },
            $or: [{ leaseOwner: null }, { leaseExpiresAt: { $lte: now } }],
            ...typeFilter,
          },
          { $set: { leaseOwner: consumerId, leaseExpiresAt }, $inc: { attempts: 1 } },
          { sort: { createdAt: 1 }, returnDocument: "after" },
        )) as OutboxDoc | null;
        if (!doc) break;
        if (isWellFormed(doc.event)) claimed.push(doc.event);
      }
      return claimed;
    },

    async acknowledge(eventId: string, options?: OutboxAcknowledgeOptions): Promise<void> {
      const now = new Date();
      const filter: Record<string, unknown> = {
        _id: eventId,
        status: { $ne: "delivered" },
      };
      if (options?.consumerId) filter.leaseOwner = options.consumerId;

      const updated = await r.findOneAndUpdate(
        filter,
        {
          $set: {
            status: "delivered",
            deliveredAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        },
        { returnDocument: "after" },
      );
      if (updated) return;

      const current = (await safeGetOne({ _id: eventId })) as OutboxDoc | null;
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
      const filter: Record<string, unknown> = { _id: eventId };
      if (options?.consumerId) filter.leaseOwner = options.consumerId;

      // Aggregation pipeline preserves firstFailedAt across retries via $ifNull.
      const pipeline: Record<string, unknown>[] = [
        {
          $set: {
            status: targetStatus,
            visibleAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastFailedAt: now,
            lastError: { message: error.message, ...(error.code ? { code: error.code } : {}) },
            firstFailedAt: { $ifNull: ["$firstFailedAt", now] },
          },
        },
      ];

      const updated = await r.findOneAndUpdate(filter, pipeline, { returnDocument: "after" });
      if (updated) return;

      const current = (await safeGetOne({ _id: eventId })) as OutboxDoc | null;
      if (!current) return;
      if (options?.consumerId && current.leaseOwner !== options.consumerId) {
        throw new OutboxOwnershipError(eventId, options.consumerId, current.leaseOwner);
      }
    },

    async getDeadLettered(limit: number): Promise<DeadLetteredEvent[]> {
      const docs = (await r.findAll(
        { status: "dead_letter" },
        { sort: { _id: 1 }, limit },
      )) as OutboxDoc[];
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
        const batch = (await r.findAll(
          { status: "delivered", deliveredAt: { $lte: cutoff } },
          { sort: { deliveredAt: 1 }, limit: DEFAULT_PURGE_BATCH, select: "_id" },
        )) as Array<{ _id: string }>;
        if (batch.length === 0) break;
        const ids = batch.map((d) => d._id);
        const res = (await r.deleteMany({ _id: { $in: ids } })) as { deletedCount?: number };
        totalDeleted += res.deletedCount ?? 0;
        if (batch.length < DEFAULT_PURGE_BATCH) break;
      }
      return totalDeleted;
    },
  };
}
