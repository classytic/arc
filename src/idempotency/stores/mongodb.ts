/**
 * MongoDB Idempotency Store
 *
 * Durable idempotency store using MongoDB. Suitable for multi-instance
 * deployments where in-memory stores won't work.
 *
 * ## Setup
 *
 * ```typescript
 * import { idempotencyPlugin } from '@classytic/arc/idempotency';
 * import { MongoIdempotencyStore } from '@classytic/arc/idempotency/mongodb';
 *
 * await fastify.register(idempotencyPlugin, {
 *   enabled: true,
 *   store: new MongoIdempotencyStore({
 *     connection: mongoose.connection, // or MongoClient.db()
 *     collection: 'idempotency_keys',  // default: 'arc_idempotency'
 *     ttlMs: 24 * 60 * 60 * 1000,     // default: 24 hours
 *     logger: fastify.log,             // operational warnings (default: console)
 *   }),
 * });
 * ```
 *
 * ## TTL Cleanup
 *
 * The store auto-creates a TTL index on `expiresAt` at startup (retried
 * lazily on write paths if the initial attempt fails). MongoDB's TTL monitor
 * runs as a background thread that deletes expired documents automatically.
 *
 * **Important timing note:** MongoDB's TTL monitor runs every
 * `ttlMonitorSleepSecs` (default: **60 seconds**). This means:
 *
 * - Documents are NOT deleted exactly at `expiresAt` — there is up to a
 *   60-second window where an expired doc still exists on disk.
 * - The store's `get()` method checks expiry at read time, so expired docs
 *   are never returned to callers even if Mongo hasn't cleaned them yet.
 * - For testing with fast expiry, start mongod with
 *   `--setParameter ttlMonitorSleepSecs=1`.
 * - In Atlas / managed MongoDB, `ttlMonitorSleepSecs` is not configurable
 *   but the default 60s is fine for production — idempotency keys typically
 *   have 24h TTLs.
 *
 * **Recommended TTL windows:**
 *
 * | Use case | TTL | Why |
 * |----------|-----|-----|
 * | Payment mutations | 24–48 hours | Covers retry storms + manual resubmission |
 * | Form submissions | 1–4 hours | Short enough to not accumulate, long enough for retries |
 * | Batch imports | 15–30 minutes | High volume, quick turnover |
 *
 * ## Error Handling
 *
 * - `tryLock()` throws on non-contention errors (auth, write concern,
 *   network). Only `E11000` duplicate-key race returns `false`.
 * - `ensureIndex()` retries on transient failures and logs a warning via
 *   the configured logger. Code 85/86 (index already exists) is benign.
 */

import type { IdempotencyResult, IdempotencyStore } from "./interface.js";

export interface MongoConnection {
  db: {
    collection(name: string): MongoCollection;
  };
}

interface MongoCollection {
  findOne(filter: object): Promise<IdempotencyDocument | null>;
  insertOne(doc: object): Promise<{ acknowledged: boolean }>;
  updateOne(
    filter: object,
    update: object,
    options?: object,
  ): Promise<{
    acknowledged: boolean;
    matchedCount: number;
    modifiedCount: number;
    upsertedCount?: number;
  }>;
  deleteOne(filter: object): Promise<{ deletedCount: number }>;
  deleteMany(filter: object): Promise<{ deletedCount: number }>;
  createIndex(spec: object, options?: object): Promise<string>;
}

interface IdempotencyDocument {
  _id: string;
  result?: {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  };
  lock?: {
    requestId: string;
    expiresAt: Date;
  };
  createdAt: Date;
  expiresAt: Date;
}

/** Minimal logger interface — compatible with console, pino, fastify.log */
interface IdempotencyLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface MongoIdempotencyStoreOptions {
  /** Mongoose connection or MongoDB connection object */
  connection: MongoConnection;
  /** Collection name (default: 'arc_idempotency') */
  collection?: string;
  /** Create TTL index on startup (default: true) */
  createIndex?: boolean;
  /** Default TTL in ms (default: 86400000 = 24 hours) */
  ttlMs?: number;
  /** Logger for operational warnings (default: console) */
  logger?: IdempotencyLogger;
}

export class MongoIdempotencyStore implements IdempotencyStore {
  readonly name = "mongodb";
  private connection: MongoConnection;
  private collectionName: string;
  private ttlMs: number;
  private indexCreated = false;
  private shouldEnsureIndex: boolean;
  private logger: IdempotencyLogger;

  constructor(options: MongoIdempotencyStoreOptions) {
    this.connection = options.connection;
    this.collectionName = options.collection ?? "arc_idempotency";
    this.ttlMs = options.ttlMs ?? 86400000;
    this.shouldEnsureIndex = options.createIndex !== false;
    this.logger = options.logger ?? console;

    if (this.shouldEnsureIndex) {
      // Eager attempt — best-effort on startup, retried lazily on write paths
      this.ensureIndex().catch(() => {});
    }
  }

  private get collection(): MongoCollection {
    return this.connection.db.collection(this.collectionName);
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexCreated) return;
    try {
      await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      this.indexCreated = true;
    } catch (err) {
      // MongoDB error code 85 = IndexOptionsConflict (index already exists with same shape).
      // That's benign — mark as created. Any other error is a real problem (auth, connection,
      // invalid collection) so we leave indexCreated = false and retry on next call.
      const code = (err as { code?: number })?.code;
      if (code === 85 || code === 86) {
        this.indexCreated = true;
        return;
      }
      // Transient failure — log so operators know TTL cleanup won't work until retry succeeds
      this.logger.warn(
        `[MongoIdempotencyStore] TTL index creation failed (will retry on next write): ${(err as Error).message ?? err}`,
      );
    }
  }

  async get(key: string): Promise<IdempotencyResult | undefined> {
    const doc = await this.collection.findOne({ _id: key });
    if (!doc?.result) return undefined;

    // Check expiration
    if (new Date(doc.expiresAt) < new Date()) {
      return undefined;
    }

    return {
      key,
      statusCode: doc.result.statusCode,
      headers: doc.result.headers,
      body: doc.result.body,
      createdAt: new Date(doc.createdAt),
      expiresAt: new Date(doc.expiresAt),
    };
  }

  async set(key: string, result: Omit<IdempotencyResult, "key">): Promise<void> {
    // Lazy retry: if startup index creation failed, try again before writing.
    // Non-blocking — failure here is non-fatal (TTL cleanup just won't work
    // until the index is eventually created).
    if (this.shouldEnsureIndex && !this.indexCreated) {
      await this.ensureIndex().catch(() => {});
    }
    await this.collection.updateOne(
      { _id: key },
      {
        $set: {
          result: {
            statusCode: result.statusCode,
            headers: result.headers,
            body: result.body,
          },
          createdAt: result.createdAt,
          expiresAt: result.expiresAt,
        },
        $unset: { lock: "" },
      },
      { upsert: true },
    );
  }

  async tryLock(key: string, requestId: string, ttlMs: number): Promise<boolean> {
    if (this.shouldEnsureIndex && !this.indexCreated) {
      await this.ensureIndex().catch(() => {});
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    try {
      // Atomic upsert: acquire lock only when no active lock exists.
      // Uses a single updateOne with upsert to avoid TOCTOU races —
      // matchedCount/upsertedCount tells us if WE acquired the lock
      // (not just that MongoDB acknowledged the command).
      const result = await this.collection.updateOne(
        {
          _id: key,
          $or: [{ lock: { $exists: false } }, { "lock.expiresAt": { $lt: now } }],
        },
        {
          $set: {
            lock: { requestId, expiresAt },
          },
          $setOnInsert: {
            createdAt: now,
            expiresAt: new Date(now.getTime() + this.ttlMs),
          },
        },
        { upsert: true },
      );

      // Two success cases:
      // 1. matchedCount === 1: existing doc matched our filter (lock free/expired), updated in place
      // 2. upsertedCount === 1: no doc matched, upsert INSERTED a new doc with our lock
      // The old code only checked matchedCount/modifiedCount — both are 0 on insert,
      // so fresh keys returned false even though the insert succeeded.
      return result.matchedCount === 1 || (result.upsertedCount ?? 0) === 1;
    } catch (err) {
      // E11000 duplicate key on upsert race = genuine lock contention → return false.
      // Any other error (auth failure, write concern, connection lost) is a real
      // infrastructure problem that must NOT be masked as a 409 conflict.
      const code = (err as { code?: number })?.code;
      if (code === 11000) return false;
      throw err;
    }
  }

  async unlock(key: string, requestId: string): Promise<void> {
    // Only unlock if we hold the lock
    await this.collection.updateOne(
      { _id: key, "lock.requestId": requestId },
      { $unset: { lock: "" } },
    );
  }

  async isLocked(key: string): Promise<boolean> {
    const doc = await this.collection.findOne({ _id: key });
    if (!doc?.lock) return false;
    return new Date(doc.lock.expiresAt) > new Date();
  }

  async delete(key: string): Promise<void> {
    await this.collection.deleteOne({ _id: key });
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const result = await this.collection.deleteMany({
      _id: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` },
    });
    return result.deletedCount;
  }

  async findByPrefix(prefix: string): Promise<IdempotencyResult | undefined> {
    // Filter expired docs at the query level so MongoDB doesn't return a stale
    // entry when a valid one exists further down the index.
    const doc = await this.collection.findOne({
      _id: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` },
      result: { $exists: true },
      expiresAt: { $gt: new Date() },
    });
    if (!doc?.result) return undefined;

    return {
      key: doc._id,
      statusCode: doc.result.statusCode,
      headers: doc.result.headers,
      body: doc.result.body,
      createdAt: new Date(doc.createdAt),
      expiresAt: new Date(doc.expiresAt),
    };
  }

  async close(): Promise<void> {
    // Don't close the connection - it's passed in and may be shared
  }
}
