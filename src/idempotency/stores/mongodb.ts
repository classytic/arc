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

import type { IdempotencyStore, IdempotencyResult } from './interface.js';

export interface MongoConnection {
  db: {
    collection(name: string): MongoCollection;
  };
}

interface MongoCollection {
  findOne(filter: object): Promise<IdempotencyDocument | null>;
  insertOne(doc: object): Promise<{ acknowledged: boolean }>;
  updateOne(filter: object, update: object, options?: object): Promise<{ acknowledged: boolean }>;
  deleteOne(filter: object): Promise<{ deletedCount: number }>;
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
  readonly name = 'mongodb';
  private connection: MongoConnection;
  private collectionName: string;
  private ttlMs: number;
  private indexCreated = false;

  constructor(options: MongoIdempotencyStoreOptions) {
    this.connection = options.connection;
    this.collectionName = options.collection ?? 'arc_idempotency';
    this.ttlMs = options.ttlMs ?? 86400000;

    if (options.createIndex !== false) {
      this.ensureIndex().catch((err) => {
        console.warn('[MongoIdempotencyStore] Failed to create index:', err);
      });
    }
  }

  private get collection(): MongoCollection {
    return this.connection.db.collection(this.collectionName);
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexCreated) return;
    try {
      // TTL index for automatic cleanup
      await this.collection.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 }
      );
      this.indexCreated = true;
    } catch {
      // Index might already exist
      this.indexCreated = true;
    }
  }

  async get(key: string): Promise<IdempotencyResult | undefined> {
    const doc = await this.collection.findOne({ _id: key });
    if (!doc || !doc.result) return undefined;

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

  async set(key: string, result: Omit<IdempotencyResult, 'key'>): Promise<void> {
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
        $unset: { lock: '' },
      },
      { upsert: true }
    );
  }

  async tryLock(key: string, requestId: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    try {
      // Try to insert a new lock document
      // If document exists, check if lock is expired
      const existingDoc = await this.collection.findOne({ _id: key });

      if (existingDoc) {
        // Document exists - check if locked
        if (existingDoc.lock && new Date(existingDoc.lock.expiresAt) > now) {
          // Lock is held and not expired
          return false;
        }
        // Lock expired or no lock - update it
        const updateResult = await this.collection.updateOne(
          {
            _id: key,
            $or: [
              { lock: { $exists: false } },
              { 'lock.expiresAt': { $lt: now } },
            ],
          },
          {
            $set: {
              lock: { requestId, expiresAt },
            },
          }
        );
        return updateResult.acknowledged;
      }

      // No document - insert new one with lock
      const insertResult = await this.collection.insertOne({
        _id: key,
        lock: { requestId, expiresAt },
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.ttlMs),
      });
      return insertResult.acknowledged;
    } catch {
      // Duplicate key or other error means someone else got the lock
      return false;
    }
  }

  async unlock(key: string, requestId: string): Promise<void> {
    // Only unlock if we hold the lock
    await this.collection.updateOne(
      { _id: key, 'lock.requestId': requestId },
      { $unset: { lock: '' } }
    );
  }

  async isLocked(key: string): Promise<boolean> {
    const doc = await this.collection.findOne({ _id: key });
    if (!doc || !doc.lock) return false;
    return new Date(doc.lock.expiresAt) > new Date();
  }

  async delete(key: string): Promise<void> {
    await this.collection.deleteOne({ _id: key });
  }

  async close(): Promise<void> {
    // Don't close the connection - it's passed in and may be shared
  }
}

export default MongoIdempotencyStore;
