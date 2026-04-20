import type { CacheLogger, CacheStats, CacheStore } from "./interface.js";

interface MemoryEntry<TValue> {
  value: TValue;
  size: number;
  expiresAt: number;
}

export interface MemoryCacheStoreOptions {
  /** Default TTL in seconds (default: 60) */
  defaultTtlSeconds?: number;
  /** Hard upper bound for entries (default: 1000) */
  maxEntries?: number;
  /** Background cleanup interval in milliseconds (default: 30_000) */
  cleanupIntervalMs?: number;
  /**
   * Maximum serialized entry size in bytes (default: 256 KiB).
   * Oversized entries are skipped to prevent memory pressure.
   */
  maxEntryBytes?: number;
  /**
   * Total memory budget in bytes (default: 50 MiB).
   * When exceeded, LRU entries are evicted until usage drops below watermark.
   * Set to 0 to disable (rely on maxEntries only).
   */
  maxMemoryBytes?: number;
  /**
   * Eviction watermark as fraction of maxMemoryBytes (default: 0.9).
   * When memory exceeds budget, evict until usage drops to budget * watermark.
   */
  evictionWatermark?: number;
  /** Logger for warnings/errors (default: console) */
  logger?: CacheLogger;
}

/**
 * In-memory LRU+TTL cache store with hard entry cap and memory budget.
 * - LRU eviction when `maxEntries` or `maxMemoryBytes` is reached
 * - TTL expiration on read + periodic cleanup
 * - Entry size guard to avoid runaway memory usage
 * - Stats tracking for observability
 */
export class MemoryCacheStore<TValue = unknown> implements CacheStore<TValue> {
  readonly name = "memory-cache";

  private readonly cache = new Map<string, MemoryEntry<TValue>>();
  private readonly defaultTtlSeconds: number;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  private readonly maxMemoryBytes: number;
  private readonly evictionWatermark: number;
  private readonly logger: CacheLogger;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  private currentBytes = 0;
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(options: MemoryCacheStoreOptions = {}) {
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 60;
    this.maxEntries = clamp(options.maxEntries ?? 1000, 1, 100_000);
    this.maxEntryBytes = clamp(options.maxEntryBytes ?? 256 * 1024, 1024, 10 * 1024 * 1024);
    this.maxMemoryBytes = options.maxMemoryBytes ?? 50 * 1024 * 1024; // 50 MiB
    this.evictionWatermark = clamp(options.evictionWatermark ?? 0.9, 0.5, 1);
    this.logger = options.logger ?? console;

    const cleanupIntervalMs = clamp(options.cleanupIntervalMs ?? 30_000, 1000, 10 * 60 * 1000);
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), cleanupIntervalMs);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  async get(key: string): Promise<TValue | undefined> {
    const entry = this.cache.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.removeEntry(key, entry);
      this._misses++;
      return undefined;
    }

    // LRU refresh: move to most-recent position
    this.cache.delete(key);
    this.cache.set(key, entry);
    this._hits++;
    return entry.value;
  }

  async set(key: string, value: TValue, ttlSeconds?: number): Promise<void> {
    const effectiveTtlSeconds = ttlSeconds ?? this.defaultTtlSeconds;
    if (!Number.isFinite(effectiveTtlSeconds) || effectiveTtlSeconds <= 0) return;
    const ttlMs = effectiveTtlSeconds * 1000;

    const size = this.estimateSize(value);
    if (size > this.maxEntryBytes) {
      this.logger.warn(
        `[MemoryCacheStore] Skipping oversized entry for key '${key}' (${size} bytes > ${this.maxEntryBytes} bytes)`,
      );
      return;
    }

    // Remove existing entry first (adjust bytes)
    const existing = this.cache.get(key);
    if (existing) {
      this.currentBytes -= existing.size;
      this.cache.delete(key);
    }

    this.cache.set(key, { value, size, expiresAt: Date.now() + ttlMs });
    this.currentBytes += size;

    this.evictToLimit();
    if (this.maxMemoryBytes > 0) this.evictToMemoryLimit();
  }

  async delete(key: string): Promise<void> {
    const entry = this.cache.get(key);
    if (entry) this.removeEntry(key, entry);
  }

  async clear(pattern?: string): Promise<void> {
    if (pattern === undefined) {
      this.cache.clear();
      this.currentBytes = 0;
      return;
    }
    const regex = globToRegExp(pattern);
    for (const [key, entry] of this.cache) {
      if (regex.test(key)) this.removeEntry(key, entry);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    this.cache.clear();
    this.currentBytes = 0;
  }

  stats(): CacheStats {
    return {
      entries: this.cache.size,
      memoryBytes: this.currentBytes,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
    };
  }

  private removeEntry(key: string, entry: MemoryEntry<TValue>): void {
    this.cache.delete(key);
    this.currentBytes -= entry.size;
  }

  private evictToLimit(): void {
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const entry = this.cache.get(oldestKey)!;
      this.removeEntry(oldestKey, entry);
      this._evictions++;
    }
  }

  private evictToMemoryLimit(): void {
    const target = this.maxMemoryBytes * this.evictionWatermark;
    while (this.currentBytes > this.maxMemoryBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const entry = this.cache.get(oldestKey)!;
      this.removeEntry(oldestKey, entry);
      this._evictions++;
      if (this.currentBytes <= target) break;
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.removeEntry(key, entry);
      }
    }
  }

  private estimateSize(value: TValue): number {
    try {
      const json = JSON.stringify(value);
      if (!json) return 0;
      return Buffer.byteLength(json, "utf8");
    } catch {
      return this.maxEntryBytes + 1;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Translate a glob pattern (`prefix:*`, `*:tag:v`) into a regex. Only `*`
 * is honoured; other regex metachars are escaped so patterns can't inject
 * alternation/lookahead.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
