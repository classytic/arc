/**
 * Per-Tenant Rate Limit Key Generator
 *
 * Generates rate limit keys based on request scope:
 * - member → organizationId (per-tenant isolation)
 * - authenticated → userId (per-user)
 * - elevated → organizationId or userId
 * - public → IP address (fallback)
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

    if (scope.kind === "elevated") {
      return scope.organizationId ?? scope.userId ?? ctx.ip;
    }

    // authenticated
    return scope.userId ?? ctx.ip;
  };
}
