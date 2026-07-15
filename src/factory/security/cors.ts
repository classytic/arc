/**
 * CORS policy resolution — arc's opinions about a host's CORS config,
 * expressed as a pure function so every rule is unit-testable without a
 * Fastify instance.
 *
 * Five policies live here:
 *   1. Production without a declared origin → warning (catches the
 *      env-var-undefined trap).
 *   2. `origin: '*'` + `credentials: true` → boot-time THROW (the browser
 *      wildcard ban exists to prevent credentialed cross-origin reads;
 *      pre-2.22 arc silently rewrote this to reflect-any-origin, which
 *      reintroduced the vulnerability).
 *   3. Host-declared `allowedHeaders` allow-lists get ARC'S OWN protocol
 *      headers merged in (2.22) — forgetting `x-organization-id` /
 *      `x-arc-scope` / `x-request-id` made webview clients fail preflight
 *      silently.
 *   4. `exposedHeaders` ALWAYS gains arc's auth response headers
 *      (`set-auth-token`) — unlike allowedHeaders, an unset exposedHeaders
 *      exposes NOTHING, so the list is created when absent.
 *   5. Preflight caching: `maxAge` defaults to 24h when unset (`0` is
 *      respected as explicit no-cache).
 *
 * The returned options NEVER alias the host's arrays — merging into an
 * aliased `allowedHeaders`/`exposedHeaders` would mutate the caller's
 * config object across createApp calls.
 */

import type { CreateAppOptions } from "../types/index.js";

/**
 * Headers ARC ITSELF reads from cross-origin requests. Auto-merged into a
 * host-declared CORS `allowedHeaders` allow-list (2.22) so hosts never
 * enumerate framework internals. Lowercase — header names are
 * case-insensitive and @fastify/cors joins them verbatim.
 */
const ARC_PROTOCOL_HEADERS = ["x-organization-id", "x-arc-scope", "x-request-id"] as const;

/**
 * Response headers ARC'S OWN auth protocol emits that cross-origin JS MUST
 * be able to read. Better Auth's bearer plugin returns the session token in
 * `set-auth-token` — without exposing it, cross-origin clients (Capacitor /
 * Ionic WebViews at `https://localhost`, cross-domain SPAs) complete the
 * login POST but can never READ the token, so bearer auth silently dies
 * (login appears to succeed, then every request is unauthenticated).
 * Unlike `allowedHeaders`, an UNSET `exposedHeaders` is NOT safe — CORS
 * exposes nothing beyond the safelist by default — so this is always
 * merged, creating the list when the host declared none.
 */
const ARC_EXPOSED_HEADERS = ["set-auth-token"] as const;

/**
 * Default `Access-Control-Max-Age` (seconds) when the host didn't set one.
 * Arc's CORS method/header lists are static per deploy, so letting browsers
 * cache the preflight kills the extra OPTIONS round-trip on every request —
 * on high-latency links (mobile webviews) that's a visible chunk of every
 * API call. Browsers clamp internally (Chromium 2h, Firefox 24h).
 */
const DEFAULT_CORS_MAX_AGE = 86_400;

export interface CorsResolution {
  /** The options object to hand to `@fastify/cors`. */
  options: Record<string, unknown>;
  /** Config-quality warnings for the caller to log (order preserved). */
  warnings: string[];
}

/**
 * Resolve the host's CORS config into `@fastify/cors` options + warnings.
 * Throws on the one configuration arc refuses to ship (see module header).
 * Callers decide only HOW to surface warnings — the policy is all here.
 */
export function resolveCorsOptions(
  config: Pick<CreateAppOptions, "cors" | "preset">,
): CorsResolution {
  const corsOptions = { ...(config.cors ?? {}) } as Record<string, unknown>;
  const warnings: string[] = [];

  // Production CORS warning — also catches the env-derived `undefined`
  // hazard. The canonical README pattern was
  //   `cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') }`
  // which evaluates to `{ origin: undefined }` when the env var is unset
  // — `'origin' in corsOptions` would be `true`, so the pre-2.11.3 check
  // skipped the warning and `@fastify/cors` quietly fell back to its
  // default (no Access-Control-Allow-Origin header set), which behaves
  // differently across browsers and looks like silent CORS misconfig.
  // Treat `origin: undefined` the same as missing.
  const originDeclared = "origin" in corsOptions && corsOptions.origin !== undefined;
  if (config.preset === "production" && !originDeclared) {
    warnings.push(
      "CORS origin is not explicitly configured in production. " +
        "Browser apps: set cors.origin to allowed domains (e.g. ['https://app.example.com']) " +
        "with credentials: true. Server-to-server / API-key services: " +
        "cors: { origin: '*', credentials: false } OR cors: false to disable. " +
        "Tip: when wiring cors.origin from an env var, fail fast on missing " +
        "(`if (!process.env.ALLOWED_ORIGINS) throw ...`) instead of letting " +
        "`undefined` slip through.",
    );
  }

  // origin:'*' + credentials is a config error — fail fast at boot.
  // Browsers reject `Access-Control-Allow-Origin: *` with credentials
  // precisely to stop credentialed cross-origin reads from arbitrary
  // sites. Pre-2.22 arc "fixed" the combo by rewriting to `origin: true`
  // (reflect any Origin), which silently reintroduced the vulnerability
  // the wildcard ban exists to prevent. Never auto-weaken security to
  // make a config work.
  if (corsOptions.credentials === true && corsOptions.origin === "*") {
    throw new Error(
      "[Arc] cors: `origin: '*'` cannot be combined with `credentials: true`.\n" +
        "Reflecting arbitrary origins with credentials lets any website read " +
        "authenticated responses (CSRF-adjacent data theft).\n" +
        "Fix one of:\n" +
        "  • cors: { origin: ['https://app.example.com'], credentials: true }  — explicit allow-list\n" +
        "  • cors: { origin: /\\.example\\.com$/, credentials: true }            — pattern allow-list\n" +
        "  • cors: { origin: '*', credentials: false }                         — public, uncredentialed API",
    );
  }

  // Smart CORS (2.22): hosts that declare an `allowedHeaders` allow-list
  // shouldn't have to recite ARC'S OWN protocol headers — forgetting
  // `x-organization-id` (tenant context), `x-arc-scope` (elevation), or
  // `x-request-id` (correlation) makes cross-origin/webview clients
  // (Capacitor, Ionic, browser SPAs) fail silently on preflight. Arc
  // knows its own header names; merge them in. No-op when the host
  // leaves `allowedHeaders` unset (@fastify/cors then reflects
  // `access-control-request-headers` — no allow-list, no trap).
  // COPY the host's array — corsOptions is a shallow copy of config.cors,
  // so pushing into the aliased array would mutate the caller's config.
  if (Array.isArray(corsOptions.allowedHeaders)) {
    const allowed = [...(corsOptions.allowedHeaders as string[])];
    const declared = new Set(allowed.map((h) => h.toLowerCase()));
    for (const arcHeader of ARC_PROTOCOL_HEADERS) {
      if (!declared.has(arcHeader)) {
        allowed.push(arcHeader);
      }
    }
    corsOptions.allowedHeaders = allowed;
  }

  // Smart CORS: response headers arc's auth protocol emits are always
  // exposed (see ARC_EXPOSED_HEADERS — unset `exposedHeaders` exposes
  // NOTHING, so unlike allowedHeaders this must create the list). Same
  // copy rule as above; the string form is normalized to an array.
  {
    const exposed = Array.isArray(corsOptions.exposedHeaders)
      ? [...(corsOptions.exposedHeaders as string[])]
      : typeof corsOptions.exposedHeaders === "string"
        ? (corsOptions.exposedHeaders as string).split(",").map((h) => h.trim())
        : [];
    const declared = new Set(exposed.map((h) => h.toLowerCase()));
    for (const arcHeader of ARC_EXPOSED_HEADERS) {
      if (!declared.has(arcHeader)) exposed.push(arcHeader);
    }
    corsOptions.exposedHeaders = exposed;
  }

  // Smart CORS: cache the preflight unless the host opted out or set a
  // value. `maxAge: 0` is respected (explicit no-cache).
  if (corsOptions.maxAge === undefined) {
    corsOptions.maxAge = DEFAULT_CORS_MAX_AGE;
  }

  return { options: corsOptions, warnings };
}
