/**
 * Security-plugin option shapes — CORS / Helmet / rate-limit config for
 * `createApp()`, including plan-aware rate limiting.
 */

// These types are inlined to avoid forcing consumers to install optional peer deps.
// @fastify/cors, @fastify/helmet, @fastify/rate-limit are optional — their types
// should not leak into our declaration files.
export type CorsOptions = Record<string, unknown> & {
  origin?: unknown;
  credentials?: boolean;
  methods?: string[];
  allowedHeaders?: string[];
};
export type HelmetOptions = Record<string, unknown>;
export type RateLimitOpts = Record<string, unknown> & {
  max?: number;
  timeWindow?: string | number;
  /**
   * Path patterns to exempt from rate limiting. Supports exact match
   * (`/health`) or prefix match with trailing `*` (`/api/auth/*`).
   *
   * Implemented by synthesising a `@fastify/rate-limit` `allowList`
   * function. When combined with a user-supplied `allowList`, both
   * are OR-ed together (path OR ip/custom match skips the limit).
   *
   * Use this for endpoints that are hit frequently but independently
   * of user traffic — session heartbeat, webhooks, health probes.
   */
  skipPaths?: string[];
  /**
   * Plan-aware limits (2.22) — resolve the caller's plan per request and
   * apply that plan's ceiling instead of the global `max`:
   *
   * ```typescript
   * rateLimit: {
   *   timeWindow: '1 minute',
   *   plan: {
   *     resolve: (req) => lookupPlan(req),            // 'free' | 'pro' | ...
   *     limits: { free: { max: 60 }, pro: { max: 1000 }, enterprise: false },
   *     default: 'free',
   *   },
   * }
   * ```
   *
   * `false` = effectively unlimited. When `plan` is set and no
   * `keyGenerator` is supplied, arc defaults to the tenant key chain
   * (org → user → client → IP) so buckets follow actors, not addresses.
   *
   * Timing caveat: the limiter runs before route-level auth, so
   * `req.scope` may be unresolved for token-authenticated calls —
   * `resolve` receives the RAW request and may need to derive the plan
   * from its own header/token/session lookup. Same caveat as
   * `createTenantKeyGenerator`'s IP fallback (documented there).
   */
  plan?: RateLimitPlanConfig;
};

/** Plan-aware rate limiting (2.22) — see `rateLimit.plan` on CreateAppOptions. */
export interface RateLimitPlanConfig {
  /**
   * Name the caller's plan from the raw request. Return `undefined` to
   * fall back to `default`. Sync or async; a throwing resolver also
   * falls back (limits must fail-safe, not fail-open to unlimited).
   */
  resolve: (
    req: import("fastify").FastifyRequest,
  ) => string | undefined | Promise<string | undefined>;
  /** Per-plan ceilings within the shared `timeWindow`. `false` = effectively unlimited. */
  limits: Record<string, { max: number } | false>;
  /** Plan used when `resolve` returns undefined/unknown or throws. Default: fall back to the global `max`. */
  default?: string;
}
