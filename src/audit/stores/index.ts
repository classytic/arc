/**
 * Audit Stores
 *
 * Pluggable storage backends for audit logs.
 * - MemoryAuditStore: In-process (dev/testing)
 * - MongoAuditStore: MongoDB (production)
 */

export type {
  AuditAction,
  AuditContext,
  AuditEntry,
  AuditQueryOptions,
  AuditStore,
  AuditStoreOptions,
} from './interface.js';

export { createAuditEntry } from './interface.js';

export { MemoryAuditStore } from './memory.js';
export type { MemoryAuditStoreOptions } from './memory.js';

export { MongoAuditStore } from './mongodb.js';
export type { MongoAuditStoreOptions } from './mongodb.js';
