import type { FastifyRequest } from "fastify";

/** Tags for one response: a fixed list, or computed from the request and the reply body. */
export type TagSpec =
  | readonly string[]
  | ((request: FastifyRequest, body: unknown) => readonly string[] | undefined);

/** How one route may be cached. Seconds throughout. */
export interface HttpCachePolicy {
  /** Shared-cache (CDN) TTL. Must be > 0. */
  cdn: number;
  /** Browser TTL. A browser copy cannot be purged, so keep it short. Default 0. */
  browser?: number;
  /** Serve a stale copy while one request refreshes it (RFC 5861). CDN only. */
  staleWhileRevalidate?: number;
  /** Serve the last good copy while the origin errors (RFC 5861). Browser and CDN. */
  staleIfError?: number;
  /** Purge tags carried by the response, in addition to any derived ones. */
  tags?: TagSpec;
}

/** A path-prefix rule, for routes that cannot carry `config`. */
export interface HttpCacheRule extends HttpCachePolicy {
  /** Path prefix, matched against the URL path without its query string. */
  match: string;
}

/** Extra tags for one document: added to the derived `<resource>` / `<resource>:<id>`. */
export type DocumentTags = (doc: unknown) => readonly string[] | undefined;

/** `defineResource({ httpCache })`: one policy per read operation; tags and purges derived from the resource. */
export interface ResourceHttpCacheConfig {
  list?: HttpCachePolicy;
  get?: HttpCachePolicy;
  tags?: { extra?: DocumentTags };
}

/** What arc puts in a CRUD route's `config.httpCache` for a resource that declared `httpCache`. */
export interface RouteHttpCacheConfig extends HttpCachePolicy {
  resource?: { name: string; op: "list" | "get"; extra?: DocumentTags };
}

export type PrivacyReason =
  | `header:${string}`
  | `cookie:${string}`
  | `scope:${string}`
  | "classifier";

export type PrivacyDecision = { private: false } | { private: true; reason: PrivacyReason };

/** Why a response on an opted-in route was not made public. */
export type NonCacheableReason = PrivacyReason | "status" | "set-cookie";
