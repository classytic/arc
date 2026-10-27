/**
 * Runner-agnostic assertions for cache behaviour (they throw `Error`; no test framework is imported).
 */
import type { CdnResponse, FakeCdn } from "./fake-cdn.js";

type HeaderBag = { headers: Record<string, string | string[] | number | undefined> };
const header = (res: HeaderBag, name: string): string | undefined => {
  const v = res.headers[name];
  return v === undefined ? undefined : Array.isArray(v) ? v.join(", ") : String(v);
};

/** The response may be stored by a shared cache, optionally carrying these tags. */
export function expectCacheable(
  res: HeaderBag,
  opts: { tags?: readonly string[]; tagHeader?: string } = {},
): void {
  const cc = header(res, "cache-control") ?? "";
  if (!/\bpublic\b/.test(cc)) throw new Error(`expected a public Cache-Control, got "${cc}"`);
  if (opts.tags) {
    const raw = header(res, (opts.tagHeader ?? "cache-tag").toLowerCase()) ?? "";
    const got = new Set(raw.split(/[,\s]+/).filter(Boolean));
    const missing = opts.tags.filter((t) => !got.has(t));
    if (missing.length) throw new Error(`expected tags [${missing.join(", ")}] in "${raw}"`);
  }
}

/** No shared cache may store the response, and it carries no tags. */
export function expectPrivate(res: HeaderBag, opts: { tagHeader?: string } = {}): void {
  const cc = header(res, "cache-control") ?? "";
  if (!/\bno-store\b/.test(cc)) throw new Error(`expected no-store, got "${cc}"`);
  if (header(res, (opts.tagHeader ?? "cache-tag").toLowerCase()))
    throw new Error("a private response carried a tag header");
}

/** The edge served this request without reaching the origin. */
export function expectHit(res: CdnResponse): void {
  if (res.cacheStatus !== "HIT") throw new Error(`expected HIT, got ${res.cacheStatus}`);
}

/** These tags were purged (in any call, any mode). */
export function expectPurged(cdn: FakeCdn, tags: readonly string[]): void {
  const sent = new Set(cdn.stats.purges.flatMap((p) => p.tags));
  const missing = tags.filter((t) => !sent.has(t));
  if (missing.length)
    throw new Error(`expected purge of [${missing.join(", ")}]; purged [${[...sent].join(", ")}]`);
}
