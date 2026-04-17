/**
 * Audit Stores
 *
 * The audit plugin consumes a `RepositoryLike` directly — no adapter or
 * "repository store" wrapper. See the plugin's `repository` option.
 *
 * This barrel only re-exports backends that AREN'T repositories:
 * - `MemoryAuditStore` — in-process ring buffer for dev / tests
 * - Custom stores implementing `AuditStore` for third-party backends
 *   (Kafka, S3, OpenTelemetry, etc.) via the plugin's `customStores` option.
 */

export type {
  AuditAction,
  AuditContext,
  AuditEntry,
  AuditQueryOptions,
  AuditStore,
  AuditStoreOptions,
} from "./interface.js";

export { createAuditEntry } from "./interface.js";
export type { MemoryAuditStoreOptions } from "./memory.js";
export { MemoryAuditStore } from "./memory.js";
