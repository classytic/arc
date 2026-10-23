# Permission checks, roles and scope helpers

```typescript
import {
  allowPublic, requireAuth, requireRoles, requireOwnership,
  requireOrgMembership, requireOrgRole, requireTeamMembership,
  requirePlatformRole, requireServiceScope,
  allOf, anyOf, not, when, denyAll, allow, deny, type PermissionCheck,
} from '@classytic/arc/permissions';
```

| Check | Passes when |
|---|---|
| `allowPublic()` | Always, no auth |
| `allowPublic({ policy })` | Always; rows narrowed by a filter or `(ctx) => filter` (`{}` = unrestricted; static `{}` throws; resolver returning non-object => 403) |
| `requireAuth()` | Any authenticated caller |
| `requireRoles(['admin'])` | A role matches. Checks global roles AND `scope.orgRoles` by default; options `{ bypassRoles, includeOrgRoles: false }` |
| `requirePlatformRole('ops')` | Global role only; an org role never satisfies it. Use for global surfaces (e.g. jobs management routes) |
| `requireOwnership('userId', { bypassRoles })` | Authenticated; adds policy `{ userId: <caller> }` |
| `requireOrgMembership()` | `member` scope |
| `requireOrgRole('admin', 'owner')` | Any listed role in `scope.orgRoles`; denies service scopes |
| `requireTeamMembership()` | `scope.teamId` set |
| `requireServiceScope('a:read')` | Service holds ANY listed scope |
| `allOf(a, b)` / `anyOf(a, b)` / `not(a)` | AND / OR (first granting branch wins) / negation |
| `denyAll(reason?)` | Never |

Elevated scope passes the scope-based checks.

`anyOf(allowPublic({ policy }), requireRoles('admin'))` filters admins too (a public branch grants everyone). Put the privileged branch first, or return `{}` for staff from a policy resolver.

## Custom check

```typescript
const requirePro = (): PermissionCheck => async (ctx) => {
  if (!ctx.user) return deny('Auth required');
  return ctx.user.plan === 'pro' ? allow() : deny('Pro plan required');
};
```

`allow({ policy, scope })` can add a row filter and install a scope (multi-tenancy.md). A custom public check must set `_isPublic` or anonymous callers get 401; prefer `allowPublic({ policy })`.

## Static and dynamic role matrices

```typescript
import { createOrgPermissions, createDynamicPermissionMatrix } from '@classytic/arc/permissions';

const perms = createOrgPermissions({
  statements: { product: ['create', 'update', 'delete'] },
  roles: { owner: { product: ['create', 'update', 'delete'] }, member: { product: [] } },
});
permissions: { create: perms.can({ product: ['create'] }) }

const acl = createDynamicPermissionMatrix({
  resolveRolePermissions: async (ctx) => aclService.getRoleMatrix(ctx),   // role -> resource -> actions[]
  cache: { ttlSeconds: 60 },                                              // or cacheStore: <CacheStore>
});
permissions: { list: acl.canAction('product', 'read') }
```

- Reads `scope.orgRoles`; elevated bypasses; `*` wildcards for resource/action; cache failures fall through to the resolver.
- `acl.invalidateByOrg(orgId)`, `acl.clearCache()`. Multi-node: `await acl.connectEvents(eventBus)` (after the events plugin is registered) so invalidations propagate; pass `fastify` in the config so the memory cache shows in the distributed-runtime audit.
- Also on the matrix: `requireRole(...)`, `requireMembership()`, `requireTeamMembership()`.

## Role hierarchy

```typescript
import { createRoleHierarchy } from '@classytic/arc/permissions';

const h = createRoleHierarchy({ superadmin: ['admin'], admin: ['branch_manager'] });
h.expand(['superadmin']);                  // ['superadmin', 'admin', 'branch_manager']
h.includes(['admin'], 'branch_manager');   // true
```

## Request scope

```typescript
import { getUserId, getUserRoles, getOrgId, getOrgRoles, getTeamId, requireOrgId, isMember } from '@classytic/arc/scope';
```

| Kind | Fields |
|---|---|
| `public` | none |
| `authenticated` | `userId?`, `userRoles?` |
| `member` | `userId?`, `userRoles`, `organizationId`, `orgRoles`, `teamId?`, `context?`, `ancestorOrgIds?` |
| `service` | `clientId`, `organizationId`, `scopes?`, `mandate?`, `dpopJkt?`, `context?`, `ancestorOrgIds?` |
| `elevated` | `userId?`, `organizationId?`, `elevatedBy`, `context?`, `ancestorOrgIds?` |

Two role layers: global roles (`scope.userRoles`, from `user.role`) and org roles (`scope.orgRoles`, from membership). `requireOrgRole` checks only the second.

## Elevation (platform admin)

```typescript
createApp({ elevation: { platformRoles: ['superadmin'], onElevation: (e) => audit.write(e) } });
```

A platform-role user sends `x-arc-scope: platform` (optionally `x-organization-id`) to get `kind: 'elevated'`. Header names are configurable (`scopeHeader`, `orgHeader`).

## Custom routes outside a resource

No org middleware ships. Write a one-line `preHandler` that throws when `getOrgId(request.scope)` is undefined, or call `requireOrgId(request.scope)` (throws 403).
