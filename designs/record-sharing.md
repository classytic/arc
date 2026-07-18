# Design verdict: record sharing (per-record grants + share links)

**Status**: FULLY SHIPPED (2026-07-15). Two layers:
- **arc 2.22 core**: `requireGrant({ mode, resolve, bypassRoles })` + `GRANT_MODES`
  lattice + `modeSatisfies` (`src/permissions/grants.ts`, pinned by
  `tests/permissions/require-grant.test.ts`).
- **`@classytic/arc-shares` 0.1.0** (arc-ecosystem): the turnkey layer — `ShareStore`
  4-method equality-only port + `shareStoreFromRepository` feature-detecting adapter,
  `createShares` service (replace-on-grant, lattice-strongest modeFor, expiry
  fail-closed), revocable HMAC share links (token references a grant ROW), and
  `shares.permissions({ ownerField })` prebuilt CRUD sets. Ownership is folded INTO
  the resolver (owner fallback = `manage` + owner-filter), NOT `anyOf(requireOwnership,
  requireGrant)` — ownership checks always grant via filters, so anyOf would
  short-circuit before the grant branch (caught by the integration test). Read-side
  checks are `_isPublic`-marked when links are enabled so anonymous link callers reach
  the fail-closed resolver instead of route-level 401.
Storage stays host-owned per the original verdict.
Grounded against Puter's actual implementation (agent-audited): typed modes vs
their unvalidated permission strings; query-level `filters` vs their unfiltered
readdir + N+1 stat calls; fail-closed resolution; share links must reference a
grant ROW (revocable), never a self-contained capability token.

## Context

Puter's file layer has the one ACL idea arc's permission system lacks: per-record
grants — subject × record × mode (`see < list < read < write < manage`), plus public
share-link tokens. Arc already covers roles/scopes/ownership/row-filters
(`requireOwnership`, permission-result `filters`, `createDynamicPermissionMatrix`).

## The decision (bottleneck test)

| Shape | Verdict |
|---|---|
| `@classytic/arc-shares` package | REJECTED — fragmentation: a versioned package + store contract for ~40 lines of gate logic |
| Core sharing subsystem (grants storage, link routes) | REJECTED — core bloat + DB coupling; core ships vocabulary, never storage |
| **`requireGrant({ resolve, mode })` combinator in `@classytic/arc/permissions`** | ACCEPTED, **deferred until the first host consumer** — same tier as `requireOwnership`; structural `resolve` so arc ships zero storage |

Sketch when the day comes:

```ts
// Host owns the grants table — it's just a resource (tenant-scoped, audit: true).
// Core adds only the gate + the mode lattice:
requireGrant({
  mode: 'read',                                  // see < list < read < write < manage
  resolve: (ctx) => grants.lookup(ctx),          // host repo; may return boolean OR filters
})
// Share links = the same check fed by a signed token claim instead of a session.
```

- List routes scope for free — permission results already carry `filters`
  (`{ $or: [{ ownerId }, { _id: { $in: grantedIds } }] }`).
- DB-agnosticism holds by construction: the grants table is a host
  `defineResource` over repo-core's `RepositoryLike` (any kit), and the
  `resolve` callback is structural — arc never touches grant storage. If a
  canonical grants contract ever proves necessary, its home is
  `@classytic/repo-core` (the `LockAdapter` / `usage` precedent), with arc
  mirroring it structurally so the peer floor never bumps.
- Until then, hosts express the identical check as a plain `PermissionCheck`
  function — nothing is blocked; that first hand-rolled host is also where the
  combinator's real requirements get discovered (the arc-approval birth path).

## Related verdicts

- `designs/custom-fields.md` — same composition-test reasoning (recipe over package).
- Client SDK: already exists — `@classytic/arc-next` (React + TanStack Query). No
  `arc-client`; the improvement path is a wire-type export convention for arc-*
  modules so kernel → API → frontend is one type flow.
