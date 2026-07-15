/**
 * Resource-level rate-limit shape — shared by `ResourceConfig.rateLimit`
 * and per-route `RouteDefinition.rateLimit` overrides.
 */

export interface RateLimitConfig {
  /** Maximum number of requests allowed within the time window */
  max: number;
  /** Time window for rate limiting (e.g., '1 minute', '15 seconds') */
  timeWindow: string;
}
