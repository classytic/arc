# Multi-tenancy: scope, tenantField, filters

One source of truth: `request.scope`. Installing scope from custom auth is in tenancy-scope-install.md.

## Request ladder

```
1. Authenticator sets request.scope          (member | service | elevated | ...)
2. Permission check validates access         (may also set scope via allow({ scope }))
3. Adapter snapshots scope into metadata._scope
4. QueryResolver / AccessControl read metadata._scope
5. tenantField set AND getOrgId(scope) defined => org filter always applied
```

Skip a step and isolation silently breaks.

## Scope kinds

| Kind | Use | `userId` | `organizationId` | Helper |
|---|---|:-:|:-:|---|
| `public` | No auth | no | no | `PUBLIC_SCOPE` |
| `authenticated` | Signed in, no org | yes | no | `getUserId()` |
| `member` | User in an org with roles | yes | yes | `isMember()`, `getOrgId()` |
| `service` | Machine caller (API key, bot) | no (`clientId`) | yes | `isService()`, `getClientId()` |
| `elevated` | Platform admin | yes | optional | `isElevated()` |

Never fake a service as a `member` with `userId: client._id`: it pollutes audit rows, rate-limit keys and OAuth-scope checks.

## How `tenantField` is read

Every resource has `tenantField` (default `'organizationId'`, or `false`). `resolveTenancy()` (`src/core/tenancy.ts`) is the single decision; list, get/update/delete by id, post-fetch org check, the kit tenant options, bulk ops and the `sse`/`realtime` streams all switch on it:

| Result | Meaning |
|---|---|
| `scoped` (`field`, `orgId`) | Filter `field = orgId` (member, service, or elevated admin who selected an org) |
| `unscoped: 'platform'` | Elevated admin, no org: sees and writes across tenants |
| `unscoped: 'cross-tenant'` | Route listed in `multiTenantPreset({ crossTenant })`: reads only, row policy still applies |
| `unscoped: 'no-org'` | Anonymous or no org selected: reads get no tenant filter (the preset refuses earlier where an org is required); writes are refused |
| `unscoped: 'untenanted-resource'` | `tenantField: false` |

Never re-derive the org from scope in a new layer; call `resolveTenancy`. The cache key (`deriveCacheScope`) deliberately does not use it: it names the caller's cache partition.

## Filter composition

Final filter = AND of the parsed query filters, `_policyFilters` (from permission checks: ownership, project scoping), and `{ [tenantField]: orgId }`.

- A client filter can never widen or overwrite a policy filter (they are conjoined).
- The tenant filter is added unless the policy already constrains that field.
- Elevated scope without `organizationId`: no tenant filter (admin sees everything).

## Missing scope

If `tenantField` is set but `getOrgId(scope)` is undefined, list/get/update/delete are NOT narrowed: a `public` caller could read every tenant. Pair `tenantField` with a permission check that installs an org scope. `bulkUpdate` / `bulkDelete` return a null filter and are rejected.

Arc does NOT derive scope from `request.user.organizationId` inside permission checks. The JWT/`authenticator` path derives it for you (user with `organizationId` => `member`); otherwise return `scope` from the check.

## Presets and fields

```typescript
presets: [{ name: 'multiTenant', tenantField: 'organizationId' }]
// or several dimensions, fail-closed if one is missing:
multiTenantPreset({ tenantFields: [
  { field: 'organizationId', type: 'org' },
  { field: 'branchId', contextKey: 'branchId' },     // from scope.context
] })
```

`multiTenantPreset` options: `tenantField` XOR `tenantFields`, `allowPublic: [routes]`, `crossTenant: ['list' | 'get']`. `crossTenant` removes the tenant filter, authorizes nothing: the check must return a row `policy` (e.g. `{ status: 'active' }`) or every tenant's rows are published.

## Gotchas

1. `tenantField` is per resource (`companyId`, `workspaceId`, ...); the value always comes from `getOrgId(scope)`.
2. `kind: 'elevated'` without an org bypasses tenant filtering: unusable for normal per-org access.
3. Mark the tenant field `systemManaged` in `fieldRules`: `BodySanitizer` strips client values and the scope value is injected on write.
4. The preset overwrites a body-supplied org on UPDATE (blocks tenant hopping). Elevated without an org still bypasses.
5. `createTenantKeyGenerator()` (`@classytic/arc/scope`) keys rate limits by org for member/service/elevated, else user or IP.

## Helpers (`@classytic/arc/scope`)

```typescript
import {
  isMember, isService, isElevated, isAuthenticated, hasOrgAccess,    // guards
  getUserId, getClientId, getOrgId, getUserRoles, getOrgRoles,       // return undefined, never throw
  getServiceScopes, getTeamId, getScopeContext, getOrgContext,
  requireUserId, requireOrgId, requireClientId, requireTeamId,       // throw 403 / 401
  isOrgInScope, getAncestorOrgIds,                                   // explicit hierarchy checks
  PUBLIC_SCOPE, AUTHENTICATED_SCOPE, type RequestScope,
} from '@classytic/arc/scope';
```

Hierarchy: `scope.ancestorOrgIds` (closest first, loaded by your auth) plus `requireOrgInScope(...)` from `@classytic/arc/permissions`; there is no automatic inheritance.
