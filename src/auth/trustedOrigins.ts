/**
 * `trustedOrigins` ↔ CORS-allowlist union helper.
 *
 * Better Auth's `trustedOrigins` (CSRF / origin guard) and Fastify's CORS
 * `origin` allowlist are independent — a request that survives CORS still
 * has to pass BA's origin check. When they drift, sign-in throws
 * `Invalid origin` 401s that don't surface CORS errors in the network
 * panel.
 *
 * Hosts have written the same union by hand in every app, with the same
 * three corner cases (array → union with canonical URL, `true` → `["*"]`,
 * `false`/undefined → just the canonical URL). This helper centralises
 * that rule so a future change happens in one place.
 *
 * @example
 * ```ts
 * import { betterAuth } from "better-auth";
 * import { mirrorTrustedOriginsFromCors } from "@classytic/arc/auth";
 * import config from "#config";
 *
 * export const auth = betterAuth({
 *   secret: config.betterAuth.secret,
 *   baseURL: process.env.BETTER_AUTH_URL,
 *   trustedOrigins: mirrorTrustedOriginsFromCors({
 *     corsOrigins: config.cors.origins,    // string[] | true | false
 *     canonicalUrl: config.frontend.url,   // FRONTEND_URL — used for email link templates
 *   }),
 *   // ...
 * });
 * ```
 *
 * Why both inputs:
 * - `canonicalUrl` is the single URL embedded in BA's email templates
 *   (invitation-accept, password-reset). It MUST be in `trustedOrigins`.
 * - `corsOrigins` is the browser allowlist. Every entry there is a real
 *   FE host that may attempt sign-in; missing one yields the silent 401.
 *
 * The union dedupes — passing `canonicalUrl` already in `corsOrigins` is
 * fine and won't duplicate the entry.
 */

/**
 * Shape arc's CORS plugin and most apps use:
 *   - `string[]` — explicit allowlist
 *   - `true` — wildcard (`*`)
 *   - `false` / `undefined` — no extra origins beyond `canonicalUrl`
 *
 * Other shapes (regex, predicate function) aren't supported here — pass
 * an explicit array if you have dynamic logic upstream.
 */
export type CorsOriginsConfig = readonly string[] | boolean | undefined;

export interface MirrorTrustedOriginsOptions {
  /**
   * CORS allowlist as configured for Fastify's CORS plugin.
   * Most apps read this from a `CORS_ORIGINS` env var (`*` → `true`,
   * comma-separated → `string[]`).
   */
  corsOrigins: CorsOriginsConfig;
  /**
   * The single canonical FE URL used for email-link templates
   * (invitation-accept, password-reset). Must be a trusted origin.
   * Typically `FRONTEND_URL`.
   */
  canonicalUrl: string;
}

/**
 * Compute BA's `trustedOrigins` as the union of `canonicalUrl` and the
 * CORS allowlist.
 *
 * Returns:
 *   - `["*"]` when `corsOrigins === true` (wildcard CORS).
 *   - `[canonicalUrl, ...corsOrigins]` deduped when `corsOrigins` is an
 *     array.
 *   - `[canonicalUrl]` when `corsOrigins` is `false` / `undefined`.
 */
export function mirrorTrustedOriginsFromCors(options: MirrorTrustedOriginsOptions): string[] {
  const { corsOrigins, canonicalUrl } = options;

  if (corsOrigins === true) return ["*"];
  if (!corsOrigins) return [canonicalUrl];

  // Array form — union, deduped, canonicalUrl first so it's the
  // primary entry on debug logs / panels that surface the array order.
  return Array.from(new Set([canonicalUrl, ...corsOrigins]));
}
