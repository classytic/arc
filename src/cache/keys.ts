/**
 * Cache Key Utilities
 *
 * Deterministic, scope-safe key generation for QueryCache.
 * Keys include resource version, operation, params hash, and user/org scope
 * to ensure multi-tenant isolation and O(1) version-based invalidation.
 */

import { contentHash } from "@classytic/repo-core/hash";

/** Build a deterministic cache key for a query */
export function buildQueryKey(
  resource: string,
  operation: string,
  resourceVersion: number,
  params: Record<string, unknown>,
  userId?: string,
  orgId?: string,
): string {
  const hash = hashParams(params);
  const uid = userId ?? "anon";
  const oid = orgId ?? "pub";
  return `arc:${resource}:${resourceVersion}:${operation}:${hash}:u=${uid}:o=${oid}`;
}

/** Resource version key — stored in CacheStore, bumped on mutations */
export function versionKey(resource: string): string {
  return `arc:ver:${resource}`;
}

/** Tag version key — stored in CacheStore, bumped on cross-resource invalidation */
export function tagVersionKey(tag: string): string {
  return `arc:tagver:${tag}`;
}

/**
 * Digest of the query params for a cache key — repo-core's canonical serialiser (escaped,
 * type-preserving, key-order-free) under SHA-256. Two different queries never share a key: a
 * delimiter inside a value, `1` vs `"1"`, two dates or two regexes all stay distinct, and a
 * cryptographic digest leaves no crafted collision onto another caller's cached result.
 */
export function hashParams(params: Record<string, unknown>): string {
  return contentHash(params, { encoding: "base64url" });
}
