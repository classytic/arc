/**
 * In-Memory Idempotency Store
 *
 * Default store for development and small deployments.
 * NOT suitable for multi-instance deployments - use Redis or similar.
 *
 * Features:
 * - Automatic TTL expiration
 * - Lock support for concurrent request handling
 * - Periodic cleanup of expired entries
 * - Prefix-based operations for raw key invalidation
 */

import type { IdempotencyLock, IdempotencyResult, IdempotencyStore } from "./interface.js";

export interface MemoryIdempotencyStoreOptions {
  /** Default TTL in milliseconds (default: 86400000 = 24h) */
  ttlMs?: number;
  /** Cleanup interval in milliseconds (default: 60000 = 1 min) */
  cleanupIntervalMs?: number;
  /** Maximum entries before oldest are evicted (default: 10000) */
  maxEntries?: number;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly name = "memory";
  private results: Map<string, IdempotencyResult> = new Map();
  private locks: Map<string, IdempotencyLock> = new Map();
  private ttlMs: number;
  private maxEntries: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 86400000; // 24 hours
    this.maxEntries = options.maxEntries ?? 10000;

    // Start cleanup timer
    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60000;
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);

    // Don't keep Node process alive just for cleanup
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  async get(key: string): Promise<IdempotencyResult | undefined> {
    const result = this.results.get(key);
    if (!result) return undefined;

    // Check expiration
    if (new Date() > result.expiresAt) {
      this.results.delete(key);
      return undefined;
    }

    return result;
  }

  async set(key: string, result: Omit<IdempotencyResult, "key">): Promise<void> {
    // Evict oldest if at capacity
    if (this.results.size >= this.maxEntries) {
      this.evictOldest();
    }

    this.results.set(key, { ...result, key });
  }

  async tryLock(key: string, requestId: string, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(key);

    if (existing) {
      // Check if lock expired
      if (new Date() > existing.expiresAt) {
        this.locks.delete(key);
      } else {
        // Lock held by someone else
        return false;
      }
    }

    // Acquire lock
    this.locks.set(key, {
      key,
      requestId,
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + ttlMs),
    });

    return true;
  }

  async unlock(key: string, requestId: string): Promise<void> {
    const lock = this.locks.get(key);
    if (lock && lock.requestId === requestId) {
      this.locks.delete(key);
    }
  }

  async isLocked(key: string): Promise<boolean> {
    const lock = this.locks.get(key);
    if (!lock) return false;

    // Check if expired
    if (new Date() > lock.expiresAt) {
      this.locks.delete(key);
      return false;
    }

    return true;
  }

  async delete(key: string): Promise<void> {
    this.results.delete(key);
    this.locks.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const key of this.results.keys()) {
      if (key.startsWith(prefix)) {
        this.results.delete(key);
        count++;
      }
    }
    for (const key of this.locks.keys()) {
      if (key.startsWith(prefix)) {
        this.locks.delete(key);
      }
    }
    return count;
  }

  async findByPrefix(prefix: string): Promise<IdempotencyResult | undefined> {
    const now = new Date();
    for (const [key, result] of this.results) {
      if (key.startsWith(prefix)) {
        if (now > result.expiresAt) {
          this.results.delete(key);
          continue;
        }
        return result;
      }
    }
    return undefined;
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.results.clear();
    this.locks.clear();
  }

  /** Get current stats (for debugging/monitoring) */
  getStats(): { results: number; locks: number } {
    return {
      results: this.results.size,
      locks: this.locks.size,
    };
  }

  private cleanup(): void {
    const now = new Date();

    for (const [key, result] of this.results) {
      if (now > result.expiresAt) {
        this.results.delete(key);
      }
    }

    for (const [key, lock] of this.locks) {
      if (now > lock.expiresAt) {
        this.locks.delete(key);
      }
    }
  }

  private evictOldest(): void {
    const entries = Array.from(this.results.entries()).sort(
      (a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime(),
    );

    const toRemove = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < toRemove; i++) {
      const entry = entries[i];
      if (entry) {
        this.results.delete(entry[0]);
      }
    }
  }
}

