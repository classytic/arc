/**
 * Per-route entries on Fastify's `routeOptions.config` — rate limit, CORS, and
 * arc's own extensions bag. One builder so the CRUD, custom, and action routers
 * cannot diverge on which concerns they forward.
 */

import type { RateLimitConfig, ResourceExtensions } from "../../types/index.js";

/**
 * HTTP methods for which Fastify's rate-limit plugin applies per-route config.
 */
export interface RouteRateLimitConfig {
  rateLimit: { max: number; timeWindow: string } | false;
}

/**
 * Per-route CORS override, read by `@fastify/cors` off `routeOptions.config.cors`.
 *
 * The app-wide policy cannot serve both an API and public assets: an API wants
 * `credentials: true` with a pinned origin list, while a public asset wants
 * `origin: "*"` — and `*` with credentials is forbidden by the CORS spec (arc
 * throws at boot on that combination). Per-route is the granularity that
 * resolves it. `false` disables CORS for the route entirely.
 *
 * Arc does not interpret the value; `@fastify/cors` owns the semantics. Typed
 * loosely on purpose so a host is never blocked by arc lagging the plugin's
 * option surface.
 */
export type RouteCorsConfig = Record<string, unknown> | false;

/**
 * Build the per-route Fastify `config` object shared by the CRUD, custom, and
 * action routers. Two independent concerns ride on `routeOptions.config`:
 *   - `config.rateLimit`     — read by `@fastify/rate-limit`.
 *   - `config.cors`          — read by `@fastify/cors` as a per-route override.
 *   - `config.arcExtensions` — read by arc plugins (encryption, …) at request
 *     time, sourced from `defineResource({ extensions })`.
 *
 * Returns `{}` (no `config` key) when neither is present, so routes without
 * either stay config-free and the spread is a genuine no-op. Both fields are
 * optional in the return type, so no cast is needed when only one is set.
 */
export function buildRouteConfig(
  rateLimitConfig: RouteRateLimitConfig | undefined,
  extensions: ResourceExtensions | undefined,
  cors?: RouteCorsConfig,
): {
  config?: {
    rateLimit?: RouteRateLimitConfig["rateLimit"];
    cors?: RouteCorsConfig;
    arcExtensions?: ResourceExtensions;
  };
} {
  // `cors: false` is meaningful (disable for this route), so test for presence
  // rather than truthiness — `!cors` would silently drop the disable.
  const hasCors = cors !== undefined;
  if (!rateLimitConfig && !extensions && !hasCors) return {};
  return {
    config: {
      ...(rateLimitConfig ?? {}),
      ...(hasCors ? { cors } : {}),
      ...(extensions ? { arcExtensions: extensions } : {}),
    },
  };
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
