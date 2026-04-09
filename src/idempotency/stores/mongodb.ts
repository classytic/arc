/**
 * MongoDB Idempotency Store
 *
 * Durable idempotency store using MongoDB.
 * Suitable for multi-instance deployments.
 *
 * @example
 * import mongoose from 'mongoose';
 * import { MongoIdempotencyStore } from '@classytic/arc/idempotency';
 *
 * await fastify.register(idempotencyPlugin, {
 *   store: new MongoIdempotencyStore({
 *     connection: mongoose.connection,
 *     collection: 'idempotency_keys',
 *   }),
 * });
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
  ): Promise<{ acknowledged: boolean; matchedCount: number; modifiedCount: number }>;
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

export interface MongoIdempotencyStoreOptions {
  /** Mongoose connection or MongoDB connection object */
  connection: MongoConnection;
  /** Collection name (default: 'arc_idempotency') */
  collection?: string;
  /** Create TTL index on startup (default: true) */
  createIndex?: boolean;
  /** Default TTL in ms (default: 86400000 = 24 hours) */
  ttlMs?: number;
}

export class MongoIdempotencyStore implements IdempotencyStore {
  readonly name = "mongodb";
  private connection: MongoConnection;
  private collectionName: string;
  private ttlMs: number;
  private indexCreated = false;

  constructor(options: MongoIdempotencyStoreOptions) {
    this.connection = options.connection;
    this.collectionName = options.collection ?? "arc_idempotency";
    this.ttlMs = options.ttlMs ?? 86400000;

    if (options.createIndex !== false) {
      // Fire-and-forget — index creation failure is non-fatal
      this.ensureIndex().catch(() => {});
    }
  }

  private get collection(): MongoCollection {
    return this.connection.db.collection(this.collectionName);
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexCreated) return;
    try {
      // TTL index for automatic cleanup
      await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      this.indexCreated = true;
    } catch {
      // Index might already exist
      this.indexCreated = true;
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

      // matchedCount === 1: existing doc matched (lock was free/expired)
      // modifiedCount can be 0 if the $set value is identical — use matchedCount
      // upsertedCount === 1 (implied by acknowledged + matchedCount === 0):
      //   new doc created with our lock
      return result.matchedCount === 1 || result.modifiedCount === 1;
    } catch {
      // Duplicate key on upsert race or other error → someone else got the lock
      return false;
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
