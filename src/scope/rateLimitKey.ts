/**
 * Per-Tenant Rate Limit Key Generator
 *
 * Two named strategies (plus a custom function):
 *
 * - `'user'` — the signed-in user's id (`user:<id>`) when the scope has one, otherwise the
 *   client IP (IPv6 grouped by /64). This is `createApp`'s DEFAULT key when `rateLimit` has
 *   no `keyGenerator` and no `plan`: one office Wi-Fi or carrier NAT never throttles many
 *   signed-in users together, while sign-in / sign-up / reset (no user yet) stay per IP.
 * - `'organization'` — the default when `strategy` is omitted (unchanged since 2.x): one
 *   quota per organisation. Opt into it with
 *   `keyGenerator: createTenantKeyGenerator({ strategy: 'organization' })`.
 *
 * The `'organization'` chain:
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

import { isIPv6 } from "node:net";
import { getUserId, type RequestScope } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface RateLimitKeyContext {
  ip: string;
  scope?: RequestScope;
}

export interface TenantKeyGeneratorOptions {
  /**
   * `'organization'` (the default when omitted) — one bucket per organisation, see the
   * module docblock for the full chain. `'user'` — one bucket per signed-in user, IP when
   * anonymous (`createApp`'s default key). A function — your own key.
   */
  strategy?: "organization" | "user" | ((ctx: RateLimitKeyContext) => string);
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
  const strategy = opts?.strategy;
  const generator =
    typeof strategy === "function"
      ? strategy
      : strategy === "user"
        ? userStrategy
        : defaultTenantStrategy;
  /**
   * Wrapped rather than tagged in place: a host's `strategy` is its own function, and
   * stamping a symbol onto it would mutate a value it may reuse elsewhere.
   */
  const tagged = (ctx: RateLimitKeyContext): string => generator(ctx);
  Object.defineProperty(tagged, SCOPE_AWARE_KEY_GENERATOR, { value: true, enumerable: false });
  return tagged;
}

/**
 * Per user when signed in, per IP when anonymous. The `user:` prefix keeps a user id from
 * ever sharing a bucket with an address; the IP stays bare so an `allowList` of addresses
 * still matches anonymous traffic.
 */
function userStrategy(ctx: RateLimitKeyContext): string {
  const userId = ctx.scope ? getUserId(ctx.scope) : undefined;
  return userId ? `user:${userId}` : ipBucket(ctx.ip);
}

/**
 * The address bucket for anonymous traffic. IPv6 is grouped by /64 (one subscriber's
 * allocation, `@fastify/rate-limit`'s own default) so rotating addresses inside it does not
 * mint fresh buckets; IPv4-mapped IPv6 collapses to the IPv4 address.
 */
export function ipBucket(ip: string): string {
  if (!isIPv6(ip)) return ip.toLowerCase();
  const groups = expandIPv6(ip);
  if (!groups) return ip.toLowerCase();
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

function expandIPv6(ip: string): number[] | undefined {
  let s = ip.split("%", 1)[0] ?? "";
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? undefined : tail ? tail.split(":") : [];
  const parts =
    t === undefined ? h : [...h, ...new Array<string>(8 - h.length - t.length).fill("0"), ...t];
  if (parts.length !== 8) return undefined;
  return parts.map((p) => Number.parseInt(p, 16));
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
