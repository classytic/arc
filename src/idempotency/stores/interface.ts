/**
 * Idempotency Store Interface
 *
 * Defines the contract for idempotency key storage backends.
 * Implement this interface for custom stores (Redis, DynamoDB, etc.)
 */

export interface IdempotencyResult {
  /** The idempotency key */
  key: string;
  /** HTTP status code of the cached response */
  statusCode: number;
  /** Response headers to replay */
  headers: Record<string, string>;
  /** Response body */
  body: unknown;
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

export interface IdempotencyStore {
  /** Store name for logging */
  readonly name: string;

  /**
   * Get a cached result for an idempotency key
   * Returns undefined if not found or expired
   */
  get(key: string): Promise<IdempotencyResult | undefined>;

  /**
   * Store a result for an idempotency key
   * TTL is handled by the store implementation
   */
  set(key: string, result: Omit<IdempotencyResult, 'key'>): Promise<void>;

  /**
   * Try to acquire a lock for processing a key
   * Returns true if lock acquired, false if already locked
   * Used to prevent concurrent processing of the same key
   */
  tryLock(key: string, requestId: string, ttlMs: number): Promise<boolean>;

  /**
   * Release a lock after processing complete
   */
  unlock(key: string, requestId: string): Promise<void>;

  /**
   * Check if a key is currently locked
   */
  isLocked(key: string): Promise<boolean>;

  /**
   * Delete a cached result (for manual invalidation)
   */
  delete(key: string): Promise<void>;

  /**
   * Close the store (cleanup connections)
   */
  close?(): Promise<void>;
}

/**
 * Helper to create a result object
 */
export function createIdempotencyResult(
  statusCode: number,
  body: unknown,
  headers: Record<string, string>,
  ttlMs: number
): Omit<IdempotencyResult, 'key'> {
  const now = new Date();
  return {
    statusCode,
    headers,
    body,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  };
}
