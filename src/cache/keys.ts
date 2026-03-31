/**
 * Cache Key Utilities
 *
 * Deterministic, scope-safe key generation for QueryCache.
 * Keys include resource version, operation, params hash, and user/org scope
 * to ensure multi-tenant isolation and O(1) version-based invalidation.
 */

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
 * Stable hash for query params.
 * Sorts keys recursively, serializes to JSON, then applies djb2 hash.
 * Returns hex string.
 */
export function hashParams(params: Record<string, unknown>): string {
  const stable = stableStringify(params);
  return djb2(stable).toString(36);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    sorted.map((k) => `${k}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",") +
    "}"
  );
}

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}
