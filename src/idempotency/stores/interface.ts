/**
 * Idempotency Store Interface
 *
 * Defines the contract for idempotency key storage backends.
 * Implement this interface for custom stores (Redis, DynamoDB, etc.)
 */

export interface IdempotencyResult {
  /** The idempotency key */
  key: string;
  /**
   * `fingerprintRequest` of the body the key was first used with. A retry under the same key
   * with a different body is refused (422), never answered with this response. Absent on
   * entries written before 2.43 — those replay without the check.
   */
  requestFingerprint?: string;
  /** HTTP status code of the cached response */
  statusCode: number;
  /** Response headers to replay */
  headers: Record<string, string>;
  /** Response body */
  body: unknown;
  /** Binary responses are stored as base64 so JSON-backed stores preserve their bytes. */
  bodyEncoding?: "base64";
  /** When this entry was created */
  createdAt: Date;
  /** When this entry expires */
  expiresAt: Date;
}

export interface IdempotencyLock {
  /** The idempotency key being locked */
  key: string;
  /** Request ID that holds the lock */
  requestId: string;
  /** When the lock was acquired */
  lockedAt: Date;
  /** When the lock expires (auto-release) */
  expiresAt: Date;
}

/** What one atomic {@link IdempotencyStore.acquire} found. */
export type IdempotencyAcquisition =
  | { readonly status: "acquired" }
  | { readonly status: "completed"; readonly result: IdempotencyResult }
  | { readonly status: "locked" };

export interface IdempotencyStore {
  /** Store name for logging */
  readonly name: string;
  /** false when a conditional completion method cannot be atomic with this backing client. */
  readonly supportsFencedCompletion?: boolean;
  /** true when `setIfLocked` also releases the lock, so a completed request needs no `unlock`. */
  readonly completionReleasesLock?: boolean;

  /**
   * ONE atomic step: an unexpired completion → `completed`; an unexpired lock → `locked`;
   * otherwise `requestId` now holds the lock (first use, expired lease, or expired result).
   * Optional — without it callers run `get` → `tryLock` → `get`.
   */
  acquire?(key: string, requestId: string, lockTtlMs: number): Promise<IdempotencyAcquisition>;

  /**
   * Get a cached result for an idempotency key.
   * Returns undefined if not found or expired.
   */
  get(key: string): Promise<IdempotencyResult | undefined>;

  /**
   * Store a result for an idempotency key.
   * TTL is handled by the store implementation.
   */
  set(key: string, result: Omit<IdempotencyResult, "key">): Promise<void>;
  /**
   * Atomically record only while requestId owns an unexpired lock. false means ownership lost.
   * A store declaring `completionReleasesLock` clears the lock in the same write.
   */
  setIfLocked?(
    key: string,
    requestId: string,
    result: Omit<IdempotencyResult, "key">,
  ): Promise<boolean>;

  /**
   * Try to acquire a lock for processing a key.
   * Returns true if lock acquired, false if already locked.
   */
  tryLock(key: string, requestId: string, ttlMs: number): Promise<boolean>;

  /** Release a lock after processing complete */
  unlock(key: string, requestId: string): Promise<void>;

  /** Check if a key is currently locked */
  isLocked(key: string): Promise<boolean>;

  /** Delete a cached result by exact key */
  delete(key: string): Promise<void>;

  /**
   * Delete all cached results whose key starts with the given prefix.
   * Used by invalidate() to clear entries by raw idempotency key
   * regardless of fingerprint.
   * Returns the number of entries deleted.
   */
  deleteByPrefix(prefix: string): Promise<number>;

  /**
   * Find the first cached result whose key starts with the given prefix.
   * Used by has() to check if any entry exists for a raw idempotency key.
   * Returns undefined if no matching entry found.
   */
  findByPrefix(prefix: string): Promise<IdempotencyResult | undefined>;

  /** Close the store (cleanup connections) */
  close?(): Promise<void>;
}

/**
 * Helper to create a result object
 */
export function createIdempotencyResult(
  statusCode: number,
  body: unknown,
  headers: Record<string, string>,
  ttlMs: number,
  requestFingerprint?: string,
): Omit<IdempotencyResult, "key"> {
  const now = new Date();
  return {
    ...(requestFingerprint ? { requestFingerprint } : {}),
    statusCode,
    headers,
    body,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  };
}
