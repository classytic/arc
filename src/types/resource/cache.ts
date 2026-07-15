/**
 * Per-resource QueryCache configuration — stale-while-revalidate
 * windows, per-operation overrides, and tag-based cross-resource
 * invalidation.
 */

/**
 * Per-resource cache configuration for QueryCache. Enables
 * stale-while-revalidate, auto-invalidation on mutations, and
 * cross-resource tag-based invalidation.
 */

export interface ResourceCacheConfig {
  /** Seconds data is "fresh" (no revalidation). Default: 0 */
  staleTime?: number;
  /** Seconds stale data stays cached (SWR window). Default: 60 */
  gcTime?: number;
  /** Per-operation overrides */
  list?: { staleTime?: number; gcTime?: number };
  byId?: { staleTime?: number; gcTime?: number };
  /** Tags for cross-resource invalidation grouping */
  tags?: string[];
  /**
   * Cross-resource invalidation: event pattern → tag targets.
   * @example { 'category.*': ['catalog'] }
   */
  invalidateOn?: Record<string, string[]>;
  /** Disable caching for this resource */
  disabled?: boolean;
}
