/**
 * Generic Cache Store Interface
 *
 * Shared contract for reusable cache backends (memory, Redis, etc.).
 * Used by runtime systems such as dynamic permission matrices and QueryCache.
 */

export interface CacheLogger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface CacheSetOptions {
  /** Time-to-live in milliseconds */
  ttlMs?: number;
}

export interface CacheStats {
  /** Number of entries currently stored */
  entries: number;
  /** Estimated memory usage in bytes (-1 if unavailable) */
  memoryBytes: number;
  /** Cache hit count since creation */
  hits: number;
  /** Cache miss count since creation */
  misses: number;
  /** Number of entries evicted since creation */
  evictions: number;
}

export interface CacheStore<TValue = unknown> {
  /** Store name for logs/diagnostics */
  readonly name: string;

  /**
   * Get cached value by key.
   * Returns undefined when missing or expired.
   */
  get(key: string): Promise<TValue | undefined>;

  /**
   * Set a cache value.
   * Store implementation handles TTL and eviction policy.
   */
  set(key: string, value: TValue, options?: CacheSetOptions): Promise<void>;

  /**
   * Delete a single cache key.
   */
  delete(key: string): Promise<void>;

  /**
   * Clear all keys in this store namespace.
   * Optional because distributed stores may not support cheap global clear.
   */
  clear?(): Promise<void>;

  /** Cache statistics for observability. */
  stats?(): CacheStats;
}
