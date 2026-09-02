# Auth

**Summary**: `authPlugin` handles JWT via `@fastify/jwt`. Better Auth is an adapter. Sessions live in `sessionManager` with optional Redis backing. Revocation is fail-closed.
**Sources**: src/auth/.
**Last updated**: 2026-09-02.

---

## Modes

- **JWT** (default) — `authPlugin({ secret, ... })`. Verifies bearer tokens, populates `request.user` + `request.scope`.
- **Better Auth** — `betterAuth({ ... })` adapter. Handles cookie sessions, OAuth, email/password.
- **Custom** — implement auth via `PermissionResult.scope`. Used for API-key / service-to-service (installs `service` kind on [[request-scope]]).
- **None** — public routes; `request.user` is `undefined`. See [[gotchas]] #1.

## Better Auth organization and team scope

With `orgContext: true`, the adapter derives member scope from Better Auth's
active organization and membership APIs. An active team is exposed as
`request.scope.teamId` only when it belongs to that active organization. Both
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
