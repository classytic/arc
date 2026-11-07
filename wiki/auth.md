# Auth

**Summary**: `authPlugin` handles JWT via `@fastify/jwt`. Better Auth is an adapter. Sessions live in `sessionManager` with optional Redis backing. Revocation is fail-closed.
**Sources**: src/auth/.
**Last updated**: 2026-11-07.

---

## Modes

- **JWT** (default) — `authPlugin({ secret, ... })`. Verifies bearer tokens, populates `request.user` + `request.scope`.
- **Better Auth** — `betterAuth({ ... })` adapter. Handles cookie sessions, OAuth, email/password.
- **Custom** — implement auth via `PermissionResult.scope`. Used for API-key / service-to-service (installs `service` kind on [[request-scope]]).
- **None** — public routes; `request.user` is `undefined`. See [[gotchas]] #1.

## Better Auth catch-all route

`${basePath}/*` registers GET + POST plus every verb a routable `auth.api`
endpoint declares (`options.method`, skipping `metadata.SERVER_ONLY`, as
better-call's router does). Never `fastify.all()`: it exposed TRACE/QUERY and
tripped the CORS route-methods boot warning. OPTIONS belongs to `@fastify/cors`.

The Fetch `Request` URL uses `request.host` (keeps the port; BA infers baseURL
and a trusted origin from it when `baseURL` is unset). Arc overwrites
`x-arc-client-ip` (`BETTER_AUTH_CLIENT_IP_HEADER`) with `request.ip`, so a host
listing it in BA `advanced.ipAddress.ipAddressHeaders` gets per-client rate
limits that follow arc's `trustProxy`. Tests: `tests/auth/better-auth-routes.test.ts`.

## Better Auth sensitive-session routes (opt-in)

By default `authenticate` calls `auth.api.getSession` with the cookie cache
honored: a revoked session, or a user banned since, keeps passing arc routes
until the cache `maxAge` lapses. That is the default and stays so.

A sensitive route reads the session from the store instead, the same read as
BA's `sensitiveSessionMiddleware` (`getSession` with
`query: { disableCookieCache: true }`; skipped when BA has neither `database`
nor `secondaryStorage`, where the cookie is the session):

- `sensitivePaths: ['/admin', ...]` on `createBetterAuthAdapter`: prefixes of the
  REGISTERED route URL (`request.routeOptions.url`, so percent-encoding cannot
  dodge it), on `/` boundaries. `authenticate` itself does the store read.
- `requireSensitiveSession` (adapter result): preHandler after `authenticate`
  (route `preHandler`, resource `routeGuards`). Same `user` id required; skipped
  when the request already read authoritatively (a sensitive path, or a
  registered `credentials` verifier, which arc never caches).
- `requireFreshSession` (adapter result): Better Auth's `freshSessionMiddleware`. After
  `authenticate`, a session older than `session.freshAge` (default 1 day, read from
  `auth.options`; `0` disables) is a 403 "Session is not fresh"; no session (or a credential
  verifier) is a 401. Uses `session.createdAt` already on the request: no store read. It does
  not check the session still exists, so pair with `requireSensitiveSession` when both matter.

Refusals: no session in the store → 401 `arc.unauthorized`; admin-plugin ban
in force (`banned` and `banExpires` unset or future, BA's session-create rule)
→ 403 `arc.forbidden`. `optionalAuthenticate` on a sensitive path leaves such
callers public. BA's own ban revokes sessions (→ 401); the 403 covers a ban
written without revocation. With `secondaryStorage`, the user is the snapshot
stored with the session.

Cost per sensitive request: one store read (DB `findOne` joined with user, or
`secondaryStorage` session key + revocation marker). Bearer sessions and apps
without the cookie cache already read the store on every request, so
`sensitivePaths` adds nothing there and the preHandler adds a second read.

Not BA's `freshAge` ("fresh" = signed in recently, 403 `SESSION_NOT_FRESH`) nor
`sessionManager.requireFresh`; hence the name. Use on account and security
settings, admin, and money-moving routes. Tests:
`tests/auth/better-auth-sensitive-session.test.ts`.

## Social sign-in (`./auth/social`)

`defineSocialProviders({ enabled, env?, overrides? })` → `{ socialProviders, providers,
trustedOrigins }` from presets (google, github, apple, facebook). Explicit enable; missing
credentials throw naming each variable. Google's own provider only DECODES the code-exchange id
token, so the preset's `getUserInfo` verifies it with `verifyGoogleIdToken` (audience = every
client id incl. `GOOGLE_ID_TOKEN_AUDIENCES`), keeps `hd`, then applies `mapProfileToUser`.

`socialAuth({ providers? })` (BA plugin id `social`), contract shared with arc-next:
- `GET /social/providers` → `{ providers: [{ id, name }] }` from `ctx.context.socialProviders`.
- after `/callback/:id`: only with `ctx.context.newSession`, an absolute http(s) `location`
  passing `isTrustedOrigin`, and `getOAuthState().handoff` (43-char base64url SHA-256). Stores
  `{ sessionToken, challenge }` as a verification value `social-handoff:<sha256(code)>`, 60 s,
  and appends `#handoff=<code>` (`&` when a fragment exists; query untouched).
- `POST /social/handoff { code, verifier }`: `consumeVerificationValue` (atomic) BEFORE the
  verifier check, so a wrong guess burns the code; session re-read; `{ token, user }` +
  `set-auth-token` (signed, as `bearer()` emits) when bearer is installed. Every refusal 400
  `HANDOFF_INVALID`. Plugin `rateLimit` 10/min.
- before `/one-tap/callback`: a sent `nonce` must match the id token's (400
  `ONE_TAP_NONCE_MISMATCH`); BA drops it otherwise.

Order: before any plugin stripping the session Set-Cookie or rewriting the redirect. DB-agnostic:
only `internalAdapter`. Tests: `tests/auth/social/`.

## Better Auth organization and team scope

With `orgContext: true`, the adapter derives member scope from Better Auth's
membership APIs. An explicit `x-organization-id` selects the request's store;
the session's active organization is the fallback when the header is absent.
Roles are resolved for the selected organization; the session's active-member
roles are reused only when it is the same organization. An active team is
exposed as `request.scope.teamId` only when it belongs to the selected organization. Both
`authenticate` and `optionalAuthenticate` use this same validation; stale,
missing, or cross-organization team state is omitted rather than trusted.

Arc owns this request-scope projection. Better Auth schema and plugin setup stay
in the host or its auth composition package, while database adapters remain
storage-only.

## `isRevoked` is fail-closed

If the `isRevoked` callback throws, token is **treated as revoked** (access denied). Security design: errors block, never grant. See [[gotchas]] #4.

Tests: `tests/auth/token-revocation.test.ts` + `tests/security/`.

## Sessions

- `sessionManager` — in-memory sessions by default.
- `createRedisSessionStore(ioredis)` — Redis-backed, recommended for multi-node.
- Session ownership validation: every session-op must check it belongs to the requesting user. See [[security]].

## Webhook signature verification

`verifySignature(body, secret, signature)` throws `TypeError` if body isn't string/Buffer. Pass `req.rawBody`, never parsed `req.body`. Register `@fastify/raw-body` before webhook routes. See [[gotchas]] #14.

## Related
- [[request-scope]] — how auth populates scope
- [[permissions]] — consumes scope
- [[security]] — checklist when touching auth
