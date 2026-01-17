/**
 * MongoDB Audit Store
 *
 * Persists audit logs to MongoDB collection with TTL support.
 * Suitable for production use.
 */

import type { AuditEntry, AuditQueryOptions, AuditStore } from './interface.js';

export interface MongoAuditStoreOptions {
  /** MongoDB connection or mongoose instance */
  connection: MongoConnection;
  /** Collection name (default: 'audit_logs') */
  collection?: string;
  /** TTL in days (default: 90, 0 = no expiry) */
  ttlDays?: number;
}

// Minimal MongoDB types to avoid mongoose dependency
interface MongoConnection {
  collection: (name: string) => MongoCollection;
}

interface MongoCollection {
  insertOne: (doc: Record<string, unknown>) => Promise<unknown>;
  find: (query: Record<string, unknown>) => MongoCursor;
  createIndex: (spec: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
}

interface MongoCursor {
  sort: (spec: Record<string, unknown>) => MongoCursor;
  skip: (n: number) => MongoCursor;
  limit: (n: number) => MongoCursor;
  toArray: () => Promise<Record<string, unknown>[]>;
}

export class MongoAuditStore implements AuditStore {
  readonly name = 'mongodb';
  private collection: MongoCollection;
  private initialized = false;
  private ttlDays: number;

  constructor(private options: MongoAuditStoreOptions) {
    const collectionName = options.collection ?? 'audit_logs';
    this.collection = options.connection.collection(collectionName);
    this.ttlDays = options.ttlDays ?? 90;
  }

  private async ensureIndexes(): Promise<void> {
    if (this.initialized) return;

    try {
      // Compound index for common queries
      await this.collection.createIndex({
        resource: 1,
        documentId: 1,
        timestamp: -1,
      });

      // Index for user queries
      await this.collection.createIndex({ userId: 1, timestamp: -1 });

      // Index for org queries
      await this.collection.createIndex({ organizationId: 1, timestamp: -1 });

      // TTL index for automatic cleanup
      if (this.ttlDays > 0) {
        await this.collection.createIndex(
          { timestamp: 1 },
          { expireAfterSeconds: this.ttlDays * 24 * 60 * 60 }
        );
      }

      this.initialized = true;
    } catch {
      // Indexes may already exist, ignore errors
      this.initialized = true;
    }
  }

  async log(entry: AuditEntry): Promise<void> {
    await this.ensureIndexes();

    await this.collection.insertOne({
      _id: entry.id,
      resource: entry.resource,
      documentId: entry.documentId,
      action: entry.action,
      userId: entry.userId,
      organizationId: entry.organizationId,
      before: entry.before,
      after: entry.after,
      changes: entry.changes,
      requestId: entry.requestId,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      metadata: entry.metadata,
      timestamp: entry.timestamp,
    });
  }

  async query(options: AuditQueryOptions = {}): Promise<AuditEntry[]> {
    await this.ensureIndexes();

    const query: Record<string, unknown> = {};

    if (options.resource) {
      query.resource = options.resource;
    }

    if (options.documentId) {
      query.documentId = options.documentId;
    }

    if (options.userId) {
      query.userId = options.userId;
    }

    if (options.organizationId) {
      query.organizationId = options.organizationId;
    }

    if (options.action) {
      const actions = Array.isArray(options.action) ? options.action : [options.action];
      query.action = actions.length === 1 ? actions[0] : { $in: actions };
    }

    if (options.from || options.to) {
      query.timestamp = {};
      if (options.from) {
        (query.timestamp as Record<string, unknown>).$gte = options.from;
      }
      if (options.to) {
        (query.timestamp as Record<string, unknown>).$lte = options.to;
      }
    }

    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;

    const docs = await this.collection
      .find(query)
      .sort({ timestamp: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    return docs.map((doc) => ({
      id: String(doc._id),
      resource: doc.resource as string,
      documentId: doc.documentId as string,
      action: doc.action as AuditEntry['action'],
      userId: doc.userId as string | undefined,
      organizationId: doc.organizationId as string | undefined,
      before: doc.before as Record<string, unknown> | undefined,
      after: doc.after as Record<string, unknown> | undefined,
      changes: doc.changes as string[] | undefined,
      requestId: doc.requestId as string | undefined,
      ipAddress: doc.ipAddress as string | undefined,
      userAgent: doc.userAgent as string | undefined,
      metadata: doc.metadata as Record<string, unknown> | undefined,
      timestamp: doc.timestamp as Date,
    }));
  }
}

export default MongoAuditStore;
