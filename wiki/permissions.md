# Permissions

**Summary**: v2.10 split the `permissions/` module into `core`, `scope`, `dynamic`. Public import path `@classytic/arc/permissions` is unchanged.
**Sources**: src/permissions/.
**Last updated**: 2026-07-28 (decision contract + AND-composed, kit-portable policy filters — 2.30).

---

## The decision contract (2.30)

A check returns `boolean | AuthorizationDecision` — pure data, never a mutation:

```ts
import { allow, deny, scopeOf } from "@classytic/arc/permissions";

const canRead: PermissionCheck = (ctx) =>
  isMember(scopeOf(ctx)) ? allow({ policy: { orgId: getOrgId(scopeOf(ctx)) } }) : deny("not a member");
```

- **PDP** `evaluatePermissionDecision(check, ctx)` — transport-neutral evaluation. No request needed, so MCP / jobs / websockets share it.
- **PEP** `applyAuthorizationDecision(decision, req)` — the ONE place a decision's effects land (`policy` → `_policyFilters`, `scope` → `request.scope`, never downgrading existing auth).

Read scope via `scopeOf(ctx)`, never `ctx.request` — that is what lets a combinator hand a child a new context instead of mutating the request, and what makes non-HTTP transports resolve identity.

`PermissionResult` / `normalizePermissionResult` were REMOVED in 2.30 → `AuthorizationDecision` / `normalizeToDecision`.

## Policy filters

Filters from independent sources (tenant preset, ownership grant, an `allOf` branch, a host check) compose with **logical AND** via `conjoinPolicyFilters`. A plain object spread is NOT AND — same key from two sources meant the later silently replaced the earlier, widening a restriction another layer imposed.

Arc emits a Mongo-style operator dialect (`$or`, `$in`, `$and`), normalized at the repository boundary so non-Mongo kits (SQLiteKit, PGKit) don't treat `$and` as a column name.

## Static analysis (no request)

`describePermission` / `describePermissionMap` / `explainAccess` / `collectPublicSurface` answer "who can do X" from metadata. `allow`/`deny` are definitive; `conditional` means the gate reads request-time state and must not be guessed. Use instead of hand-rolling a `/permissions/matrix` endpoint.

`runAuthorizationConformance` ([[testing]]) proves CRUD and aggregation enforce one permission identically.

## Ownership is fail-closed (2.30)

`ownedByUser` denies with no identity, and denies a record whose `ownerField` is empty (`missingOwner: "allow"` is a bounded legacy opt-in). **The default `ownerField` is `userId`** — a mismatched name makes every record look unowned. For "the owner, or an admin" use `requireOwnership(field, { bypassRoles: [...] })`; the middleware preset bypasses only for elevated platform scope.

## Layout (v2.10)

| File | Responsibility |
|---|---|
| `core.ts` | auth/role/ownership primitives + combinators: `allOf`, `anyOf`, `not`, `when`, `denyAll` |
| `scope.ts` | org/service/team/scope-context checks: `requireOrgMembership`, `requireOrgRole`, `requireServiceScope`, `requireScopeContext`, `requireOrgInScope`, `requireTeamMembership` |
| `dynamic.ts` | runtime permission matrices + cache + cross-node invalidation |
| `fields.ts` | field-level read/write permissions |
| `presets.ts` | pre-composed permission bundles |
| `roleHierarchy.ts` | role inheritance tree |

## Combinators

```ts
allOf(checkA, checkB)      // AND
anyOf(checkA, checkB)      // OR
not(check, reason?)        // inverts result (v2.10)
when(predicate, check)     // conditional
denyAll('reason')          // always 403
```

## Scope-aware helpers

| Helper | Applies to scope kinds | Purpose |
|---|---|---|
| `requireOrgMembership` | member, service, elevated | Any org-bound |
| `requireOrgRole` | member | Humans-only role check |
| `requireServiceScope` | service | Machine OAuth-style scopes |
| `requireScopeContext` | member, service, elevated | Custom dimensions (branchId etc.) |
| `requireOrgInScope` | member, service, elevated | Hierarchy (parent-child orgs) |
| `requireTeamMembership` | member | Team membership |

Full matrix: `docs/getting-started/permissions.mdx`.

## `requireGrant` — per-record grants / record sharing (2.22)

Subject × record × mode grants (verdict + recipe: `designs/record-sharing.md`). Arc ships the GATE only: `requireGrant({ mode, resolve, bypassRoles })` + the `GRANT_MODES` lattice (`see < list < read < write < manage`, held ≥ required via `modeSatisfies`). Grant STORAGE is a host `defineResource` (tenant-scoped, `audit: true` — DB-agnostic over `RepositoryLike`); `resolve` is structural. Resolutions: `boolean` | `{ mode }` (lattice-checked for single-record ops) | `{ filters }` (list-shaped — flows through `PermissionResult.filters` into the ONE list query; never per-item ACL walks). Fail-closed: resolver throw, empty resolution, and corrupted mode strings all deny. Anonymous callers reach the resolver by design (share links = a signed token referencing a grant ROW with `subjectType: 'link'` — revocable by deleting the row). Turnkey layer: **`@classytic/arc-shares`** (arc-ecosystem) — ShareStore port + adapter, createShares service, revocable HMAC share links, prebuilt permission sets (ownership folded into the resolver — see the package for why anyOf(requireOwnership, requireGrant) would short-circuit). Pinned by `tests/permissions/require-grant.test.ts`.

## CRUD public-by-omission (2.20)

An omitted CRUD permission mounts the route with **no gate** (unlike custom
routes/actions, which fail boot). Two 2.20 changes close the trap:

- `readOnly()` now returns explicit `denyAll` for create/update/delete — pre-2.20
  it left them undefined, i.e. **unauthenticated writes**.
- New boot diagnostic `crud-public-by-omission` (post-preset, reads
  `resolvedConfig`): `warn` when ungated WRITE ops mount, `info` when only reads
  are ungated (public catalogs / `referenceData`). Silence it by stating intent —
  `permissions.fullPublic()`, `permissions.authenticated()`, or per-op checks.
  Middleware-only presets (ownedByUser) do NOT count as gates: ownership checks
  no-op for anonymous callers.

## Field-write denial (v2.9)

Default: `onFieldWriteDenied: 'reject'` — `ForbiddenError` listing denied fields. Opt in to silent `strip` per resource. See [[core]] and [[gotchas]] #11.

## Stamp-from-scope vs validate-from-scope

A recurring request is "permission check that compares request body against the auth user" (xAPI actor IFI, `body.authorId`, `body.customerId`, etc.). Arc deliberately does NOT ship a body-vs-auth `PermissionCheck` helper because the abstraction is wrong: a `PermissionCheck` answers "can this caller do this action?", not "does this body shape match scope?". The arc-native answer is one of two existing primitives — pick by where the field structurally lives.

**Flat field on the document — use `fieldRules.systemManaged`.** The cleanest fix when the client should never set the field at all (orders, comments, posts, bookings). Strip the user-supplied value at the body sanitizer and stamp it from scope in a `beforeCreate` hook:

```ts
defineResource({
  name: 'comment',
  schemaOptions: {
    fieldRules: {
      authorId: { systemManaged: true },   // stripped from inbound body
    },
  },
  hooks: {
    beforeCreate: async (ctx) => {
      ctx.data.authorId = getUserId(ctx.user);
    },
  },
  permissions: { create: requireAuth() },
});
```

The server stamps. The client can't spoof — the field never reaches the DB from user input. With `onFieldWriteDenied: 'reject'` (default), attempts to write the field even fail loudly.

**Nested envelope (xAPI shape) — use `beforeCreate` to validate.** When the field lives inside a vendor-defined envelope (`statement.actor.account.name`) you can't strip without losing the envelope structure. Validate instead:

```ts
defineResource({
  name: 'statement',
  hooks: {
    beforeCreate: async (ctx) => {
      const authId = getUserId(ctx.user);
      const items = Array.isArray(ctx.data) ? ctx.data : [ctx.data];
      for (const [i, item] of items.entries()) {
        if (item.actor?.account?.name !== authId) {
          throw createDomainError(
            'ACTOR_MISMATCH',
            `statements[${i}]: actor ${item.actor?.account?.name} ≠ auth ${authId}`,
            403,
          );
        }
      }
    },
  },
  permissions: { create: requireAuth() },
});
```

Typed against the resource's `TDoc`, composes with other validations, fails with rich per-item context, no stringly-typed dot-paths.

**Why no `requireActorMatchesAuth()` helper:** a third path would overlap both of the above. `fieldRules` already gives flat-field stamping; `beforeCreate` already gives structural validation. Adding a permission helper that *looks* like an auth gate but actually does data validation is a category error — consumers reach for it when they should be stamping, or stamp + check when one would suffice. The framework's job is **fewer, deeper primitives that compose** — not a helper for every shape of user mistake.

**`requireOwnership` is read-side.** It checks the LOADED doc's owner field, used for `update` / `delete` / row-filter `list`. It does NOT inspect the inbound body and is not a substitute for stamping. See [[core]] for the body-sanitizer pipeline.

## Dynamic matrix

`permissions/dynamic.ts` computes permissions at runtime from a matrix config, with per-node cache and cross-node invalidation. Use when roles/permissions are DB-backed.

## `permissionMatrix` (2.21) — arbitrary-gate CRUD matrix

`permissionMatrix({ read, write, delete? }, overrides?)` maps `read` → list/get, `write` → create/update; `delete` defaults to `write`. Gates are any `PermissionCheck` (org roles, ownership, `anyOf`, async) — unlike the fixed role-based presets, it's the generalization every host and arc-* module hand-rolled as a 5-line `{ list: view, get: view, ... }` map. Composes with `overrides` like every other preset.

## Removed in v2.10
- `@classytic/arc/policies` — pluggable policy engine; `permissions/` covers every documented use case. See [[removed]].

## Related
- [[request-scope]] — input to every permission check
- [[auth]] — how scope gets populated
- [[core]] — where `BaseController` wires permissions in
