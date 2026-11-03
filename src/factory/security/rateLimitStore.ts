/**
 * Shared rate-limit store with a per-instance memory fallback.
 *
 * A shared store (Redis via `rateLimit.redis`, or a custom `rateLimit.store`)
 * is a network dependency on EVERY request. Without this wrapper an outage
 * meant one of two things for `@fastify/rate-limit`:
 *
 *   - the client queued the command and the request HUNG (ioredis with
 *     `maxRetriesPerRequest: null`, or its offline queue while reconnecting);
 *   - the command failed and, with `skipOnError: false` (the default), every
 *     request answered 500 — the whole API down because a counter was.
 *
 * The wrapper bounds every store call by `timeoutMs` and, on an error or a
 * timeout, answers from an in-process fixed-window counter instead: traffic
 * keeps flowing AND keeps a limit (per instance, so a fleet of N allows up to
 * N × max while degraded — never unlimited). One warning is logged per outage;
 * while degraded the shared store is probed again every `retryAfterMs`, and
 * the first answer it gives switches back (logged once). `onStatus` reports
 * each switch so a host can surface it on a health or metrics endpoint.
 *
 * Counts do not carry across a switch: the fallback starts its windows empty,
 * and the shared store resumes with whatever it held.
 */

/** `@fastify/rate-limit` store callback. */
type StoreCallback = (err: Error | null, res?: { current: number; ttl: number }) => void;

/** The store contract `@fastify/rate-limit` drives (structural; the plugin's types are not leaked). */
export interface RateLimitStoreLike {
  incr(key: string, cb: StoreCallback, timeWindow: number, max: number): void;
  read?(key: string, cb: StoreCallback, timeWindow: number, max: number): void;
  child(routeOptions: Record<string, unknown>): RateLimitStoreLike;
}

/** What `onStatus` receives on every switch between the shared store and the fallback. */
export interface RateLimitStoreStatus {
  /** `shared` = the configured store answers; `fallback` = this instance's memory counters do. */
  readonly mode: "shared" | "fallback";
  /** When the current mode began. */
  readonly since: Date;
  /** Outages seen since boot. */
  readonly outages: number;
  /** The failure that opened the current outage (message only; never the client config). */
  readonly lastError?: string;
}

export interface RateLimitStoreFallbackOptions {
  /** Longest a request waits on the shared store before the fallback answers (ms). Default 250. */
  timeoutMs?: number;
  /** While degraded, how long before the shared store is tried again (ms). Default 5000. */
  retryAfterMs?: number;
  /** Most live keys one fallback counter holds; the oldest is dropped beyond it. Default 10000. */
  capacity?: number;
  /** Called on each switch (`shared` → `fallback`, `fallback` → `shared`). Must not throw. */
  onStatus?: (status: RateLimitStoreStatus) => void;
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_RETRY_AFTER_MS = 5000;
const DEFAULT_CAPACITY = 10_000;

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(
      `[arc] rateLimit.storeFallback.${name} must be a positive number of milliseconds.`,
    );
  return value;
}

/** One outage state per app: every route's child store switches together. */
class StoreHealth {
  mode: "shared" | "fallback" = "shared";
  since = new Date();
  outages = 0;
  lastError: string | undefined;
  private retryAt = 0;
  private probing = false;
  private readonly retryAfterMs: number;
  private readonly log: Logger;
  private readonly onStatus: RateLimitStoreFallbackOptions["onStatus"];
  private readonly now: () => number;

  constructor(
    retryAfterMs: number,
    log: Logger,
    onStatus: RateLimitStoreFallbackOptions["onStatus"],
    now: () => number,
  ) {
    this.retryAfterMs = retryAfterMs;
    this.log = log;
    this.onStatus = onStatus;
    this.now = now;
  }

  /** Whether this call goes to the shared store: always when healthy, one probe at a time when degraded. */
  tryShared(): boolean {
    if (this.mode === "shared") return true;
    if (this.probing || this.now() < this.retryAt) return false;
    this.probing = true;
    return true;
  }

  succeeded(): void {
    this.probing = false;
    if (this.mode === "shared") return;
    this.mode = "shared";
    this.since = new Date(this.now());
    this.log.info(
      { outages: this.outages },
      "[arc] rate-limit store recovered: limits are shared across instances again",
    );
    this.report();
  }

  failed(err: unknown): void {
    this.probing = false;
    this.retryAt = this.now() + this.retryAfterMs;
    if (this.mode === "fallback") return;
    this.mode = "fallback";
    this.since = new Date(this.now());
    this.outages++;
    this.lastError = err instanceof Error ? err.message : String(err);
    this.log.warn(
      { err: this.lastError, retryAfterMs: this.retryAfterMs },
      "[arc] rate-limit store unavailable: limiting per instance in memory until it answers again",
    );
    this.report();
  }

  status(): RateLimitStoreStatus {
    return {
      mode: this.mode,
      since: this.since,
      outages: this.outages,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  private report(): void {
    try {
      this.onStatus?.(this.status());
    } catch {
      // A host callback never breaks the limiter.
    }
  }
}

/** Fixed-window counters for one store (route); the oldest key is dropped at capacity. */
class MemoryWindows {
  private readonly windows = new Map<string, { start: number; current: number }>();
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(capacity: number, now: () => number) {
    this.capacity = capacity;
    this.now = now;
  }

  incr(key: string, timeWindow: number): { current: number; ttl: number } {
    const now = this.now();
    let slot = this.windows.get(key);
    if (!slot || slot.start + timeWindow <= now) {
      if (slot) this.windows.delete(key);
      if (this.windows.size >= this.capacity) this.evict(now, timeWindow);
      slot = { start: now, current: 0 };
      this.windows.set(key, slot);
    }
    slot.current++;
    return { current: slot.current, ttl: slot.start + timeWindow - now };
  }

  read(key: string, timeWindow: number): { current: number; ttl: number } {
    const now = this.now();
    const slot = this.windows.get(key);
    if (!slot || slot.start + timeWindow <= now) return { current: 0, ttl: 0 };
    return { current: slot.current, ttl: slot.start + timeWindow - now };
  }

  private evict(now: number, timeWindow: number): void {
    for (const [key, slot] of this.windows)
      if (slot.start + timeWindow <= now) this.windows.delete(key);
    // Still full of live windows: drop the oldest (Map order is insertion order).
    while (this.windows.size >= this.capacity) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

class FallbackStore implements RateLimitStoreLike {
  private readonly memory: MemoryWindows;
  private readonly primary: RateLimitStoreLike;
  private readonly health: StoreHealth;
  private readonly timeoutMs: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(
    primary: RateLimitStoreLike,
    health: StoreHealth,
    timeoutMs: number,
    capacity: number,
    now: () => number,
  ) {
    this.primary = primary;
    this.health = health;
    this.timeoutMs = timeoutMs;
    this.capacity = capacity;
    this.now = now;
    this.memory = new MemoryWindows(capacity, now);
  }

  incr(key: string, cb: StoreCallback, timeWindow: number, max: number): void {
    this.call(
      (done) => this.primary.incr(key, done, timeWindow, max),
      () => this.memory.incr(key, timeWindow),
      cb,
    );
  }

  read(key: string, cb: StoreCallback, timeWindow: number, max: number): void {
    const read = this.primary.read;
    if (typeof read !== "function") {
      cb(new Error("The configured rate-limit store does not implement a `read` method"));
      return;
    }
    this.call(
      (done) => read.call(this.primary, key, done, timeWindow, max),
      () => this.memory.read(key, timeWindow),
      cb,
    );
  }

  child(routeOptions: Record<string, unknown>): RateLimitStoreLike {
    return new FallbackStore(
      this.primary.child(routeOptions),
      this.health,
      this.timeoutMs,
      this.capacity,
      this.now,
    );
  }

  private call(
    shared: (done: StoreCallback) => void,
    local: () => { current: number; ttl: number },
    cb: StoreCallback,
  ): void {
    if (!this.health.tryShared()) {
      cb(null, local());
      return;
    }
    let settled = false;
    const settle = (err: unknown, res?: { current: number; ttl: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err || !res) {
        this.health.failed(err ?? new Error("rate-limit store returned no result"));
        cb(null, local());
        return;
      }
      this.health.succeeded();
      cb(null, res);
    };
    const timer = setTimeout(
      () => settle(new Error(`rate-limit store did not answer within ${this.timeoutMs} ms`)),
      this.timeoutMs,
    );
    timer.unref?.();
    try {
      shared((err, res) => settle(err, res));
    } catch (err) {
      settle(err);
    }
  }
}

/**
 * Build the `@fastify/rate-limit` `store` class that wraps `createPrimary` (called with the
 * plugin's global params, as the plugin would construct a store) in the fallback.
 */
export function createFallbackStoreClass(
  createPrimary: (params: Record<string, unknown>) => RateLimitStoreLike,
  options: RateLimitStoreFallbackOptions & { log: Logger; now?: () => number },
): new (
  params: Record<string, unknown>,
) => RateLimitStoreLike {
  const timeoutMs = positive("timeoutMs", options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const retryAfterMs = positive("retryAfterMs", options.retryAfterMs, DEFAULT_RETRY_AFTER_MS);
  const capacity = positive("capacity", options.capacity, DEFAULT_CAPACITY);
  const now = options.now ?? Date.now;
  const health = new StoreHealth(retryAfterMs, options.log, options.onStatus, now);

  // A class (the plugin calls `new Store(globalParams)`); `child` returns plain instances.
  return class SharedStoreWithFallback extends FallbackStore {
    constructor(params: Record<string, unknown>) {
      super(createPrimary(params), health, timeoutMs, capacity, now);
    }
  } as unknown as new (
    params: Record<string, unknown>,
  ) => RateLimitStoreLike;
}

/** `@fastify/rate-limit`'s own Redis store (no `exports` map in the package, so its file is reachable). */
type RedisStoreCtor = new (
  continueExceeding: unknown,
  exponentialBackoff: unknown,
  redis: unknown,
  nameSpace?: unknown,
) => RateLimitStoreLike;

const REDIS_STORE_SPECIFIER = "@fastify/rate-limit/store/RedisStore.js";

async function loadRedisStore(): Promise<RedisStoreCtor> {
  const specifier = REDIS_STORE_SPECIFIER;
  const mod = (await import(specifier)) as { default?: RedisStoreCtor } & RedisStoreCtor;
  const ctor = mod.default ?? mod;
  if (typeof ctor !== "function")
    throw new Error(`[arc] ${REDIS_STORE_SPECIFIER} did not export the Redis store constructor`);
  return ctor;
}

/**
 * Wrap the shared store of built rate-limit options in the fallback (default ON whenever a
 * shared store is configured; `storeFallback: false` keeps the plugin's own behaviour).
 * `storeFallback` itself is always removed from the options handed to the plugin.
 */
export async function applyRateLimitStoreFallback(
  opts: Record<string, unknown>,
  log: Logger,
  deps: { loadRedisStore?: () => Promise<RedisStoreCtor>; now?: () => number } = {},
): Promise<Record<string, unknown>> {
  const { storeFallback, ...rest } = opts as Record<string, unknown> & {
    storeFallback?: RateLimitStoreFallbackOptions | false;
  };
  if (storeFallback === false) return rest;
  const fallback = storeFallback ?? {};
  const fallbackOptions = { ...fallback, log, ...(deps.now ? { now: deps.now } : {}) };

  if (rest.store != null) {
    const Store = rest.store as new (params: Record<string, unknown>) => RateLimitStoreLike;
    return {
      ...rest,
      store: createFallbackStoreClass((params) => new Store(params), fallbackOptions),
    };
  }
  if (rest.redis != null) {
    const { redis, nameSpace, ...withoutRedis } = rest;
    const RedisStore = await (deps.loadRedisStore ?? loadRedisStore)();
    return {
      ...withoutRedis,
      store: createFallbackStoreClass(
        (params) =>
          new RedisStore(params.continueExceeding, params.exponentialBackoff, redis, nameSpace),
        fallbackOptions,
      ),
    };
  }
  return rest;
}
