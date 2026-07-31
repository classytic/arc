/**
 * Static asset declaration types. See `../assets.ts` for the policy rationale —
 * in particular why `Cross-Origin-Resource-Policy` is the header that actually
 * breaks cross-origin asset loading, and why cache policy is a named preset
 * rather than a raw `maxAge`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * How other origins may EMBED these bytes — the value of
 * `Cross-Origin-Resource-Policy` for this prefix.
 *
 * - `same-site` (default) — `app.example.com` may embed assets served by
 *   `api.example.com`; an unrelated site may not. The common deployment split.
 * - `cross-origin` — ANY site may embed (and hotlink). Correct for genuinely
 *   public, CDN-style assets; wrong for anything caller-specific.
 * - `same-origin` — only the exact same origin. Arc's app-wide default; set it
 *   per-root to keep a private prefix locked down.
 */
export type AssetCrossOrigin = "same-origin" | "same-site" | "cross-origin";

/** Cache posture for a prefix. See `CACHE_CONTROL` in `../assets.ts`. */
export type AssetCache = "immutable" | "revalidate" | "none";

/** One static root mounted at one URL prefix. */
export interface AssetRoot {
  /**
   * URL prefix to serve from, e.g. `"/uploads"`. Must be unique across roots —
   * a duplicate fails at boot rather than silently shadowing.
   */
  readonly prefix: string;
  /** Filesystem directory (or directories) to serve. Passed to `@fastify/static`. */
  readonly root: string | readonly string[] | URL | readonly URL[];
  /**
   * Who may embed these bytes cross-origin. Defaults to `"same-site"`.
   * **This is the setting that unbreaks a separate-origin frontend** — arc's
   * app-wide default (from helmet) is `same-origin`, which blocks the embed even
   * when CORS is correct.
   */
  readonly crossOrigin?: AssetCrossOrigin;
  /**
   * Cache posture. Defaults to `"revalidate"` — safe for mutable paths, and
   * cheap in practice because `ETag` turns the steady state into a 304.
   *
   * Use `"immutable"` ONLY for content-addressed filenames (a hash that changes
   * with the bytes). On a mutable path it serves stale content for a year.
   */
  readonly cache?: AssetCache;
  /**
   * `Content-Disposition` type. Defaults to `"attachment"`.
   *
   * Keep the default for anything user-uploaded: serving untrusted content
   * `inline` lets an uploaded `.svg`/`.html` execute on your origin with your
   * cookies. `"inline"` is for trusted, transformed derivatives you produced.
   */
  readonly disposition?: "inline" | "attachment";
  /**
   * Serve `.br`/`.gz` siblings when the client accepts them. `@fastify/static`
   * adds `Vary: Accept-Encoding` automatically.
   *
   * ⚠ `allowedPath` is evaluated against the REQUESTED path, before the variant
   * is chosen — so denying `*.gz` does NOT prevent `/main.js` from serving
   * `main.js.gz`. Treat pre-compressed files as public alternate encodings of the
   * same asset; keep anything restricted out of the served root entirely.
   */
  readonly preCompressed?: boolean;
  /**
   * Per-request filter. Return `false` to fall through to the 404 handler.
   *
   * **Synchronous by contract** (it is `@fastify/static`'s signature), so an
   * async permission check CANNOT run here. That makes it the right home for a
   * SIGNED-URL check — HMAC verification is synchronous, needs no database, and
   * stays CDN-cacheable. For an async gate, put a `preHandler` on the prefix
   * instead.
   */
  readonly allowedPath?: (pathName: string, root: string, request: FastifyRequest) => boolean;
  /** Extra headers, applied AFTER arc's policy so a host can override it. */
  readonly setHeaders?: (reply: FastifyReply, filePath: string) => void;
  /** Serve `index.html` for a directory request. Default `false`. */
  readonly index?: string | readonly string[] | false;
  /** Emit `ETag`. Default `true` — it is what makes `revalidate` cheap. */
  readonly etag?: boolean;
  /** Emit `Last-Modified`. Default `true`. */
  readonly lastModified?: boolean;
  /** Support byte ranges — audio/video seeking, resumable downloads. Default `true`. */
  readonly acceptRanges?: boolean;
  /**
   * Let this root install the `reply.sendFile()` decorator. Default `false`
   * because only ONE registration may decorate; set it on exactly one root if
   * handlers need `reply.sendFile()`.
   */
  readonly decorateReply?: boolean;
}

/** The header policy one {@link AssetRoot} resolves to. */
export interface ResolvedAssetPolicy {
  readonly cacheControl: string;
  readonly crossOriginResourcePolicy: AssetCrossOrigin;
  readonly disposition: "inline" | "attachment";
  readonly varyOrigin: boolean;
}
