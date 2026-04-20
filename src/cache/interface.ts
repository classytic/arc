/**
 * Cache Store Interface — aligned with `@classytic/repo-core/cache.CacheAdapter`.
 *
 * Arc's cache layer speaks the same `get / set(ttlSeconds?) / del / clear(pattern?)`
 * transport-level contract published by `@classytic/repo-core`. One Redis
 * implementation drops into Arc's `QueryCache`, mongokit's cache plugin,
 * sqlitekit's cache plugin, and every future kit without wrapper shims.
 *
 * Arc extends the bare adapter with two optional observability fields —
 * `name` (for diagnostics) and `stats()` (for the response-cache plugin) —
 * that are opt-in: consumers implementing only `CacheAdapter` still
 * structurally satisfy `CacheStore`, so a raw repo-core adapter plugs
 * directly into Arc.
 *
 * ## TTL unit
 *
 * `ttlSeconds`, not milliseconds. Matches Redis (`SET … EX seconds`) which
 * is the dominant backend. `0` or `undefined` means no expiry; implementations
 * may apply their own default.
 *
 * ## Not-found semantics
 *
 * `get()` returns `undefined` on miss / expired. Matches repo-core.
 *
 * ## Sync-or-async
 *
 * Method returns are `Promise<T> | T` — in-memory `Map` adapters can be
 * synchronous; Redis adapters are async. Consumers always `await`, so
 * sync values just short-circuit the microtask.
 */

export interface CacheLogger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
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
  /** Store name for logs/diagnostics. Optional to match repo-core's bare `CacheAdapter`. */
  readonly name?: string;

  /**
   * Get a value by key. Returns `undefined` when not found or expired.
   */
  get(key: string): Promise<TValue | undefined> | TValue | undefined;

  /**
   * Store a value with optional TTL (seconds). `0` or `undefined` means
   * no expiry; implementations may apply a default.
   */
  set(key: string, value: TValue, ttlSeconds?: number): Promise<void> | void;

  /**
   * Delete a single key. No-op when the key doesn't exist.
   */
  delete(key: string): Promise<void> | void;

  /**
   * Invalidate keys matching a glob pattern (typically `prefix:*`), or
   * every key when `pattern` is omitted.
   *
   * Optional — simpler adapters that can't enumerate keys (some KV stores)
   * may omit this and rely on TTL for eventual consistency. Consumers that
   * need strict invalidation must check for its presence: `store.clear?.(pattern)`.
   */
  clear?(pattern?: string): Promise<void> | void;

  /** Cache statistics for observability. Optional. */
  stats?(): CacheStats;
}
