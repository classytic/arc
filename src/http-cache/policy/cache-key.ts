/** Query parameters that never change a response: marketing and click identifiers. */
export const DEFAULT_IGNORED_QUERY = [
  "utm_*",
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
] as const;

export interface CanonicalQueryOptions {
  /** Parameter names to drop; a trailing `*` matches a prefix. Default {@link DEFAULT_IGNORED_QUERY}. */
  ignore?: readonly string[];
  /** Sort the remaining parameters by name (stable for repeats). Default true. */
  sort?: boolean;
}

function ignored(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/**
 * The one URL a response is cached under: tracking parameters dropped, the rest sorted. Equal content,
 * equal key, so a CDN stores one copy instead of one per campaign link.
 */
export function canonicalUrl(url: string, opts: CanonicalQueryOptions = {}): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const path = url.slice(0, q);
  const patterns = opts.ignore ?? DEFAULT_IGNORED_QUERY;
  const kept = [...new URLSearchParams(url.slice(q + 1)).entries()].filter(
    ([name]) => !ignored(name, patterns),
  );
  if (opts.sort !== false) kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = new URLSearchParams(kept).toString();
  return query ? `${path}?${query}` : path;
}
