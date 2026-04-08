# Changelog

## 2.7.1

### Correctness — `allOf()` now plumbs scope between children

`allOf()` previously evaluated each child against the **original** request
context. A child returning `{ granted: true, scope: ... }` had its scope
silently dropped, AND the next child still saw the pre-existing scope. This
broke documented composition patterns for custom auth like:

```typescript
permissions: {
  list: allOf(requireApiKey(), customScopeCheck()),
}
```

Pre-fix: `customScopeCheck()` saw `public` scope because `requireApiKey()`'s
service scope was never installed before the next child ran.

Post-fix `allOf()`:

1. **Installs each granted child's `scope`** on `request.scope` before invoking
   the next child (mirrors how `applyPermissionResult` works between separate
   permission checks). Honors the "no downgrade" rule — won't overwrite an
   already-installed `member` or `elevated` scope with a `service` scope.
2. **Applies each granted child's `filters`** to `request._policyFilters` in
   real time so subsequent children see accumulated row-level scoping.
3. **Returns the merged `scope`** on the final `PermissionResult` so the outer
   middleware (`applyPermissionResult`) sees the same end-state.
4. **Restores request state on denial** — if a later child denies, the
   request's `_policyFilters` and `scope` are rolled back to their pre-`allOf`
   values, so partial runs leave no leaked side effects. Same rollback applies
   when a child throws.

`anyOf()` is unaffected — it already short-circuits on first success without
mutating the request.

### Permission system: service scope (API key) recognition + `requireServiceScope`

The `service` scope variant existed in `RequestScope` since the scope refactor,
but **no built-in helper recognized it for org isolation** — meaning the
documented `allOf(requireApiKey(), requireOrgMembership())` pattern silently
denied API key calls. This release closes that gap with three small fixes
plus one new helper.

**`requireOrgMembership()` now grants service scopes** ([src/permissions/index.ts:626](src/permissions/index.ts#L626)).
Any scope kind with org-access semantics — `member`, `service`, or `elevated` —
passes the check. The implementation now uses the existing `hasOrgAccess()`
helper from `src/scope/types.ts` instead of `isMember || isElevated`. The type
system guarantees `member` and `service` carry an `organizationId`;
`elevated`-without-org remains the documented cross-org admin bypass.

**`multiTenantPreset` filter and injection now recognize service scopes**
([src/presets/multiTenant.ts](src/presets/multiTenant.ts)). Both the strict
and flexible (`allowPublic`) filter variants apply the tenant filter for
service scopes bound to an org. The injection middleware writes
`organizationId` (or your custom `tenantField`) into the request body. API
keys with org context now get the same row-level isolation as human members
— no per-route bypasses, no leaks.

**`requireOrgRole()` explicitly denies service scopes** with a guidance reason
([src/permissions/index.ts:691](src/permissions/index.ts#L691)). Services
have OAuth-style `scopes` strings, not user-style `orgRoles` — implicit "API
key bypasses role checks" is the kind of footgun that ships data breaches.
Services must opt into specific scopes the same way OAuth clients do. The
denial message points at `requireServiceScope(...)` and the `anyOf`
composition pattern, so the developer knows exactly how to fix it.

**New: `requireServiceScope('jobs:write')`** ([src/permissions/index.ts:781](src/permissions/index.ts#L781)).
Mirrors how OAuth 2.0 / Better Auth's apiKey plugin / API gateways express
machine permissions. Variadic + array forms (matching `requireRoles` /
`requireOrgRole`). Elevated bypass. Throws at construction if no scopes
provided (catches typos at startup, not at request time).

```typescript
import {
  allOf, anyOf,
  requireOrgMembership, requireOrgRole, requireServiceScope,
} from '@classytic/arc/permissions';

// Routes that accept BOTH human admins AND API keys
permissions: {
  create: anyOf(
    requireOrgRole('admin'),                       // human path
    requireServiceScope('jobs:write'),             // machine path
  ),
}

// Routes that require both org membership AND a specific OAuth scope
permissions: {
  list:   allOf(requireOrgMembership(), requireServiceScope('jobs:read')),
  create: allOf(requireOrgMembership(), requireServiceScope('jobs:write')),
}
```

**Coverage**: 27 unit tests in `tests/permissions/service-scope.test.ts` +
13 behavioral middleware tests in `tests/presets/multi-tenant-service-scope.test.ts`.
Full regression sweep across 40 test files (permissions, presets, scope, auth,
e2e RBAC, smoke) — 501/501 passing. Zero existing tests had to change.

**Migration**: forward-compatible. If you were relying on
`requireOrgMembership()` *denying* service scopes deliberately, add an
explicit `when((ctx) => !isService(getScope(ctx.request)))` guard. If you
were composing custom checks to work around the gap, those still work and
you can simplify them.

### Multi-level tenancy: `scope.context` + `requireScopeContext` + multi-field `multiTenantPreset`

Real-world tenancy is rarely just `organizationId`. Common shapes need a
second or third dimension — branches under a company, projects within a team,
data residency by region, per-workspace isolation. Pre-2.7.1 these required
custom middleware reading `request.user.branchId` and merging into
`_policyFilters` by hand. 2.7.1 adds three coordinated primitives that
together let arc express any of these patterns natively.

**1. New `scope.context` slot** — `member`, `service`, and `elevated` scope
variants gained an optional `context?: Readonly<Record<string, string>>`
field for app-defined dimensions. Arc takes no position on what keys you
use (`branchId`, `projectId`, `region`, `workspaceId`, etc.) — your auth
function populates it from JWT claims, BA session fields, or request headers.

```typescript
type RequestScope =
  | { kind: 'member';   ...; context?: Readonly<Record<string, string>> }
  | { kind: 'service';  ...; context?: Readonly<Record<string, string>> }
  | { kind: 'elevated'; ...; context?: Readonly<Record<string, string>> }
  // ...
```

**2. New scope accessors** — `getScopeContext(scope, key)` and
`getScopeContextMap(scope)` from `@classytic/arc/scope`. Both return
`undefined` for kinds that don't carry context (`public`, `authenticated`).

**3. New `requireScopeContext(...)` permission helper** with three call shapes:

```typescript
// Presence-only — key must exist on scope.context (any value)
requireScopeContext('branchId')

// Exact value match
requireScopeContext('region', 'eu')

// Object form — multi-key AND semantics
requireScopeContext({ branchId: 'eng-paris', projectId: 'p-1' })

// Object form with mixed semantics
// (undefined = presence-only for that key, string = value match)
requireScopeContext({ branchId: undefined, region: 'eu' })
```

Elevated bypass — platform admins always pass regardless of which dimensions
they have set. Throws at construction if no keys are provided (catches typos
at startup, not at request time).

**4. `multiTenantPreset` now supports `tenantFields[]` for multi-dimension
filtering** — the same preset that handles single-org isolation now scales
to lockstep filtering across any number of dimensions:

```typescript
import { multiTenantPreset } from '@classytic/arc/presets';

// Single-field form (unchanged, still works)
multiTenantPreset({ tenantField: 'organizationId' })

// Multi-field form (new in 2.7.1)
multiTenantPreset({
  tenantFields: [
    { field: 'organizationId', type: 'org' },                // → getOrgId(scope)
    { field: 'teamId',         type: 'team' },               // → getTeamId(scope)
    { field: 'branchId',       contextKey: 'branchId' },     // → getScopeContext(scope, 'branchId')
    { field: 'projectId',      contextKey: 'projectId' },
  ],
})
```

`TenantFieldSpec` is a discriminated union — `{ field, type: 'org' }`,
`{ field, type: 'team' }`, or `{ field, contextKey: '...' }`. No string DSL,
no parsing — fully type-safe.

**Semantics:**
- **Filter (list/get/update/delete)**: walks every spec, applies all that
  resolve. **Fails closed** for non-elevated callers if any required dimension
  is missing — returns 403 with a `missing: <field-name>` reason so the
  developer can fix the auth bridge. Elevated scopes apply whatever resolves
  and skip the rest (cross-context admin bypass).
- **Injection (create)**: walks every spec, writes all values into the
  request body. Fails closed on any missing dimension to prevent partial-
  context API keys from creating cross-tenant rows.
- **Mutual exclusion**: `tenantField` and `tenantFields` cannot both be set.
  Empty `tenantFields: []` throws at preset construction.
- **Backwards compatible**: existing single-field configs work untouched —
  internally normalized to a one-element spec list.

**Real-world scenarios now expressible natively** (the four use cases the
audit flagged as workarounds-only or blocked):

| Scenario | How |
|---|---|
| Multi-tenant SaaS with org isolation | `multiTenantPreset({ tenantField: 'organizationId' })` (unchanged) |
| Single org with multiple branches | `tenantFields: [{ field: 'organizationId', type: 'org' }, { field: 'branchId', contextKey: 'branchId' }]` |
| Multi-team within an org | `tenantFields: [{ field: 'organizationId', type: 'org' }, { field: 'teamId', type: 'team' }]` |
| Multi-project within a team | Add `{ field: 'projectId', contextKey: 'projectId' }` to the team config |
| Multi-region with sticky data residency | `requireScopeContext('region', 'eu')` + tenant filter on `region` |
| Postman-style fan-out (user → many workspaces → many teams → many projects) | BA org plugin (workspace) + BA team plugin (team) + `context.projectId` from your auth bridge |
| API key bound to one branch (data residency) | Service scope with `context.branchId` set, multi-field preset enforces it |

**Tests**: 28 unit tests in `tests/permissions/scope-context.test.ts` covering
all three call shapes, all three context-bearing scope kinds, elevated
bypass, construction errors, and four real-world scenario walkthroughs. 19
behavioral middleware tests in `tests/presets/multi-tenant-multi-field.test.ts`
covering strict + flexible filters, member + service + elevated paths, full
injection flow, `type: 'team'` source, mutual-exclusion validation, and the
allowPublic flexible variant. **Full regression sweep: 548 / 548** across 42
test files (was 501 / 40 before Gap 2).

**Migration**: forward-compatible. Existing `multiTenantPreset({ tenantField })`
calls work unchanged. To add a second dimension, switch to the `tenantFields`
form. To populate `scope.context` from your existing auth setup, do it in
your auth function or adapter — arc doesn't hardcode any specific dimension
or transport, so you decide whether to read it from headers
(`x-branch-id`), JWT claims, or BA session fields.

### Parent-child org hierarchy: `ancestorOrgIds` + `requireOrgInScope`

Real-world enterprise setups need parent-child organization relationships
that arc didn't model directly: holding company → subsidiary → branch, MSP
managing many tenant orgs, white-label resellers with super-admin access
across all child accounts. Pre-2.7.1 these required custom permission checks
that read from `request.user.parentOrgs` and rolled their own predicates.

2.7.1 adds the smallest useful slice — explicit, no automatic inheritance,
extensible later without API breaks.

**1. New `ancestorOrgIds?: readonly string[]` field** on `member`/`service`/
`elevated` scope variants. Ordered closest-first (immediate parent → root).
Arc takes no position on the source — your auth function loads the chain
from your own org table during sign-in or middleware. Empty/absent = caller
has no parent orgs (the common case).

**2. New scope accessors** from `@classytic/arc/scope`:

- `getAncestorOrgIds(scope): readonly string[]` — always returns an array,
  empty for kinds without org context
- `isOrgInScope(scope, targetOrgId): boolean` — pure predicate, true if
  target equals current org OR appears in `ancestorOrgIds`. **No elevated
  bypass at this level** — it's a data query, not a permission check.

**3. New `requireOrgInScope` permission helper** with two call shapes:

```typescript
import { requireOrgInScope } from '@classytic/arc';

// Static target — rare, used when one route only ever acts on one org
permissions: {
  list: requireOrgInScope('acme-holding'),
}

// Dynamic target — extracted from request params/body/headers per call
permissions: {
  // GET /orgs/:orgId/jobs — caller can act on any org in their hierarchy chain
  list: requireOrgInScope((ctx) => ctx.request.params.orgId),

  // POST /jobs with { organizationId: 'org-eu' } in body
  create: allOf(
    requireOrgInScope((ctx) => ctx.request.body?.organizationId),
    requireOrgRole('admin'),
  ),
}
```

Pass behavior:
- Target equals `scope.organizationId` → grant
- Target appears in `scope.ancestorOrgIds` → grant
- `elevated` scope → grant unconditionally (cross-org admin bypass)
- Target undefined (extractor returned nothing) → deny with reason
- Anything else → deny with target name in reason

**Design decisions** (locked in by tests):

- **No automatic inheritance**. Every check is explicit. `multiTenantPreset`
  does NOT auto-include ancestor data — that would be a footgun for the
  common single-tenant case.
- **Pure predicate stays pure**. `isOrgInScope` doesn't have an elevated
  bypass; that's reserved for the permission helper. This keeps it composable
  inside custom checks without surprising callers.
- **Materialized chain, not graph traversal**. The chain is pre-loaded by
  your auth function — arc never walks a parent-child graph at request
  time. Lookups are O(chain length), not O(graph depth).
- **App owns the model**. Arc takes no position on whether your hierarchy
  is single-tree, multi-tree, or graph-shaped. You load whatever ancestors
  the caller can reach into the array; the helpers do the rest.

**Real-world scenarios now expressible natively**:

| Scenario | How |
|---|---|
| Holding company → subsidiary → branch | Auth loads `[parent, grandparent, ...]` into `ancestorOrgIds`; `requireOrgInScope` accepts any of them |
| MSP managing 50 customer tenants | Auth loads all 50 tenant ids into `ancestorOrgIds`; dynamic `requireOrgInScope((ctx) => ctx.request.params.tenantId)` gates routes |
| White-label SaaS where reseller super-admin can act on any child account | Same as MSP — load child account ids into the chain |
| Sibling subsidiaries should NOT see each other's data | Each user only loads ancestors of their own org; siblings naturally aren't in the chain |

**Tests**: 27 unit tests in `tests/permissions/org-hierarchy.test.ts` covering
the accessor, the predicate (all 4 scope kinds, target absent/null/missing,
no elevated bypass at predicate level), the permission helper (static +
dynamic targets, all scope kinds, elevated bypass, extractor returning
undefined), and two real-world scenario walkthroughs (holding company,
50-tenant MSP). Written test-first (RED → GREEN in one cycle, no debugging
needed). **Full regression sweep: 575 / 575** across 43 test files (was
548 / 42 before Gap 4).

**Migration**: pure addition. Existing scope objects without `ancestorOrgIds`
keep working exactly as before. Opt in by populating the field in your auth
function and adding `requireOrgInScope` to the routes that need it.

**What's NOT shipped (and intentionally so)**:

- **Automatic permission inheritance via `multiTenantPreset`**. We considered
  a `includeAncestors: true` option that would auto-extend the row-level
  filter to `{ $in: [currentOrg, ...ancestors] }`, but punted because it
  has security implications: a careless auth function that loads too many
  ancestors silently widens query scope across the whole resource. Apps
  that need this can do it explicitly via a custom middleware that reads
  `getAncestorOrgIds(scope)` and merges into `_policyFilters`.
- **Graph traversal at request time**. If your hierarchy is too deep to
  pre-load on auth (>1000 entries, dynamic membership), keep your existing
  custom check — arc isn't trying to be a graph database. The current
  primitive covers the typical 2–10 level hierarchies real apps actually use.
- **Parent role inheritance** (admin of parent → admin of child). That's a
  permission policy, not a data shape. Compose it with `anyOf`:
  ```typescript
  permissions: {
    childAdmin: anyOf(
      requireOrgRole('admin'),                                          // direct admin
      allOf(requireOrgInScope((c) => c.request.params.orgId),          // parent admin
            requireOrgRole('admin')),
    ),
  }
  ```

### Polish — first-class metadata, JSDoc fix, docs refresh

A code review surfaced three small gaps between the new permission helpers
and their public surfaces. Addressed:

**`PermissionCheckMeta` is now first-class for the new helpers**
([src/permissions/types.ts:168](src/permissions/types.ts#L168)). Three new
fields added to the typed metadata interface so introspection / OpenAPI /
MCP tooling can read them off the typed surface instead of guessing:

```typescript
interface PermissionCheckMeta {
  // existing
  _isPublic?: boolean;
  _roles?: readonly string[];
  _orgPermission?: string;
  _orgRoles?: readonly string[];
  _teamPermission?: string;
  // new in 2.7.1
  _serviceScopes?: readonly string[];                                    // requireServiceScope
  _scopeContext?: Record<string, string | undefined>;                    // requireScopeContext
  _orgInScopeTarget?: string | ((ctx: PermissionContext) => string | undefined); // requireOrgInScope
}
```

The three call sites that previously did ad-hoc casts
(`(check as PermissionCheck<TDoc> & { _serviceScopes?: ... })._serviceScopes = ...`)
now do `check._serviceScopes = ...` directly. Mechanical change, no behavior
difference, but now any tooling that walks `PermissionCheckMeta` sees the
full set of helpers without runtime introspection.

**JSDoc on `requireOrgMembership` updated** ([src/permissions/index.ts:621](src/permissions/index.ts#L621))
to reflect that it grants for `member`, `service`, AND `elevated` (the
implementation already did this since 2.7.1's Gap 1 fix; the comment was
behind). The new JSDoc also documents the canonical pairing with
`multiTenantPreset` and shows the `allOf(requireOrgMembership(),
requireServiceScope('jobs:write'))` composition pattern.

**`docs/getting-started/org.mdx` comprehensive refresh** to match the
current model. Changes:

- `RequestScope` union now shows all 5 kinds (was 4 — `service` was missing)
  with `context` and `ancestorOrgIds` fields
- Type-guards section now includes `isService`, `hasOrgAccess`,
  `getServiceScopes`, `getScopeContext`, `getScopeContextMap`,
  `getAncestorOrgIds`, `isOrgInScope`
- New "API Key Auth (service scope)" subsection showing the canonical
  `requireApiKey()` → `PermissionResult.scope` pattern
- New "Adding Custom Dimensions and Ancestors" subsection showing how to
  populate `context` / `ancestorOrgIds` from a Fastify hook
- "Automatic Data Filtering" section now covers both single-field and
  multi-field forms with the full scope-kind behavior table
- "Permission Functions" section now lists all six helpers
  (`requireOrgMembership`, `requireOrgRole`, `requireTeamMembership`,
  `requireServiceScope`, `requireScopeContext`, `requireOrgInScope`) with
  call shapes and the human-vs-machine policy
- New "Behavior summary" table — every helper × every scope kind in one place
- New "Real-world scenario quick reference" table mapping the 9 common
  tenancy patterns to the helper combinations that express them

### Polish — primitives, DRY, and shared test factories

A self-review pass on the new code surfaced several small organizational
improvements worth doing while the test suite is fully green:

**Single source of truth for `getScope(request)`** — the same 3-line
"read `request.scope` with a `PUBLIC_SCOPE` fallback" helper was duplicated
in `src/permissions/index.ts` and `src/presets/multiTenant.ts`. Hoisted to
[src/scope/types.ts:380](src/scope/types.ts#L380) as a real exported
primitive `getRequestScope(request)`. Both call sites now import it as
`{ getRequestScope as getScope }` so the rest of the file reads identically
to before. Re-exported from `@classytic/arc/scope` for any consumer code
that wants the same fallback semantics.

**Shared test factories** — `makePublicCtx`, `makeAuthenticatedCtx`,
`makeMemberCtx`, `makeServiceCtx`, `makeElevatedCtx` plus a low-level
`makeCtx(scope, opts)` primitive, all in
[tests/_helpers/scope-factories.ts](tests/_helpers/scope-factories.ts).
Each factory accepts only the fields its scope kind actually carries
(member gets `context` and `ancestorOrgIds`, service gets `clientId` +
`scopes`, elevated gets `elevatedBy`, etc.). Sensible defaults so a typical
call is one line. Migrated all three new permission test files to use
them — eliminated ~200 lines of duplicated factory code across
`tests/permissions/service-scope.test.ts` (-65 LOC),
`scope-context.test.ts` (-65 LOC), and `org-hierarchy.test.ts` (-75 LOC).
Future permission tests can write `makeMemberCtx({ orgRoles: ['admin'] })`
instead of constructing scope literals by hand.

The factories deliberately freeze the `context` map with `Object.freeze`
so a test can't accidentally mutate scope state across cases. Tests that
exercise the *accessors* directly (`getScopeContext`, `getAncestorOrgIds`)
keep their inline `RequestScope` literals — those tests verify the
accessor against a known scope shape, and routing them through factories
would conflate two layers.

**`normalizeVariadicOrArray` helper** — `Array.isArray(args[0]) ? args[0] : (args as string[])`
appeared 3× across `roles()`, `requireOrgRole()`, and `requireServiceScope()`.
Extracted as a private helper at the top of `src/permissions/index.ts`
([L188](src/permissions/index.ts#L188)). Each helper now reads
`const items = normalizeVariadicOrArray(args)` instead of inlining the
ternary, so the next helper that needs the same overload pattern just
calls the named primitive. `requireRoles` is intentionally left on its own
normalization path because its overload is richer (it also accepts options).

**Section headers tightened in `permissions/index.ts`** — the
"Organization Permission Helpers" section had grown to ~800 LOC and now
held service scopes, scope context, hierarchy, AND permission matrices.
Split into 5 named subsections with clear scope:

- **Org-Bound Helpers** — `requireOrgMembership`, `requireOrgRole`
- **Service / API Key Scopes** — `requireServiceScope`
- **Scope Context (custom tenancy dimensions)** — `requireScopeContext`
- **Org Hierarchy** — `requireOrgInScope`
- **Permission Matrices** — `createOrgPermissions`, `createDynamicPermissionMatrix`

No code moved — pure documentation polish for navigation.

**Validation**: typecheck clean, lint clean (9 files touched), full
regression sweep still **575 / 575** across 43 test files. Zero existing
tests changed.

### Polish — release-clean repo + doc coverage parity

A final review pass before publish surfaced two issues blocking
release-readiness:

**Repo-wide Biome lint clean** — 8 errors across 7 files were left over
from earlier in-flight work (`BaseController.ts`, `defineResourceVariants.ts`,
`mongoose-mixed-strict.test.ts`, `bulk-integration.test.ts`,
`bulk-mongokit-e2e.test.ts`, `id-field-real-mongoose.test.ts`,
`allOf-scope-chaining.test.ts`). All formatter or import-order, no
semantic risk. Fixed via `biome check --write`. **Repo now passes
`biome check src/ tests/` cleanly across 445 files.**

**Doc coverage parity** — `org.mdx` was the only doc that mentioned
`requireServiceScope`, `requireScopeContext`, `requireOrgInScope`,
`scope.context`, or `scope.ancestorOrgIds`. Three other docs still
described the older 4-kind RequestScope model:

- [docs/getting-started/permissions.mdx](docs/getting-started/permissions.mdx):
  added a new "Org-Bound Helpers" section covering all 6 org-side helpers
  with call shapes, behavior summary table, and the human-vs-machine
  composition pattern. Updated the closing helpers reference table.
  Corrected the stale `PermissionContext` interface (was showing a
  top-level `organizationId?: string` field that hasn't existed for
  several versions) and added a callout pointing readers at
  `request.scope` accessors instead.
- [docs/getting-started/auth.mdx](docs/getting-started/auth.mdx):
  permission helper table extended with the 5 new helpers + mixed-route
  callout. RequestScope variants comment now shows all 5 kinds and
  documents the new accessors. The "Mongoose Populate" section was
  rewritten from the manual 15-line loop to use the new
  `@classytic/arc/auth/mongoose` subpath helper, with the full
  plugin-coverage table.
- [AGENTS.md](AGENTS.md): scope kinds enumerated correctly
  (`public|authenticated|member|service|elevated`) in both the architecture
  map and the RequestScope section. The accessors example now lists all
  current accessors and a one-sentence pointer at the permission helpers
  for each scope kind.

**Net result**: every public doc now reflects the actual code surface, the
biome gate is green across the entire repo, and `npm run smoke` packs a
clean `classytic-arc-2.7.1.tgz`. **1113 / 1113 regression tests passing
across 82 test files** (the broader sweep that includes the formatter-
rewritten files), zero behavior changes from any of the polish items.

### BREAKING — `requireRoles()` now checks BOTH platform and org roles by default

`requireRoles()`'s `includeOrgRoles` option used to default to `false`, meaning
`requireRoles(['admin'])` only checked `user.role` and silently ignored
`scope.orgRoles`. This was the wrong default for the most common case (Better
Auth's organization plugin assigns roles at the org level), forcing users to
remember `{ includeOrgRoles: true }` on almost every call site.

**New behavior in 2.7.1:** `requireRoles()` defaults to `includeOrgRoles: true`.
Both layers are checked — passing in either grants access. Elevated scope
always passes.

**Migration:** if you actually relied on platform-only checks (e.g. a global
"superadmin" role that should NOT match an org-scoped "superadmin" role),
explicitly opt out:

```typescript
// Pre-2.7.1 (implicit platform-only):
requireRoles(['superadmin'])

// 2.7.1+ (explicit platform-only opt-out):
requireRoles(['superadmin'], { includeOrgRoles: false })
```

For most apps, the new default is what you wanted all along — no migration
needed, just delete any leftover `{ includeOrgRoles: true }` options for
brevity.

### Docs + scaffold convergence on `requireRoles()`

With the new default, `requireRoles()` and `roles()` are functionally identical
for the common case (`includeOrgRoles: true`). The CLI scaffold, getting-started
docs, and JSDoc all now lead with `requireRoles()` as the canonical helper.
`roles()` remains exported as an alias for backwards compatibility — existing
code keeps working, but new code should use `requireRoles()` to match the rest
of the `requireXxx()` family.

### Tenancy primitives → all shipped in 2.7.1

Earlier drafts of this changelog deferred multi-level tenancy and parent-
child hierarchy to 2.8.0. **Both moved up and shipped in 2.7.1** — see the
"Multi-level tenancy" section (`scope.context` + `requireScopeContext` +
`multiTenantPreset({ tenantFields })`) and the "Parent-child org hierarchy"
section (`ancestorOrgIds` + `requireOrgInScope`) above.

What's left legitimately for 2.8+:

- **Automatic ancestor inheritance in `multiTenantPreset`**. Today the
  preset filters by the caller's *current* org only; ancestor-aware
  filtering is opt-in via custom middleware. We held this back because a
  careless auth function loading too many ancestors silently widens query
  scope — needs more design before becoming a one-line option. Compose
  manually for now via `getAncestorOrgIds(scope)` + `_policyFilters`.
- **Graph traversal at request time**. The current `ancestorOrgIds` model
  assumes the chain is pre-loaded on auth. Apps with dynamic graph membership
  (>1000 ancestors, frequently changing) keep their custom checks for now.

### `requireRoles()` accepts variadic strings (DX)

```typescript
// All three forms produce identical behavior:
requireRoles('admin')
requireRoles('admin', 'editor')
requireRoles(['admin', 'editor'])

// Options object still requires the array form:
requireRoles(['admin'], { bypassRoles: ['superadmin'] })
```

The variadic form makes single-role and small-multi-role calls read more
naturally. The array form is still required when you also need to pass
`{ bypassRoles, includeOrgRoles }` options.

### Strict-AJV cleanliness — `Schema.Types.Mixed` no longer emits a union type

The Mongoose adapter previously generated this for `Schema.Types.Mixed` fields:

```json
{ "type": ["string", "number", "boolean", "object", "array"] }
```

AJV strict mode flagged the union as a `strictTypes` violation
(`use allowUnionTypes to allow union type keyword`), AND the union excluded
`null`, breaking nullable Mixed fields.

The adapter now omits the `type` keyword entirely for Mixed fields. JSON Schema
treats a missing `type` as "any value", which is both strict-clean and
semantically more accurate for Mongoose's untyped Mixed type. AJV strict mode
compiles generated route schemas with zero warnings.

Validation behavior is unchanged from a user perspective — Mixed accepts any
value (string, number, boolean, object, array, null, undefined).

### DX — `idField` auto-derives from the repository

Configuring `idField` in two places (the repo AND the resource) was redundant
and confusing. Now you only set it once on the repository:

```typescript
// Set idField in ONE place — the repository
const repo = new Repository<IChat>(ChatModel, [], {}, { idField: 'id' });

// defineResource picks it up automatically — no `idField: 'id'` needed
const chatResource = defineResource<IChat>({
  name: 'chat',
  adapter: createMongooseAdapter({ model: ChatModel, repository: repo }),
  // ↑ AJV params schema accepts UUIDs (no ObjectId pattern), routes use `:id`,
  //   BaseController passes route ids straight through to repo lookups
});
```

The auto-derive applies when:
- The repository exposes `idField` (e.g. MongoKit's `Repository({ idField })`)
- AND `defineResource()` does NOT set `idField` explicitly

Explicit override still wins:

```typescript
defineResource({ idField: '_id', adapter: ... });  // forces _id even if repo says 'id'
```

Backwards compatible: existing resources that set `idField` explicitly behave
identically to before.

### DX — `defineResourceVariants` for multi-resource patterns

Common pattern: the same data exposed through two HTTP interfaces (public
slug-keyed read-only + admin _id-keyed CRUD). The new helper takes a shared
base config + per-variant overrides and returns N independent
`ResourceDefinition`s sharing one model/repo/adapter:

```typescript
import { defineResourceVariants } from '@classytic/arc';
import { allowPublic, adminOnly, readOnly } from '@classytic/arc/permissions';

const repo = new Repository<IArticle>(ArticleModel);
const adapter = createMongooseAdapter({ model: ArticleModel, repository: repo });

export const { articlePublic, articleAdmin } = defineResourceVariants<IArticle>(
  // Shared base
  { adapter, queryParser: new QueryParser({ allowedFilterFields: ['status'] }) },
  {
    articlePublic: {
      name: 'article',
      prefix: '/articles',
      idField: 'slug',
      disabledRoutes: ['create', 'update', 'delete'],
      permissions: readOnly(),
    },
    articleAdmin: {
      name: 'article-admin',
      prefix: '/admin/articles',
      permissions: adminOnly(),
    },
  },
);

// Each variant is a real ResourceDefinition — register normally
await app.register(articlePublic.toPlugin());
await app.register(articleAdmin.toPlugin());
```

Each variant goes through `defineResource()` independently, so presets, hooks,
registry, OpenAPI, and MCP plugins all work normally. The helper is pure sugar
that returns N real resources — no new framework primitives.

### Security — bulk write endpoints now sanitize protected fields

**Bug:** `bulkCreate()` and `bulkUpdate()` bypassed Arc's normal write
sanitization pipeline. Single-doc `create()` / `update()` route input through
`BodySanitizer.sanitize()` which strips `systemManaged`, `readonly`,
`immutable`, and field-permission-restricted fields. The bulk endpoints sent
the user-supplied payload straight to `repo.createMany()` / `repo.updateMany()`
with no sanitization. This let any caller — including a tenant-scoped user —
bulk-modify protected fields on their own rows, including `createdBy`,
`updatedBy`, or even `organizationId` (allowing cross-tenant data movement if
the underlying repo honored the update).

**Fix:**

- **`bulkCreate`** — runs each item through `bodySanitizer.sanitize('create', ...)`
  before tenant injection. System fields, `systemManaged`/`readonly` rules, and
  field-level write permissions all enforced per item, identical to single-doc
  `create()`.

- **`bulkUpdate`** — runs the data payload through
  `bodySanitizer.sanitize('update', ...)`. Handles BOTH shapes:
  - Flat: `{ name: 'x', status: 'y' }`
  - Mongo operator: `{ $set: { name: 'x' }, $inc: { views: 1 }, $unset: { tag: '' } }`

  For operator shape, each operand is sanitized independently. Empty operators
  (e.g. `{ $set: {} }` after stripping every key) are dropped. If ALL fields
  are stripped, the request is rejected with `400 ALL_FIELDS_STRIPPED` and the
  list of stripped fields in `details.stripped` so callers know what was rejected.

- **Stripped-field reporting** — successful bulk updates include
  `meta.stripped` listing any fields that were silently dropped, so audit
  pipelines and clients can detect attempted writes to protected fields.

### `bulkCreate` partial-success reporting (HTTP 207 / 422)

`bulkCreate()` no longer blindly returns 201 when MongoKit's unordered insert
silently skips invalid documents. The new response distinguishes:

| Outcome | Status | `meta.partial` | `meta.reason` |
|---------|--------|---------------|---------------|
| All inserted | `201 Created` | absent | absent |
| Some inserted | `207 Multi-Status` | `true` | `"some_invalid"` |
| None inserted | `422 Unprocessable Entity` | `true` | `"all_invalid"` |

`meta` always includes `requested`, `inserted`, and `skipped` counts so
callers can act on partial results without reverse-engineering counts from
the returned rows. Existing callers that only checked `meta.count` keep
working — `count` is still present.

### Hotfix — `idField` end-to-end with native-PK repositories

**Bug:** Arc 2.6.3–2.7.0 unconditionally translated route `id` → `existing._id`
in `BaseController.update()` / `delete()` / `restore()` whenever
`defineResource({ idField })` was set to anything other than `_id`. This broke
any repository that natively looks up by a custom field (e.g.
`new Repository(Model, [], {}, { idField: 'id' })` from MongoKit), causing every
mutation to silently 404 because the repo received an `_id` value but searched
by `id`.

**Fix:** New `BaseController.resolveRepoId()` helper that auto-detects whether
the repository exposes a matching `idField` property and skips the translation
when it does. Slug-style aliasing (where the repo only knows `_id`) still works
exactly as before — both interpretations are now supported automatically.

**Repository contract:** `RepositoryLike` now declares an optional
`readonly idField?: string` field. Adapter authors can opt their repository
into native-PK pass-through by exposing this property. MongoKit's `Repository`
already does — no changes needed for MongoKit users.

### `bulkDelete` accepts `ids[]` in addition to `filter`

```typescript
// Before — users had to construct the filter manually with Mongo operators:
POST /products/bulk
{ "filter": { "_id": { "$in": ["a", "b", "c"] } } }

// Now — pass ids directly, Arc translates using the resource's idField:
POST /products/bulk
{ "ids": ["a", "b", "c"] }

// Works with custom idField too:
POST /chats/bulk     // defineResource({ idField: 'id' })
{ "ids": ["uuid-1", "uuid-2"] }
// → repo.deleteMany({ id: { $in: ['uuid-1', 'uuid-2'] } })
```

Both forms perform a single `repo.deleteMany()` call with tenant scope and
policy filters merged in. Per-doc lifecycle hooks (`before:delete` /
`after:delete`) do NOT fire for bulk operations — use the single-doc `delete()`
if you need them, or subscribe to bulk lifecycle events.

Returns 400 if both `ids` and `filter` are provided (mutually exclusive).

### Affected paths

- `src/core/BaseController.ts` — `resolveRepoId()` helper, used by
  `update()`, `delete()`, `restore()`. `bulkDelete()` accepts `ids[]`.
- `src/adapters/interface.ts` — `RepositoryLike` declares `readonly idField?: string`.
- `tests/core/id-field-real-mongoose.test.ts` — 3 new regression tests for
  native-`idField` repositories.
- `tests/core/bulk-integration.test.ts` — 4 new tests for `ids[]` form.

### Migration

None required. Both fixes are backwards-compatible:
- Repos that don't expose `idField` keep the existing slug-translation behavior.
- `bulkDelete` still accepts `{ filter }` exactly as before.

### Recommendation

If you were on 2.6.3, 2.6.4, 2.6.5, or 2.7.0 and use `defineResource({ idField })`
with a repository that natively supports the same field (MongoKit
`Repository({ idField })` users — this is you), upgrade to 2.7.1 immediately.
2.7.0 has been unpublished.

### Also in 2.7.1 — Better Auth 1.6 alignment

Audited the BA adapter against the Better Auth 1.6 surface (`auth.handler`,
`api.getSession`, organization plugin endpoints, `getActiveMemberRole`,
`listTeams`, session shape). All paths still align — no breaking changes from
BA core. Bumped peer dep `better-auth: >=1.5.5` → `>=1.6.0`.

Removed two `any` casts in the team-resolution branch of `betterAuth.ts`. Team
id matching now uses the existing `normalizeId()` helper, so team ids stored
as `{ _id: '...' }` objects (e.g. mongoose-style) match correctly.

### New: `@classytic/arc/auth/mongoose` — populate against Better Auth collections

When you back Better Auth with the official `@better-auth/mongo-adapter`, BA
writes through the native `mongodb` driver and never registers anything with
Mongoose. Any arc resource that does
`Schema({ userId: { type: String, ref: 'user' } })` and calls
`.populate('userId')` then throws `MissingSchemaError`.

New optional helper at a dedicated subpath registers `strict: false` stub
Mongoose models for BA's collections so populate works end-to-end. Lives
behind a subpath export so users on Prisma/Drizzle/Kysely never get Mongoose
pulled into their bundle.

```typescript
import mongoose from 'mongoose';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { organization } from 'better-auth/plugins';
import { registerBetterAuthMongooseModels } from '@classytic/arc/auth/mongoose';

const auth = betterAuth({
  database: mongodbAdapter(mongoose.connection.getClient().db()),
  plugins: [organization({ teams: { enabled: true } })],
  // ...
});

// Register stub models AFTER betterAuth() so collections are known.
// Default is core only (`user`, `session`, `account`, `verification`) —
// every plugin set is opt-in.
registerBetterAuthMongooseModels(mongoose, {
  plugins: ['organization', 'organization-teams'],
});

// Now arc resources can populate BA-owned references:
const Post = mongoose.model('Post', new mongoose.Schema({
  title: String,
  authorId: { type: String, ref: 'user' },
}));
await Post.findOne().populate('authorId'); // resolves against BA's user collection
```

Plugin coverage (researched against BA 1.6 docs, not guesswork):

- **Core BA plugins** (selectable via `plugins: [...]`): `organization`, `organization-teams`, `twoFactor`, `jwt`, `oidcProvider`, `oauthProvider` (alias for `oidcProvider`), `mcp` (reuses oidcProvider schema per docs), `deviceAuthorization`
- **Separate `@better-auth/*` packages** (use `extraCollections` — they evolve independently of core): `@better-auth/passkey` → `'passkey'`, `@better-auth/sso` → `'ssoProvider'`, `@better-auth/api-key` → consult plugin docs
- **Field-only plugins** (no entry needed — `strict: false` stubs round-trip extra fields): `admin`, `username`, `phoneNumber`, `magicLink`, `emailOtp`, `anonymous`, `bearer`, `multiSession`, `siwe`, `lastLoginMethod`, `genericOAuth`, etc.

Other features: `usePlural` (matches `@better-auth/mongo-adapter`'s
pluralization), `modelOverrides` (for custom `user: { modelName: 'profile' }`
configs), `extraCollections` (for separate-package plugins or custom plugins).
Idempotent — safe to call repeatedly under HMR. Deduplicates overlapping
collection sets so `plugins: ['mcp', 'oidcProvider']` won't crash with
`OverwriteModelError`.

### New: real BA + mongo smoke test

Added `tests/smoke/better-auth-mongo.smoke.test.ts` that boots a real
`betterAuth()` instance against `mongodb-memory-server` via
`@better-auth/mongo-adapter`. Covers signup → cookie session,
`createOrganization` → `setActiveOrganization` → member scope, multi-role →
`requireOrgRole` matches, `createTeam` → `addTeamMember` → `setActiveTeam` →
`scope.teamId` populated, and the `x-organization-id` header fallback for
API-key auth.

This is the canary that catches BA upgrade regressions that mock-based tests
can't — when BA 1.7 or 2.0 lands, this test will fail in seconds rather than
waiting for a user bug report.

## 2.6.3

### `idField` override works end-to-end

Resources with a custom `idField` (e.g. `jobId`, `orderId`, UUID strings) no longer get their routes rejected by AJV's ObjectId pattern validation. Fixed at two layers:

- **New adapter contract** — `DataAdapter.generateSchemas(options, context?)` now accepts `AdapterSchemaContext` with `idField` and `resourceName`. Adapters and schema-generator plugins (MongoKit's `buildCrudSchemasFromModel`) can produce the right `params.id` shape from the start. Backwards compatible — legacy adapters ignoring the argument still work via the safety net below.
- **Safety net in `defineResource`** — when `idField !== '_id'` and any known ObjectId pattern is detected on `params.id`, Arc strips `pattern` / `minLength` / `maxLength` and sets a description. User-provided `openApiSchemas.params` still wins over everything.

```typescript
defineResource({
  name: 'job',
  adapter: createMongooseAdapter(JobModel, jobRepository),
  idField: 'jobId',     // ← one line, now works for routes + MCP tools + OpenAPI docs
});

// GET /jobs/job-5219f346-a4d  → 200 (was 400 "must match pattern ^[0-9a-fA-F]{24}$")
```

Covers all three layers: Fastify route validation (AJV), BaseController lookups, OpenAPI docs.

### List query normalization — no more AJV strict-mode warnings

Rewrote the listQuery normalization in `defineResource.toPlugin()`. The old approach tried to strip `type` from filter fields but missed `populate` (with its `oneOf` composition), didn't recurse into composition keywords, and could leave orphan `minimum`/`maximum` constraints when merging with partial user schemas.

New strategy: a fixed allowlist of well-known keys (`page`, `limit`, `sort`, `search`, `select`, `after`, `populate`, `lookup`, `aggregate`) preserves its parser-emitted schema. Everything else (filter fields) is replaced with `{}` (accept-any) — the `QueryParser` owns runtime validation, AJV just gets out of the way.

Works with MongoKit, SQL-style parsers, composition-heavy custom parsers, or any exotic user-defined shape. The `_registryMeta.openApiSchemas.listQuery` is NOT mutated, so OpenAPI docs still show the rich parser output.

### Mongoose adapter — body schemas default to `additionalProperties: true`

The built-in Mongoose adapter fallback now emits `additionalProperties: true` on `createBody` and `updateBody` (previously only on `response`), so POST/PATCH requests with extra fields are no longer rejected by the built-in fallback generator. Explicit generators (MongoKit's `buildCrudSchemasFromModel`) can still override this by setting `additionalProperties: false`.

### Peer dependencies use `>=` instead of `^`

All peer dependency version ranges converted from `^X.Y.Z` to `>=X.Y.Z` so users upgrading to new majors don't get peer-dep warnings. Notable:

- `mongodb`: `^6.0.0 || ^7.0.0` → `>=6.0.0` (MongoDB 8.x now supported)
- `fastify`: `^5.7.4` → `>=5.0.0`
- `zod`: `^4.0.0` → `>=4.0.0`
- `bullmq`, `ioredis`, all `@fastify/*`, `@sinclair/typebox`, `pino-pretty`, `fastify-raw-body`

### Tests

- **`tests/core/id-field-params-schema.test.ts`** — 6 tests: safety net, adapter context, E2E routes with custom ID formats, user override precedence
- **`tests/core/list-query-normalization.test.ts`** — 5 tests with MongoKit-like, SQL-style, composition-based parsers
- **`tests/docs/openapi-integration.test.ts`** — 7 full integration tests with real `MongoMemoryServer` + MongoKit `Repository` + `arcCorePlugin` + `openApiPlugin`, AJV strict mode logger attached, verifies zero warnings + OpenAPI docs generation + real CRUD requests

**Suite total: 218 files, 3053 passing, 0 failures.**

## 2.6.2

### Audit Plugin — Per-Resource Opt-In

- **`autoAudit: { perResource: true }`** — cleanest opt-in pattern. Only resources with `audit: true` in their `defineResource()` config are auto-audited. No more growing `exclude` lists.
  ```typescript
  // app.ts
  await fastify.register(auditPlugin, { autoAudit: { perResource: true } });

  // order.resource.ts
  defineResource({ name: 'order', audit: true });

  // payment.resource.ts — only audit deletes
  defineResource({ name: 'payment', audit: { operations: ['delete'] } });
  ```
- **`autoAudit: { include: [...] }`** — allowlist mode (centralized config alternative)
- **Distributed sink** — multiple `customStores` fan out audit entries in parallel (primary + replica + cold archive)
- **Read auditing & MCP actions** — `fastify.audit.custom()` works from any handler (additionalRoutes, MCP tools, compliance endpoints). 8 flexibility tests cover the surface.

### loadResources Improvements

- **Discovers ANY named export with `toPlugin()`** — not just `default`/`resource`. The common `export const userResource = defineResource(...)` convention now works.
- **Better error messages** — vitest hint added to `.js→.ts` failure messages. Windows drive-letter guard prevents misleading "protocol 'd:'" errors.

### Test Helpers

- **`preloadResources(import.meta.glob(...))`** — vitest workaround for resources that need bootstrap (engine init) or transitive `node_modules` imports. Eager and async variants.

### DX Fixes

- **`developmentPreset` pino-pretty fallback** — gracefully falls back to JSON logging if `pino-pretty` is not installed (common when `NODE_ENV` selects dev preset in production where dev deps are pruned).
- **`ResourceLike` exported** from `@classytic/arc/factory` — typed wrapper for users building their own resource loaders.
- **No index signature on `ResourceLike`** — `ResourceDefinition` is now assignable without `as any` casts.
- **TestHarness/HttpTestHarness type fixes** — missing class property declarations added.

### Security

- **JSON parser prototype poisoning** — `secure-json-parse` now a direct dependency (was relying on Fastify's transitive). Fastify's `onProtoPoisoning` protection is preserved when handling empty DELETE/GET bodies.

### Factory Refactor

- **`createApp.ts` split into 4 modules** — `registerSecurity`, `registerAuth`, `registerArcPlugins`, `registerResources`. Each independently testable. 58 new unit tests.
- **`resourcePrefix`** — register all resources under a URL prefix
- **`skipGlobalPrefix`** — per-resource opt-out (webhooks, admin routes)
- **`bootstrap[]`** — domain init after `plugins()`, before `resources`
- **`afterResources`** — post-registration hook
- **Duplicate resource detection** — warns before Fastify route conflicts
- **Testing preset disables `gracefulShutdown`** — fixes `MaxListenersExceededWarning` in multi-app test processes

### Test Coverage

- **3009+ tests across 212 files** (was 2900+)
- 15 audit tests (per-resource, allowlist, denylist, distributed, MCP, custom actions)
- 6 named-export discovery tests
- 11 preloadResources tests
- 58 factory module unit tests

## 2.6.0

### Security

- **JSON parser prototype poisoning fix** — replaced plain `JSON.parse()` with `secure-json-parse` in the custom content-type parser. Fastify's built-in proto-poisoning protection (`onProtoPoisoning`, `onConstructorPoisoning`) is now preserved when handling empty-body DELETE/GET requests.

### Factory & Boot Sequence

- **`resourcePrefix`** — register all resources under a URL prefix (e.g., `/api/v1`)
  ```typescript
  const app = await createApp({
    resourcePrefix: '/api/v1',
    resources: await loadResources(import.meta.url),
  });
  // product → /api/v1/products, order → /api/v1/orders
  ```
- **`skipGlobalPrefix`** — per-resource opt-out of `resourcePrefix`
  ```typescript
  defineResource({ name: 'webhook', prefix: '/hooks', skipGlobalPrefix: true })
  // stays at /hooks even with resourcePrefix: '/api/v1'
  ```
- **`bootstrap[]`** — domain init functions that run after `plugins()` but before `resources`
  ```typescript
  createApp({
    plugins: async (f) => { await connectDB(); },
    bootstrap: [inventoryInit, accountingInit],
    resources: await loadResources(import.meta.url),
  });
  ```
- **`afterResources`** — hook after resources are registered (for cross-resource wiring)
- **Boot order** — `plugins → bootstrap → resources → afterResources → onReady`
- **Duplicate resource detection** — warns on duplicate resource names before registration
- **`createApp()` refactored** into 4 modules: `registerSecurity`, `registerAuth`, `registerArcPlugins`, `registerResources` — each independently testable
- **Testing preset disables `gracefulShutdown`** — prevents `MaxListenersExceededWarning` in multi-app test processes

### Resource Loading

- **`loadResources(import.meta.url)`** — resolves dirname internally, works in both `src/` (dev) and `dist/` (prod)
- **`loadResources({ silent: true })`** — suppresses skip/failure warnings for factory files
- **Import compatibility** — works with relative imports, Node.js `#` subpath imports. tsconfig path aliases (`@/*`, `~/`) require explicit `resources: [...]`

### Schema & Validation

- **AJV strict-mode warnings fixed** — filter field normalization now strips all type-dependent keywords (`minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `format`, etc.) not just `type`

### Test Coverage

- 7 JSON parser security tests (prototype poisoning, empty body, malformed)
- 58 factory module unit tests (registerSecurity, registerAuth, registerArcPlugins, registerResources)
- 25 import compatibility tests (relative, `#` subpath, tsconfig aliases, `import.meta.url`)
- 14 boot sequence tests (order, bootstrap, afterResources, resourcePrefix)
- 11 resourcePrefix + skipGlobalPrefix E2E tests
- 7 full app E2E tests (complete boot simulation)

## 2.5.5

### Auth & Permissions

- **`roles()` helper** — checks both platform `user.role` AND org `scope.orgRoles` automatically. Drop-in fix for Better Auth org plugin users where `requireRoles(['admin'])` silently denied org-level admins.
  ```typescript
  import { roles } from '@classytic/arc/permissions';
  permissions: { create: roles('admin', 'editor') }  // checks both levels
  ```
- **`requireRoles({ includeOrgRoles: true })`** — backward-compatible option for existing code
- **`AdditionalRoute.handler` type** — now accepts `ControllerHandler` when `wrapHandler: true` (no more `as any`)
- **Denial messages do not leak held roles** — safe for action routes that return reason to clients

### Schema & Validation

- **Bracket notation filters work** — `?name[contains]=foo`, `?price[gte]=100` no longer rejected by Fastify. AJV validates structure; QueryParser validates content.
- **Subdocument arrays generate proper object schemas** — `[{ account: ObjectId, debit: Number }]` → `{ items: { type: 'object', properties: {...} } }`
- **`excludeFields` respected by Mongoose adapter** — removes from both `properties` AND `required` array
- **`readonlyFields` excluded from body schemas** — previously only stripped at runtime
- **`immutable` / `immutableAfterCreate` fields** — excluded from update body + stripped by BodySanitizer
- **Date fields no longer enforce `format: "date-time"`** — `"2026-01-15"` passes Fastify; Mongoose handles parsing
- **AJV strict-mode warnings fixed** — pagination/search keep types, only filter fields stripped
- **Mongoose type mapping** — Array elements, Mixed, Map, Buffer, Decimal128, UUID, SubDocument
- **Response schema `additionalProperties: true`** — virtuals not stripped by fast-json-stringify
- **`LookupOption.select`** — accepts `string | Record<string, 0 | 1>` (MongoKit compat)

### Factory & Resource Loading

- **`createApp({ resources })`** — register resources directly, no `toPlugin()` needed
- **`loadResources(dir)`** — auto-discover `*.resource.{ts,js,mts,mjs}` files from a directory
  ```typescript
  import { createApp, loadResources } from '@classytic/arc/factory';
  const app = await createApp({
    resources: await loadResources('./src/resources'),
  });
  ```
- **`loadResources` options** — `exclude`, `include`, `suffix`, `recursive`
- **`loadResources` import compatibility** — works with relative imports and Node.js `#` subpath imports (`package.json` `imports`). tsconfig path aliases (`@/*`, `~/`) require explicit `resources: [...]` instead.
- **`.js→.ts` resolution fixed in vitest** — `pathToFileURL` first ensures loader hooks intercept entire import chain
- **Parallel imports** — `Promise.all()` for all resource files
- **No double-execution on module errors** — evaluation errors reported once, not retried
- **Actionable error messages** — `.js` import failures get a hint about TS ESM convention
- **Resource registration errors** — descriptive messages with resource name

### Audit

- **DB-agnostic userId extraction** — Mongoose ObjectId, string, number (no `.toString()` mismatch)
- **MCP edits trigger auto-audit** — same BaseController → hooks → audit pipeline as REST
- **Manual audit from custom routes** — `fastify.audit.custom()` works in raw handlers

### MCP Integration

- Operator-suffixed filter fields (`price_gt`, `price_lte`)
- Auto-derive `filterableFields` and `allowedOperators` from `QueryParser`
- `GET /mcp/health` diagnostic endpoint
- Auth failure WARN logging

### Test Coverage

- 2,791 tests across 194 files
- 38 loadResources tests (patterns, .js→.ts, parallel, error handling)
- 16 multi-tenant hierarchy tests (org isolation, cross-org denial, team scoping)
- 15 query schema compatibility tests (bracket notation, combined filters)
- 14 business scenario tests (accounting subdocs, mixed tenant, plugin-added fields)
- 10 route prefix tests (custom, hyphenated, nested, conflicts)
- 48 permission tests (roles(), denial security, platform + org checks)
- 38 audit tests (userId extraction, change detection, auto-audit)

## 2.4.3

```typescript
import { mcpPlugin } from '@classytic/arc/mcp';
await app.register(mcpPlugin, { resources, auth: false });
// → list_products, get_product, create_product, update_product, delete_product
```

- **Stateless by default** — fresh server per request, scales horizontally
- **Three auth modes** — `false` (no auth), Better Auth OAuth 2.1, custom function
- **Multi-tenancy** — `organizationId` from auth auto-scopes all queries
- **Permission filters** — `PermissionResult.filters` enforced in MCP (same as REST)
- **Guards** — `guard(requireAuth, requireOrg, requireRole('admin'), handler)`
- **Schema discovery** — `arc://schemas` and `arc://schemas/{name}` MCP resources
- **Health endpoint** — `GET /mcp/health` for diagnostics
- **Per-resource overrides** — `include`, `names`, `toolNamePrefix`, `hideFields`
- **Custom tools co-located** — `order.mcp.ts` alongside `order.resource.ts`
- **CLI** — `arc generate resource product --mcp`, `arc generate mcp analytics`

### DX Improvements

- **`ArcRequest`** — typed Fastify request with `user`, `scope`, `signal`
- **`envelope(data, meta?)`** — response helper, no manual `{ success, data }` wrapping
- **`getOrgContext(req)`** — canonical org extraction from any auth type
- **`createDomainError(code, msg, status)`** — domain errors with auto HTTP status mapping
- **`onRegister(fastify)`** — resource lifecycle hook for wiring singletons
- **`preAuth`** — pre-auth handlers on routes for SSE `?token=` promotion
- **`streamResponse`** — auto SSE headers + bypasses response wrapper
- **`request.signal`** — Fastify 5 native AbortSignal on disconnect

### Test Coverage

- 2,448 tests across 166 files (up from 2,228)
- 40 MCP permission tests (auth, multi-tenancy, guards, field-level, composite)
- 31 MCP DX tests (include, names, prefix, disableDefaultRoutes, mcpHandler, CRUD lifecycle)
- 17 core DX tests (envelope, getOrgContext, createDomainError, onRegister, preAuth, streamResponse)

### Dependencies

- `@modelcontextprotocol/sdk` — optional peer dep (required for MCP)
- `zod` — optional peer dep (required for MCP)
- `@classytic/mongokit` — bumped to >=3.4.3 (exposes QueryParser getters)

## 2.4.1

### New Features

#### Metrics Plugin
Prometheus-compatible `/_metrics` endpoint with zero external dependencies. Tracks HTTP requests, CRUD operations, cache hits/misses, events, and circuit breaker state.

```typescript
const app = await createApp({
  arcPlugins: { metrics: true },
});
// GET /_metrics → Prometheus text format
```

#### API Versioning Plugin
Header-based (`Accept-Version`) or URL prefix-based (`/v2/`) versioning with deprecation + sunset headers.

```typescript
const app = await createApp({
  arcPlugins: { versioning: { type: 'header', deprecated: ['1'] } },
});
```

#### Bulk Operations Preset
`presets: ['bulk']` adds `POST /bulk`, `PATCH /bulk`, `DELETE /bulk` routes. DB-agnostic — calls `repo.createMany()`, `repo.updateMany()`, `repo.deleteMany()`. Permissions inherit from resource config.

```typescript
defineResource({
  name: 'product',
  presets: ['softDelete', 'bulk'],
});
```

#### Webhook Outbound Plugin
Fastify plugin that auto-dispatches Arc events to customer webhook endpoints with HMAC-SHA256 signing, pluggable `WebhookStore`, and delivery logging.

```typescript
await fastify.register(webhookPlugin);
await app.webhooks.register({
  id: 'wh-1',
  url: 'https://customer.com/webhook',
  events: ['order.created'],
  secret: 'whsec_abc123',
});
```

#### Event Outbox Pattern
Transactional outbox for at-least-once event delivery. Store events in the same DB transaction, relay to transport asynchronously.

```typescript
const outbox = new EventOutbox({ store: new MemoryOutboxStore(), transport });
await outbox.store(event);  // same transaction as DB write
await outbox.relay();       // publish pending to transport
```

#### Per-Tenant Rate Limiting
Scope-aware rate limit key generator. Isolates limits by org, user, or IP.

```typescript
const app = await createApp({
  rateLimit: { max: 100, timeWindow: '1m', keyGenerator: createTenantKeyGenerator() },
});
```

#### Compensating Transaction
In-process rollback primitive. Runs steps in order, compensates in reverse on failure. For distributed sagas, use Temporal/Inngest/Streamline.

```typescript
const result = await withCompensation('checkout', [
  { name: 'reserve', execute: reserveStock, compensate: releaseStock },
  { name: 'charge', execute: chargeCard, compensate: refundCard },
  { name: 'confirm', execute: sendEmail },
]);
```

#### RPC Schema Versioning
`schemaVersion` option on `createServiceClient` sends `x-arc-schema-version` header for contract compatibility between services.

### Improvements

- **Bulk preset** wired into `defineResource` via `BaseController.bulkCreate/bulkUpdate/bulkDelete`
- **Metrics** and **versioning** wired into `createApp` via `arcPlugins.metrics` and `arcPlugins.versioning`
- **CLI `arc init`** now includes `bulk` preset and `metrics` in generated projects
- **MongoKit v3.4** peer dependency — soft-delete batch ops work natively

### Documentation

- Updated `skills/arc/SKILL.md` with all new features and subpath imports
- Updated `skills/arc/references/integrations.md` with webhook plugin docs
- Updated `skills/arc/references/production.md` with metrics, versioning, outbox, bulk, saga, tenant rate limiting

### Test Coverage

- 2,100+ tests across 143 files
- 44 webhook tests (plugin lifecycle, auto-dispatch, HMAC, delivery log, store contract, timeout, error resilience)
- 20 bulk preset tests (route generation, BaseController methods, validation, DB-agnostic contract)
- 14 metrics wiring tests (registration, endpoint, auto HTTP tracking, programmatic recording)
- 10 versioning wiring tests (header/prefix extraction, deprecation, sunset)
- 15 compensation tests (forward execution, rollback, context passing, error collection, Fastify route integration)
- 7 MongoKit E2E tests (real MongoDB — bulk create/update/delete + soft-delete awareness)
- 7 streaming compatibility tests (NDJSON, SSE, Zod schema conversion)
