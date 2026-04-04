/**
 * In-Memory Audit Store
 *
 * For development and testing. Not suitable for production.
 * Logs are lost on restart.
 */

import type { AuditEntry, AuditQueryOptions, AuditStore } from "./interface.js";

export interface MemoryAuditStoreOptions {
  /** Maximum entries to keep (default: 1000) */
  maxEntries?: number;
}

export class MemoryAuditStore implements AuditStore {
  readonly name = "memory";
  private entries: AuditEntry[] = [];
  private maxEntries: number;

  constructor(options: MemoryAuditStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
  }

  async log(entry: AuditEntry): Promise<void> {
    this.entries.unshift(entry);

    // Trim to max size
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(0, this.maxEntries);
    }
  }

  async query(options: AuditQueryOptions = {}): Promise<AuditEntry[]> {
    let results = [...this.entries];

    if (options.resource) {
      results = results.filter((e) => e.resource === options.resource);
    }

    if (options.documentId) {
      results = results.filter((e) => e.documentId === options.documentId);
    }

    if (options.userId) {
      results = results.filter((e) => e.userId === options.userId);
    }

    if (options.organizationId) {
      results = results.filter((e) => e.organizationId === options.organizationId);
    }

    if (options.action) {
      const actions = Array.isArray(options.action) ? options.action : [options.action];
      results = results.filter((e) => actions.includes(e.action));
    }

    if (options.from) {
      results = results.filter((e) => e.timestamp >= options.from!);
    }

    if (options.to) {
      results = results.filter((e) => e.timestamp <= options.to!);
    }

    // Pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    results = results.slice(offset, offset + limit);

    return results;
  }

  async close(): Promise<void> {
    this.entries = [];
  }

  /** Get all entries (for testing) */
  getAll(): AuditEntry[] {
    return [...this.entries];
  }

  /** Clear all entries (for testing) */
  clear(): void {
    this.entries = [];
  }
}
