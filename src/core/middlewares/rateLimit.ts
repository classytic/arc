/**
 * Per-route rate-limit config for @fastify/rate-limit.
 */

import type { RateLimitConfig } from "../../types/index.js";

/**
 * HTTP methods for which Fastify's rate-limit plugin applies per-route config.
 */
export interface RouteRateLimitConfig {
  rateLimit: { max: number; timeWindow: string } | false;
}

/**
 * Build the `config` object for Fastify route options so
 * @fastify/rate-limit picks up per-route overrides.
 *
 *   - `undefined`                 → no override (inherits instance config)
 *   - `false`                     → explicitly disable rate limiting
 *   - `{ max, timeWindow }`       → apply that limit
 */
export function buildRateLimitConfig(
  rateLimit: RateLimitConfig | false | undefined,
): RouteRateLimitConfig | undefined {
  if (rateLimit === undefined) return undefined;
  if (rateLimit === false) return { rateLimit: false };
  return {
    rateLimit: {
      max: rateLimit.max,
      timeWindow: rateLimit.timeWindow,
    },
  };
}
