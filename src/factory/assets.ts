/**
 * Static asset serving — a POLICY layer over `@fastify/static`.
 *
 * Arc implements none of the transport mechanics. `@fastify/static` already
 * ships byte ranges (audio/video seeking), `ETag` + `Last-Modified` conditional
 * requests, `immutable` cache directives, pre-compressed `.br`/`.gz` sibling
 * selection with the matching `Vary: Accept-Encoding`, dotfile refusal, and the
 * `reply.sendFile()` / `reply.download()` decorators. Re-deriving any of that
 * would be strictly worse. What arc adds is the part a host gets wrong:
 *
 * ## The header that actually breaks cross-origin assets
 *
 * Arc enables `@fastify/helmet` by default, and helmet's defaults include
 * `Cross-Origin-Resource-Policy: same-origin`. That instructs the browser to
 * refuse to EMBED the response in any cross-origin document — `<img>`,
 * `<audio>`, `<video>`, fonts, stylesheets. The request still returns 200 and
 * CORS still negotiates correctly; the browser simply discards the body and
 * reports `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`, which names neither CORS nor
 * arc. A frontend on a different origin than the API therefore cannot render an
 * uploaded image no matter how the CORS list is configured — and a hand-rolled
 * static route hits it too, because the header comes from the app, not the route.
 *
 * {@link AssetRoot.crossOrigin} sets CORP for THAT PREFIX ONLY, so relaxing it
 * for `/uploads` never relaxes it for the API surface.
 *
 * ## Cache policy is a preset, not a raw `maxAge`
 *
 * A content-addressed path (hashed filename) can be cached forever; a mutable
 * one must revalidate. Getting it backwards means serving stale bytes for a year
 * with no recovery path, so arc names the two cases instead of exposing a
 * number, and DEFAULTS to the safe one — arc cannot know whether a host's
 * filenames carry a hash.
 *
 * ## Uploads are `attachment` by default
 *
 * Serving user-uploaded content `inline` is stored XSS: an uploaded `.svg` or
 * `.html` executes on your origin, with your cookies. Arc defaults to
 * `Content-Disposition: attachment` and makes `inline` the explicit choice for
 * trusted, transformed derivatives.
 */

import type { FastifyInstance } from "fastify";
import { loadPlugin } from "./security/pluginLoader.js";
import type { AssetRoot, ResolvedAssetPolicy } from "./types/assets.js";

/**
 * Cache-Control per preset.
 *
 * - `immutable` — content-addressed output ONLY (a hashed filename that changes
 *   when the bytes change). One year + `immutable` so a revalidation is never
 *   even attempted.
 * - `revalidate` — the default. The client may cache but MUST check freshness;
 *   `@fastify/static`'s `ETag`/`Last-Modified` then makes the common case a 304
 *   with no body, which is nearly as cheap as a cache hit and always correct.
 * - `none` — never store. For a path that is authorization-dependent, where a
 *   shared cache holding the bytes would leak them to the next caller.
 */
const CACHE_CONTROL: Record<NonNullable<AssetRoot["cache"]>, string> = {
  immutable: "public, max-age=31536000, immutable",
  revalidate: "public, max-age=0, must-revalidate",
  none: "no-store",
};

/**
 * Resolve one asset root's declaration into the header policy arc applies per
 * file. Pure — no Fastify, no filesystem — so the policy is unit-testable
 * without booting an app.
 */
export function resolveAssetPolicy(root: AssetRoot): ResolvedAssetPolicy {
  const cache = root.cache ?? "revalidate";
  // `same-site` is the useful default: it covers the overwhelmingly common
  // api.example.com → app.example.com split while still refusing an unrelated
  // origin. `cross-origin` stays an explicit opt-in — it permits ANY site to
  // embed (and hotlink) the bytes, which is right for a public CDN-style asset
  // and wrong for anything else.
  const crossOrigin = root.crossOrigin ?? "same-site";
  const disposition = root.disposition ?? "attachment";

  return {
    cacheControl: CACHE_CONTROL[cache],
    crossOriginResourcePolicy: crossOrigin,
    disposition,
    // A response whose bytes depend on the caller must never land in a shared
    // cache under a caller-independent key.
    varyOrigin: crossOrigin !== "same-origin",
  };
}

/** Quote a filename for `Content-Disposition` per RFC 6266 / RFC 5987. */
function contentDisposition(type: "inline" | "attachment", filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "download";
  // ASCII fallback with quotes escaped, plus the UTF-8 form for non-ASCII names.
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "\\$&");
  const encoded = encodeURIComponent(name);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Register every declared asset root.
 *
 * Each root becomes its OWN `@fastify/static` registration. That is deliberate:
 * `@fastify/static` scopes `prefix`, `root`, and the send options per
 * registration, so two roots with different cache or cross-origin policy stay
 * genuinely independent instead of sharing one mutable options bag.
 *
 * Registered AFTER the security plugins so the per-prefix CORP override lands on
 * top of helmet's app-wide default — helmet sets its headers in an `onRequest`
 * hook, while `setHeaders` runs at send time, so the asset policy wins.
 */
export async function registerAssetRoots(
  fastify: FastifyInstance,
  roots: readonly AssetRoot[],
): Promise<void> {
  if (roots.length === 0) return;

  const staticPlugin = await loadPlugin("static", fastify.log);
  if (!staticPlugin) {
    throw new Error(
      "[arc] `assets` was configured but '@fastify/static' is not installed. " +
        "Install it with: npm install @fastify/static — arc delegates ranges, ETags, " +
        "immutable caching and pre-compressed variants to it rather than reimplementing them.",
    );
  }

  // Prefix collisions must fail at BOOT, not resolve by registration order — two
  // roots on one prefix means the second silently never serves, and the symptom
  // is a 404 for files that exist on disk.
  const seen = new Map<string, string>();
  for (const root of roots) {
    const prior = seen.get(root.prefix);
    if (prior !== undefined) {
      throw new Error(
        `[arc] duplicate asset prefix "${root.prefix}" — declared for roots "${prior}" and ` +
          `"${root.root}". Asset prefixes must be unique; nest them (e.g. "/files/public" and ` +
          `"/files/private") instead of sharing one.`,
      );
    }
    seen.set(root.prefix, String(root.root));
  }

  for (const root of roots) {
    const policy = resolveAssetPolicy(root);

    await fastify.register(staticPlugin as never, {
      root: root.root,
      prefix: root.prefix,
      // Only the FIRST registration may decorate `reply.sendFile`, and arc may
      // register several roots — let the plugin's own decorator land once.
      decorateReply: root.decorateReply ?? false,
      // Directory listings enumerate everything under the root; that is a
      // disclosure decision a host makes deliberately, never a default.
      list: false,
      index: root.index ?? false,
      // Refuse hidden files outright (403): `.env`, `.git/config`, `.htpasswd`
      // live in directories that get deployed by accident.
      dotfiles: "deny",
      serveDotFiles: false,
      // Arc owns Cache-Control through `setHeaders`, so the plugin must not also
      // emit its own — two sources for one header is how they diverge.
      cacheControl: false,
      etag: root.etag ?? true,
      lastModified: root.lastModified ?? true,
      acceptRanges: root.acceptRanges ?? true,
      ...(root.preCompressed !== undefined ? { preCompressed: root.preCompressed } : {}),
      ...(root.allowedPath ? { allowedPath: root.allowedPath } : {}),
      setHeaders: (
        reply: {
          header: (k: string, v: string) => unknown;
        },
        filePath: string,
      ) => {
        reply.header("Cache-Control", policy.cacheControl);
        // THE fix — scoped to this prefix, leaving the API's default intact.
        reply.header("Cross-Origin-Resource-Policy", policy.crossOriginResourcePolicy);
        reply.header("Content-Disposition", contentDisposition(policy.disposition, filePath));
        // Belt-and-braces against an executable upload: even if a host flips to
        // `inline`, a sniffed `text/html` must not become script on this origin.
        reply.header("X-Content-Type-Options", "nosniff");
        if (policy.varyOrigin) reply.header("Vary", "Origin, Accept-Encoding");
        root.setHeaders?.(reply as never, filePath);
      },
    });

    fastify.log.debug(
      `[arc] asset root "${root.prefix}" → ${String(root.root)} ` +
        `(cache: ${root.cache ?? "revalidate"}, cross-origin: ${policy.crossOriginResourcePolicy})`,
    );
  }
}
