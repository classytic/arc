/**
 * Per-Tenant Rate Limit Key Generator
 *
 * Generates rate limit keys based on request scope:
 * - member → organizationId (per-tenant isolation)
 * - authenticated → userId (per-user)
 * - service → organizationId (required on service scope)
 * - elevated → organizationId ?? userId ?? IP
 * - public → IP address (fallback)
 *
 * ## IP fallback caveat
 *
 * When no scope is present on the request (e.g. calls that hit the app
 * before auth runs, such as `/api/auth/get-session` or pre-branch-selection
 * lookups that can't supply an `x-organization-id` header) the generator
 * falls back to the caller's IP. In a multi-user NAT / office / shared-VPN
 * scenario **one browser can exhaust the shared IP bucket** for every
 * other user behind that IP.
 *
 * Mitigations:
 * 1. Exempt heartbeat / pre-auth paths from rate limiting via the
 *    top-level `rateLimit: { skipPaths: ['/api/auth/*'] }` option.
 * 2. Supply a custom `strategy` to this generator that reads a session
 *    cookie or signed token and derives a per-user key earlier in the
 *    request lifecycle.
 * 3. Tighten `trustProxy` so the fallback uses the real client IP, not
 *    a shared load-balancer IP.
 *
 * @example
 * ```typescript
 * import { createTenantKeyGenerator } from '@classytic/arc/scope';
 *
 * const app = await createApp({
 *   rateLimit: {
 *     max: 100,
 *     timeWindow: '1 minute',
 *     keyGenerator: createTenantKeyGenerator(),
 *     skipPaths: ['/api/auth/*'], // heartbeat endpoints bypass the bucket
 *   },
 * });
 * ```
 */

import type { RequestScope } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface RateLimitKeyContext {
  ip: string;
  scope?: RequestScope;
}

export interface TenantKeyGeneratorOptions {
  /** Custom strategy — overrides default scope-based logic */
  strategy?: (ctx: RateLimitKeyContext) => string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Marks a key generator as SCOPE-AWARE, so `buildRateLimitOpts` can place the rate-limit
 * hook after authentication instead of before it.
 *
 * Without this, the degradation is invisible: `@fastify/rate-limit` runs at `onRequest`,
 * arc authenticates in a `preHandler`, so a scope-keyed generator sees `PUBLIC_SCOPE`,
 * returns the IP for every caller, and — behind a proxy — buckets an entire deployment
 * together. Nothing throws; the limiter simply answers a question nobody asked.
 *
 * `Symbol.for` so the marker survives two copies of arc in one tree.
 */
export const SCOPE_AWARE_KEY_GENERATOR = Symbol.for("arc.rateLimit.scopeAwareKeyGenerator");

/** True when this generator needs a resolved scope (see the symbol's docblock). */
export function isScopeAwareKeyGenerator(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    (fn as unknown as Record<symbol, unknown>)[SCOPE_AWARE_KEY_GENERATOR] === true
  );
}

export function createTenantKeyGenerator(
  opts?: TenantKeyGeneratorOptions,
): (ctx: RateLimitKeyContext) => string {
  const generator = opts?.strategy ?? defaultTenantStrategy;
  /**
   * Wrapped rather than tagged in place: a host's `strategy` is its own function, and
   * stamping a symbol onto it would mutate a value it may reuse elsewhere.
   */
  const tagged = (ctx: RateLimitKeyContext): string => generator(ctx);
  Object.defineProperty(tagged, SCOPE_AWARE_KEY_GENERATOR, { value: true, enumerable: false });
  return tagged;
}

function defaultTenantStrategy(ctx: RateLimitKeyContext): string {
  const scope = ctx.scope;
  if (!scope || scope.kind === "public") {
    return ctx.ip;
  }

  if (scope.kind === "member") {
    return scope.organizationId;
  }

  if (scope.kind === "service") {
    // Service scopes are always org-bound (see RequestScope type — organizationId
    // is required on kind: "service"). Use the org as the rate-limit key so
    // machine-to-machine traffic shares the tenant's budget with user traffic.
    return scope.organizationId;
  }

  if (scope.kind === "elevated") {
    return scope.organizationId ?? scope.userId ?? ctx.ip;
  }

  // authenticated
  return scope.userId ?? ctx.ip;
}
