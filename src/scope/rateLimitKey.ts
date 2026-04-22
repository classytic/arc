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

export function createTenantKeyGenerator(
  opts?: TenantKeyGeneratorOptions,
): (ctx: RateLimitKeyContext) => string {
  if (opts?.strategy) {
    return opts.strategy;
  }

  return (ctx: RateLimitKeyContext): string => {
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
  };
}
