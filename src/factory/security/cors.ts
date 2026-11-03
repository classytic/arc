/**
 * CORS policy resolution — arc's opinions about a host's CORS config,
 * expressed as a pure function so every rule is unit-testable without a
 * Fastify instance.
 *
 * Six policies live here:
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
 *   6. `methods` defaults to the verbs arc's routes register (unreleased,
 *      after 2.48) instead of `@fastify/cors`'s `GET,HEAD,POST`, but only
 *      for an explicit origin allow-list; `origin: true` / a function with
 *      `credentials: true` keeps the narrow list and warns. Whatever the
 *      resolved list, registerSecurity warns at `onReady` when registered
 *      routes use a verb it omits (`corsMissingRouteMethods`).
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

/**
 * `Access-Control-Allow-Methods` when the host's `cors` object names none:
 * the verbs arc's own routes register (CRUD `PUT`/`PATCH`/`DELETE` included),
 * the same list the production and development presets carry. `@fastify/cors`
 * alone allows only `GET,HEAD,POST`, so a host `cors` object (which replaces the
 * preset's) silently broke every cross-origin update and delete.
 */
const ARC_DEFAULT_CORS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** `@fastify/cors`'s own `methods` default, answered when `options.methods` is unset. */
const FASTIFY_CORS_DEFAULT_METHODS = ["GET", "HEAD", "POST"];

/**
 * CORS-safelisted methods: browsers never check them against
 * `Access-Control-Allow-Methods`, so a route on one of these verbs cannot
 * fail its preflight for want of the verb. `OPTIONS` is the preflight itself.
 */
const PREFLIGHT_EXEMPT_METHODS = new Set(["GET", "HEAD", "POST", "OPTIONS"]);

export interface CorsResolution {
  /** The options object to hand to `@fastify/cors`. */
  options: Record<string, unknown>;
  /** Config-quality warnings for the caller to log (order preserved). */
  warnings: string[];
  /**
   * True when `warnings` already explains a narrow `methods` default (reflecting
   * origin with credentials). The route-aware check in registerSecurity skips
   * its own warning then, so the host sees one message, not two.
   */
  methodsWarned?: boolean;
}

/**
 * The verbs registered routes use that the resolved CORS `methods` do not allow
 * (sorted, upper case). Safelisted verbs never count. Feeds the boot warning
 * for cross-origin PUT/PATCH/DELETE that would fail their preflight silently.
 */
export function corsMissingRouteMethods(
  options: Record<string, unknown>,
  routeMethods: Iterable<string>,
): string[] {
  const declared = options.methods;
  const allowed = new Set(
    (Array.isArray(declared)
      ? (declared as string[])
      : typeof declared === "string"
        ? declared.split(",")
        : FASTIFY_CORS_DEFAULT_METHODS
    ).map((m) => m.trim().toUpperCase()),
  );
  const missing = new Set<string>();
  for (const method of routeMethods) {
    const verb = method.toUpperCase();
    if (!PREFLIGHT_EXEMPT_METHODS.has(verb) && !allowed.has(verb)) missing.add(verb);
  }
  return [...missing].sort();
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
  let methodsWarned = false;

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

  // Smart CORS: allow the verbs arc's routes answer when the host named no
  // `methods`. A declared list (string or array) is kept as is. Only an
  // explicit origin allow-list (string, array, RegExp) gets the widened list:
  // `origin: true` or a function reflects origins arc cannot see, and with
  // `credentials: true` the wider list would let any website send credentialed
  // updates and deletes. Those keep @fastify/cors's `GET,HEAD,POST`.
  if (corsOptions.methods === undefined) {
    const origin = corsOptions.origin;
    const explicitAllowList =
      typeof origin === "string" || Array.isArray(origin) || origin instanceof RegExp;
    if (explicitAllowList) {
      corsOptions.methods = [...ARC_DEFAULT_CORS_METHODS];
    } else if (
      corsOptions.credentials === true &&
      (origin === true || typeof origin === "function")
    ) {
      warnings.push(
        "CORS `origin` reflects any origin (true or a function) with `credentials: true` and names no `methods`: " +
          "arc keeps @fastify/cors's GET,HEAD,POST, so cross-origin PUT/PATCH/DELETE fail their preflight. " +
          "Set cors.origin to an explicit allow-list (arc then allows its route verbs), or declare cors.methods " +
          "yourself if the origin function already restricts origins.",
      );
      methodsWarned = true;
    }
  }

  // Smart CORS: cache the preflight unless the host opted out or set a
  // value. `maxAge: 0` is respected (explicit no-cache).
  if (corsOptions.maxAge === undefined) {
    corsOptions.maxAge = DEFAULT_CORS_MAX_AGE;
  }

  return { options: corsOptions, warnings, methodsWarned };
}
