/**
 * A CDN in front of a Fastify app, for testing an app's cache policies and tag rules without a CDN account.
 *
 * Models the behaviours `httpCachePlugin` depends on (Cloudflare by default):
 * - a Cache Rule makes routes eligible and BYPASSes when `bypass(headers)` matches;
 * - the key is method + URL; `Vary` is ignored (Cloudflare honours only `Accept-Encoding`);
 * - `CDN-Cache-Control` (RFC 9213) wins over `Cache-Control`; `s-maxage` wins over `max-age`;
 *   `private` / `no-store` / `no-cache`, a zero TTL, or `Set-Cookie` means nothing is stored;
 * - `stale-while-revalidate` serves the stale copy (STALE) while refreshing; `stale-if-error` serves it
 *   when the origin answers 5xx;
 * - the tag header is stored with the entry and stripped from what the visitor receives;
 * - purge by tag: hard evicts, soft marks stale (served STALE once, then refreshed).
 */
import type { FastifyInstance } from "fastify";
import type { CachePurger } from "../purgers/purger.types.js";

export type CacheStatus = "HIT" | "MISS" | "EXPIRED" | "STALE" | "BYPASS" | "DYNAMIC";

export interface CdnResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  cacheStatus: CacheStatus;
  json<T = unknown>(): T;
}

export interface CdnRequest {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

interface Entry {
  status: number;
  headers: Record<string, string>;
  body: string;
  tags: Set<string>;
  storedAt: number;
  ttl: number;
  swr: number;
  sie: number;
  stale: boolean;
}

export interface FakeCdnOptions {
  /** The Cache Rule's bypass condition. Default: an `Authorization` header. */
  bypass?: (headers: Record<string, string>) => boolean;
  /** The tag header the origin sends. Default `{ name: 'Cache-Tag', separator: ',' }`. */
  tagHeader?: { name: string; separator: string };
  /** Whether this CDN supports soft purge. Default true. */
  softPurge?: boolean;
}

const directive = (cc: string, name: string): number | undefined => {
  const m = new RegExp(`(?:^|[,\\s])${name}=(\\d+)`).exec(cc);
  return m ? Number(m[1]) : undefined;
};

/** The edge's reading of a response: TTL and stale windows, or 0 when it must not store. */
export function edgeFreshness(headers: Record<string, string>): {
  ttl: number;
  swr: number;
  sie: number;
} {
  const target = headers["cdn-cache-control"];
  const cc = (target ?? headers["cache-control"] ?? "").toLowerCase();
  if (!cc || /\b(private|no-store|no-cache)\b/.test(cc)) return { ttl: 0, swr: 0, sie: 0 };
  const ttl = target
    ? (directive(cc, "max-age") ?? 0)
    : (directive(cc, "s-maxage") ?? directive(cc, "max-age") ?? 0);
  return {
    ttl,
    swr: directive(cc, "stale-while-revalidate") ?? 0,
    sie: directive(cc, "stale-if-error") ?? 0,
  };
}

export function createFakeCdn(origin: () => FastifyInstance, opts: FakeCdnOptions = {}) {
  const bypass = opts.bypass ?? ((h) => h.authorization !== undefined);
  const tagName = (opts.tagHeader?.name ?? "Cache-Tag").toLowerCase();
  const separator = opts.tagHeader?.separator ?? ",";
  const store = new Map<string, Entry>();
  const stats = {
    originRequests: 0,
    purges: [] as Array<{ tags: string[]; mode: "hard" | "soft" }>,
  };
  let now = 0;

  const visible = (headers: Record<string, string>) => {
    const out = { ...headers };
    delete out[tagName];
    return out;
  };
  const respond = (
    status: number,
    headers: Record<string, string>,
    body: string,
    cacheStatus: CacheStatus,
  ): CdnResponse => ({
    status,
    headers: { ...visible(headers), "cf-cache-status": cacheStatus },
    body,
    cacheStatus,
    json: <T>() => JSON.parse(body) as T,
  });

  async function fetchOrigin(req: CdnRequest, headers: Record<string, string>) {
    stats.originRequests++;
    const res = await origin().inject({
      method: req.method ?? "GET",
      url: req.url,
      headers,
      ...(req.payload !== undefined ? { payload: req.payload as never } : {}),
    });
    const out = Object.fromEntries(
      Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]),
    );
    return { status: res.statusCode, headers: out, body: res.body };
  }

  function storeEntry(
    key: string,
    res: { status: number; headers: Record<string, string>; body: string },
  ): boolean {
    const fresh =
      res.status >= 200 && res.status < 300 && res.headers["set-cookie"] === undefined
        ? edgeFreshness(res.headers)
        : undefined;
    if (!fresh || fresh.ttl <= 0) {
      store.delete(key);
      return false;
    }
    const tags = new Set(
      (res.headers[tagName] ?? "")
        .split(separator)
        .map((t) => t.trim())
        .filter(Boolean),
    );
    store.set(key, { ...res, tags, storedAt: now, ...fresh, stale: false });
    return true;
  }

  async function request(req: CdnRequest): Promise<CdnResponse> {
    const method = req.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const key = `GET ${req.url}`;
    const cacheable = method === "GET" || method === "HEAD";
    if (!cacheable) {
      const res = await fetchOrigin(req, headers);
      return respond(res.status, res.headers, res.body, "DYNAMIC");
    }
    if (bypass(headers)) {
      const res = await fetchOrigin(req, headers);
      return respond(res.status, res.headers, res.body, "BYPASS");
    }

    const entry = store.get(key);
    if (entry) {
      const age = (now - entry.storedAt) / 1000;
      const expired = entry.stale || age >= entry.ttl;
      if (!expired) return respond(entry.status, entry.headers, entry.body, "HIT");
      if (age < entry.ttl + entry.swr || entry.stale) {
        // Serve stale now; one background-equivalent refresh replaces it.
        const served = respond(entry.status, entry.headers, entry.body, "STALE");
        const res = await fetchOrigin(req, headers);
        if (res.status < 500) storeEntry(key, res);
        return served;
      }
      const res = await fetchOrigin(req, headers);
      if (res.status >= 500 && age < entry.ttl + entry.sie)
        return respond(entry.status, entry.headers, entry.body, "STALE");
      if (storeEntry(key, res)) return respond(res.status, res.headers, res.body, "EXPIRED");
      return respond(
        res.status,
        res.headers,
        res.body,
        res.headers["set-cookie"] !== undefined ? "BYPASS" : "DYNAMIC",
      );
    }

    const res = await fetchOrigin(req, headers);
    if (storeEntry(key, res)) return respond(res.status, res.headers, res.body, "MISS");
    return respond(
      res.status,
      res.headers,
      res.body,
      res.headers["set-cookie"] !== undefined ? "BYPASS" : "DYNAMIC",
    );
  }

  const purger: CachePurger = {
    name: "fake-cdn",
    capabilities: { softPurge: opts.softPurge !== false },
    async purgeTags(tags, { mode }) {
      stats.purges.push({ tags: [...tags], mode });
      for (const [key, entry] of store) {
        if (!tags.some((t) => entry.tags.has(t))) continue;
        if (mode === "soft" && opts.softPurge !== false) entry.stale = true;
        else store.delete(key);
      }
    },
  };

  return {
    request,
    purger,
    stats,
    /** Move the edge clock forward. */
    advance(ms: number) {
      now += ms;
    },
    /** URLs currently stored. */
    keys: () => [...store.keys()].map((k) => k.slice(4)),
    size: () => store.size,
  };
}

export type FakeCdn = ReturnType<typeof createFakeCdn>;
