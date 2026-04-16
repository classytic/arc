/**
 * MongoDB Outbox Store
 *
 * Durable `OutboxStore` implementation for Mongo-backed apps. Implements the
 * full v2.9 contract: claim-lease for multi-worker relay, `fail()` with
 * retry / dead-letter, typed `getDeadLettered()`, batched cursor `purge()`,
 * and session-threaded operations for transactional relay loops.
 *
 * Shipped as a subpath so apps that don't use Mongo never pull in mongoose:
 *
 * ```typescript
 * import mongoose from 'mongoose';
 * import { EventOutbox } from '@classytic/arc/events';
 * import { MongoOutboxStore } from '@classytic/arc/events/mongo';
 *
 * const outbox = new EventOutbox({
 *   store: new MongoOutboxStore({ connection: mongoose.connection }),
 *   transport: redisTransport,
 *   failurePolicy: ({ attempts }) => attempts >= 5 ? { deadLetter: true } : {},
 * });
 * ```
 *
 * Why this belongs in arc:
 *
 *   The outbox pattern is arc's answer to "we published an event but the
 *   transport was down / the HTTP response was already sent / the write
 *   was rolled back". Every arc+Mongo app needs a durable store; shipping
 *   the canonical implementation prevents three variants drifting apart
 *   on index shape, TTL semantics, ownership enforcement, and DLQ tracking.
 */

import type { DeadLetteredEvent, DomainEvent, EventLogger } from "../EventTransport.js";
import {
  InvalidOutboxEventError,
  type OutboxAcknowledgeOptions,
  type OutboxClaimOptions,
  type OutboxErrorInfo,
  type OutboxFailOptions,
  OutboxOwnershipError,
  type OutboxStore,
  type OutboxWriteOptions,
} from "../outbox.js";

// ---------------------------------------------------------------------------
// Minimal typed interfaces
//
// Duck-typed so the file doesn't import `mongoose` at type level — apps can
// pass a mongoose Connection or a raw MongoClient-shaped object, same as the
// existing @classytic/arc/idempotency/mongodb adapter. Keeping types narrow
// also means arc doesn't track mongoose's surface across minor versions.
// ---------------------------------------------------------------------------

export interface MongoConnectionLike {
  /** Mongoose-style readiness flag. `1 === connected`. */
  readonly readyState: number;
  /** Native MongoDB driver DB handle. Mongoose exposes this as `conn.db`. */
  readonly db?: MongoDatabaseLike | null;
}

export interface MongoDatabaseLike {
  collection<T = unknown>(name: string): MongoCollectionLike<T>;
}

export interface MongoCollectionLike<T = unknown> {
  insertOne(doc: T, options?: object): Promise<{ acknowledged: boolean }>;
  findOne(filter: object, options?: object): Promise<T | null>;
  find(filter: object, options?: object): MongoCursorLike<T>;
  findOneAndUpdate(filter: object, update: object, options?: object): Promise<T | null>;
  updateOne(
    filter: object,
    update: object,
    options?: object,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteMany(filter: object, options?: object): Promise<{ deletedCount: number }>;
  createIndex(spec: object, options?: object): Promise<string>;
}

export interface MongoCursorLike<T = unknown> {
  limit(n: number): MongoCursorLike<T>;
  sort(spec: object): MongoCursorLike<T>;
  project(spec: object): MongoCursorLike<T>;
  toArray(): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Behaviour when the Mongo connection isn't ready at call time. */
export type MongoDisconnectPolicy =
  /** Throw — the correct production default. Fails loudly so ops see it. */
  | "throw"
  /** Silently no-op. Only for dev/test flows that tolerate event loss. */
  | "no-op";

export interface MongoOutboxStoreOptions {
  /**
   * Required — no global mongoose dependency. Pass `mongoose.connection` or
   * any object implementing {@link MongoConnectionLike}.
   */
  readonly connection: MongoConnectionLike;

  /**
   * Collection name. Pass different values to run multiple outboxes within
   * one database (e.g. per bounded context).
   * @default 'arc_outbox_events'
   */
  readonly collectionName?: string;

  /**
   * TTL for delivered events — Mongo's TTL monitor prunes them in the
   * background. Dead-lettered / pending events are NEVER auto-deleted.
   * @default 7 days
   */
  readonly retentionMs?: number;

  /**
   * What to do when `connection.readyState !== 1` at call time.
   * @default 'throw'
   */
  readonly onDisconnect?: MongoDisconnectPolicy;

  /**
   * Skip index creation. Use when indexes are managed externally (migration
   * scripts, Atlas) and the store shouldn't race with them at startup.
   * @default false
   */
  readonly skipIndexCreation?: boolean;

  /**
   * Logger for operational warnings (index creation failures, transient
   * driver errors). Default: console.
   */
  readonly logger?: EventLogger;

  /**
   * Per-batch size for `purge()` — events are deleted in cursor-paged
   * batches to bound memory + lock time on multi-million-row outboxes.
   * @default 500
   */
  readonly purgeBatchSize?: number;

  /**
   * Default `leaseMs` for claim calls that don't override it. Matches the
   * `EventOutbox.leaseMs` default; lets ops tune lease TTL at the store level
   * when multiple relayers share this store.
   * @default 30 seconds
   */
  readonly defaultLeaseMs?: number;
}

// ---------------------------------------------------------------------------
// On-disk document shape
// ---------------------------------------------------------------------------

interface OutboxDoc {
  readonly _id: string; // = event.meta.id; unique
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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_COLLECTION_NAME = "arc_outbox_events";
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PURGE_BATCH_SIZE = 500;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_CLAIM_LIMIT = 100;

export class MongoOutboxStore implements OutboxStore {
  readonly name = "mongo";

  private readonly connection: MongoConnectionLike;
  private readonly collectionName: string;
  private readonly retentionMs: number;
  private readonly onDisconnect: MongoDisconnectPolicy;
  private readonly logger: EventLogger;
  private readonly purgeBatchSize: number;
  private readonly defaultLeaseMs: number;

  private _indexesReady = false;
  private _indexCreationPromise: Promise<void> | null = null;

  constructor(opts: MongoOutboxStoreOptions) {
    if (!opts?.connection) {
      throw new Error("MongoOutboxStore: `connection` is required");
    }
    this.connection = opts.connection;
    this.collectionName = opts.collectionName ?? DEFAULT_COLLECTION_NAME;
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this.onDisconnect = opts.onDisconnect ?? "throw";
    this.logger = opts.logger ?? console;
    this.purgeBatchSize = opts.purgeBatchSize ?? DEFAULT_PURGE_BATCH_SIZE;
    this.defaultLeaseMs = opts.defaultLeaseMs ?? DEFAULT_LEASE_MS;

    if (opts.skipIndexCreation) {
      this._indexesReady = true;
    }
  }

  // ---- connection + collection plumbing -----------------------------------

  private _collection(): MongoCollectionLike<OutboxDoc> | null {
    if (this.connection.readyState !== 1 || !this.connection.db) {
      if (this.onDisconnect === "no-op") return null;
      throw new Error(
        `MongoOutboxStore: connection is not ready (readyState=${this.connection.readyState}). ` +
          "Set onDisconnect: 'no-op' to opt into silent skips (dev/test only).",
      );
    }
    return this.connection.db.collection<OutboxDoc>(this.collectionName);
  }

  private async _ensureIndexes(col: MongoCollectionLike<OutboxDoc>): Promise<void> {
    if (this._indexesReady) return;
    // Coalesce concurrent first-call index creation so we don't fan out N
    // createIndex requests when many concurrent saves land before warmup.
    if (!this._indexCreationPromise) {
      this._indexCreationPromise = this._createIndexes(col).then(
        () => {
          this._indexesReady = true;
          this._indexCreationPromise = null;
        },
        (err) => {
          this._indexCreationPromise = null;
          // Leave `_indexesReady = false` so the next call retries.
          throw err;
        },
      );
    }
    try {
      await this._indexCreationPromise;
    } catch (err) {
      this.logger.warn(
        "[MongoOutboxStore] Index creation failed (will retry on next write):",
        err instanceof Error ? err.message : String(err),
      );
      // Don't block the caller — treat as non-fatal. Schema operations should
      // run as a migration in production anyway.
    }
  }

  private async _createIndexes(col: MongoCollectionLike<OutboxDoc>): Promise<void> {
    // Claim scan: FIFO among `pending + visible + lease-free` documents.
    await col.createIndex(
      { status: 1, visibleAt: 1, createdAt: 1 },
      { name: "arc_outbox_claim_scan" },
    );

    // TTL: auto-purge delivered docs after retention window. Mongo's TTL
    // monitor deletes documents where `deliveredAt + retentionMs <= now`.
    // Partial expression ensures the index only applies to delivered rows —
    // pending/dead-lettered are never touched.
    await col.createIndex(
      { deliveredAt: 1 },
      {
        name: "arc_outbox_ttl",
        expireAfterSeconds: Math.floor(this.retentionMs / 1000),
        partialFilterExpression: { status: "delivered" },
      },
    );

    // Unique dedupe key — partial so `null` values don't collide.
    await col.createIndex(
      { dedupeKey: 1 },
      {
        name: "arc_outbox_dedupe",
        unique: true,
        partialFilterExpression: { dedupeKey: { $type: "string" } },
      },
    );

    // DLQ read scan: `getDeadLettered` sorts oldest-first for FIFO replay.
    await col.createIndex({ status: 1, _id: 1 }, { name: "arc_outbox_status_scan" });
  }

  // ---- OutboxStore contract ----------------------------------------------

  async save(event: DomainEvent, options?: OutboxWriteOptions): Promise<void> {
    if (!event?.type || typeof event.type !== "string") {
      throw new InvalidOutboxEventError("event.type is required");
    }
    if (!event.meta?.id || typeof event.meta.id !== "string") {
      throw new InvalidOutboxEventError("event.meta.id is required");
    }

    const col = this._collection();
    if (!col) return; // no-op disconnect policy
    await this._ensureIndexes(col);

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
      await col.insertOne(doc, maybeSession(options?.session));
    } catch (err) {
      // Dedupe-key collision: treat as success (idempotent save). Matches
      // the MemoryOutboxStore behaviour where `seenDedupeKeys.has(...) → return`.
      if (isDuplicateKeyError(err) && options?.dedupeKey) {
        return;
      }
      // Same _id (meta.id) duplicate → also idempotent: event already persisted.
      if (isDuplicateKeyError(err)) return;
      throw err;
    }
  }

  async getPending(limit: number): Promise<DomainEvent[]> {
    const col = this._collection();
    if (!col) return [];
    const now = new Date();
    const docs = await col
      .find(
        {
          status: "pending",
          visibleAt: { $lte: now },
          $or: [{ leaseOwner: null }, { leaseExpiresAt: { $lte: now } }],
        },
        {},
      )
      .sort({ createdAt: 1 })
      .limit(limit)
      .project({ event: 1 })
      .toArray();
    return docs.map((d) => d.event).filter(isWellFormed);
  }

  async claimPending(options?: OutboxClaimOptions): Promise<DomainEvent[]> {
    const col = this._collection();
    if (!col) return [];
    await this._ensureIndexes(col);

    const limit = options?.limit ?? DEFAULT_CLAIM_LIMIT;
    const leaseMs = options?.leaseMs ?? this.defaultLeaseMs;
    const consumerId = options?.consumerId ?? "anonymous";
    const typeFilter = options?.types?.length ? { type: { $in: options.types } } : {};

    const claimed: DomainEvent[] = [];
    // Atomic per-doc claim loop. Mongo lacks SELECT ... FOR UPDATE SKIP LOCKED;
    // `findOneAndUpdate` with a compound match is the canonical equivalent.
    // Concurrent relayers never see the same doc because the match clause
    // excludes `leaseOwner != null && leaseExpiresAt > now`.
    for (let i = 0; i < limit; i++) {
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);
      const doc = await col.findOneAndUpdate(
        {
          status: "pending",
          visibleAt: { $lte: now },
          $or: [{ leaseOwner: null }, { leaseExpiresAt: { $lte: now } }],
          ...typeFilter,
        },
        {
          $set: { leaseOwner: consumerId, leaseExpiresAt },
          $inc: { attempts: 1 },
        },
        { sort: { createdAt: 1 }, returnDocument: "after" },
      );
      if (!doc) break;
      if (isWellFormed(doc.event)) claimed.push(doc.event);
    }
    return claimed;
  }

  async acknowledge(eventId: string, options?: OutboxAcknowledgeOptions): Promise<void> {
    const col = this._collection();
    if (!col) return;

    const now = new Date();
    // Two-step: match-only (to see ownership), then atomic update.
    //
    // We use a single findOneAndUpdate with a compound match that includes
    // the consumerId guard — if the match fails we then probe the doc to
    // decide between "unknown id (no-op)" and "ownership mismatch (throw)".
    const result = await col.findOneAndUpdate(
      {
        _id: eventId,
        status: { $ne: "delivered" },
        ...(options?.consumerId ? { leaseOwner: options.consumerId } : {}),
      },
      {
        $set: { status: "delivered", deliveredAt: now, leaseOwner: null, leaseExpiresAt: null },
      },
      { returnDocument: "after", ...maybeSession(undefined) },
    );
    if (result) return;

    // No update happened. Figure out why.
    const current = await col.findOne({ _id: eventId });
    if (!current) return; // Unknown id → contract #4 no-op
    if (current.status === "delivered") return; // Already acked → idempotent
    if (options?.consumerId && current.leaseOwner !== options.consumerId) {
      throw new OutboxOwnershipError(eventId, options.consumerId, current.leaseOwner);
    }
    // Shouldn't happen — safety net for odd race.
  }

  async fail(eventId: string, error: OutboxErrorInfo, options?: OutboxFailOptions): Promise<void> {
    const col = this._collection();
    if (!col) return;

    const now = new Date();
    const targetStatus: OutboxDoc["status"] = options?.deadLetter ? "dead_letter" : "pending";
    const visibleAt = options?.retryAt ?? now;

    // Set firstFailedAt only when null — preserves the original failure time
    // across retries.
    const pipeline: object[] = [
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

    const result = await col.findOneAndUpdate(
      {
        _id: eventId,
        ...(options?.consumerId ? { leaseOwner: options.consumerId } : {}),
      },
      pipeline,
      { returnDocument: "after" },
    );
    if (result) return;

    const current = await col.findOne({ _id: eventId });
    if (!current) return; // Unknown id → no-op
    if (options?.consumerId && current.leaseOwner !== options.consumerId) {
      throw new OutboxOwnershipError(eventId, options.consumerId, current.leaseOwner);
    }
  }

  async getDeadLettered(limit: number): Promise<DeadLetteredEvent[]> {
    const col = this._collection();
    if (!col) return [];
    const docs = await col.find({ status: "dead_letter" }).sort({ _id: 1 }).limit(limit).toArray();

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
  }

  /**
   * Purge delivered docs older than `olderThanMs` in bounded batches.
   *
   * MongoDB's TTL monitor runs as a background thread on its own cadence,
   * so `purge()` is only needed when apps want predictable cleanup timing
   * (tests, hot batch windows, retention migrations). Deletes are paged
   * via cursor to bound memory + lock time on multi-million-row outboxes.
   */
  async purge(olderThanMs: number): Promise<number> {
    const col = this._collection();
    if (!col) return 0;
    const cutoff = new Date(Date.now() - olderThanMs);
    let totalDeleted = 0;

    for (;;) {
      const batch = await col
        .find({ status: "delivered", deliveredAt: { $lte: cutoff } })
        .sort({ deliveredAt: 1 })
        .limit(this.purgeBatchSize)
        .project({ _id: 1 })
        .toArray();
      if (batch.length === 0) break;
      const ids = batch.map((d) => d._id);
      const res = await col.deleteMany({ _id: { $in: ids } });
      totalDeleted += res.deletedCount;
      if (batch.length < this.purgeBatchSize) break;
    }
    return totalDeleted;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWellFormed(event: DomainEvent | undefined): boolean {
  return !!event && typeof event.type === "string" && !!event.meta?.id;
}

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number; codeName?: string; name?: string };
  return e.code === 11000 || e.codeName === "DuplicateKey" || e.name === "MongoServerError";
}

/**
 * Thread an optional driver session into a single-op options object. We keep
 * the shape permissive (`session: unknown`) because arc doesn't depend on the
 * driver's type surface — whichever value mongoose / MongoClient hands us is
 * passed through verbatim.
 */
function maybeSession(session: unknown): { session?: unknown } {
  return session === undefined ? {} : { session };
}
