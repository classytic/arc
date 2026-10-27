import type { HttpCachePolicy, NonCacheableReason } from "./policy.types.js";

export interface DirectiveOptions {
  /** Emit RFC 9213 `CDN-Cache-Control`: the CDN TTL no browser or proxy sees. Default true. */
  cdnCacheControl?: boolean;
  /** Also put `s-maxage` in `Cache-Control`, for CDNs that do not read RFC 9213. Default true. */
  sMaxAge?: boolean;
}

export type CacheHeaders = Readonly<Record<string, string>>;

const seconds = (n: number | undefined): number => Math.max(0, Math.floor(n ?? 0));

/** Headers for a reply a shared cache may store. One function, so every tier reads one decision. */
export function publicHeaders(policy: HttpCachePolicy, opts: DirectiveOptions = {}): CacheHeaders {
  const cdn = seconds(policy.cdn);
  const browser = ["public", `max-age=${seconds(policy.browser)}`];
  if (opts.sMaxAge !== false) browser.push(`s-maxage=${cdn}`);
  if (policy.staleIfError) browser.push(`stale-if-error=${seconds(policy.staleIfError)}`);
  const headers: Record<string, string> = { "cache-control": browser.join(", ") };
  if (opts.cdnCacheControl !== false) {
    const edge = [`max-age=${cdn}`];
    if (policy.staleWhileRevalidate)
      edge.push(`stale-while-revalidate=${seconds(policy.staleWhileRevalidate)}`);
    if (policy.staleIfError) edge.push(`stale-if-error=${seconds(policy.staleIfError)}`);
    headers["cdn-cache-control"] = edge.join(", ");
  }
  return headers;
}

/** Headers for a reply no shared cache may store. */
export function privateHeaders(reason: NonCacheableReason): CacheHeaders {
  return reason === "status"
    ? { "cache-control": "no-store" }
    : { "cache-control": "private, no-store" };
}

/** A policy that cannot be honoured fails at registration, never on a request. */
export function assertPolicy(policy: HttpCachePolicy, where: string): void {
  if (typeof policy.cdn !== "number" || !Number.isFinite(policy.cdn) || policy.cdn <= 0) {
    throw new Error(`[arc] httpCache ${where}: cdn must be a positive number of seconds`);
  }
  for (const key of ["browser", "staleWhileRevalidate", "staleIfError"] as const) {
    const n = policy[key];
    if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || n < 0)) {
      throw new Error(`[arc] httpCache ${where}: ${key} must be zero or more seconds`);
    }
  }
}
