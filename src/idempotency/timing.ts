/** Canonical response lifetime and completion lease for every transport. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 86_400_000;
export const DEFAULT_IDEMPOTENCY_LOCK_TIMEOUT_MS = 30_000;

export function resolveIdempotencyTiming(
  ttlMs?: number,
  lockTimeoutMs?: number,
): {
  ttlMs: number;
  lockTimeoutMs: number;
} {
  const timing = {
    ttlMs: ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
    lockTimeoutMs: lockTimeoutMs ?? DEFAULT_IDEMPOTENCY_LOCK_TIMEOUT_MS,
  };
  for (const [name, value] of Object.entries(timing)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `[arc idempotency] ${name} must be a positive finite duration in milliseconds.`,
      );
    }
  }
  return timing;
}
