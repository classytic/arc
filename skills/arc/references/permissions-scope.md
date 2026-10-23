# Permissions and RequestScope

## PermissionCheck

A check returns `boolean | AuthorizationDecision`. Build decisions with `allow({ policy?, scope? })` and `deny(reason?)`: `policy` is ANDed into the repository query (row-level), `scope` stamps attributes downstream.

```typescript
import {
  allOf, allow, allowPublic, anyOf, deny, denyAll, requireAuth, requireOrgRole, requireOwnership,
  requireRoles, requireServiceScope, when, type PermissionCheck,
} from '@classytic/arc/permissions';

permissions: {
  list: allowPublic({ policy: { status: 'published' } }),     // public but row-filtered
  create: requireRoles(['admin', 'editor']),
  update: anyOf(requireOwnership('userId'), requireRoles(['admin'])),
  delete: allOf(requireAuth(), requireRoles(['admin'])),
  bulkImport: anyOf(requireOrgRole('admin'), requireServiceScope('jobs:bulk-write')),
}

const requirePro = (): PermissionCheck => async (ctx) =>
  !ctx.user ? deny('Auth required') : ctx.user.plan === 'pro' ? allow() : deny('Pro plan required');
```

- Public + row filter: use `allowPublic({ policy })`. A hand-written `allow({ policy })` lacks the public flag and anonymous callers get 401.
- `policy` may be a function `(ctx) => filter`; `{}` means unrestricted.
- `requireRoles()` checks platform roles (`user.role`, singular: string, comma list or array) AND org roles (`scope.orgRoles`).
- Dynamic DB-backed ACL: `createDynamicPermissionMatrix({ resolveRolePermissions, cacheStore })`, then `acl.canAction('product', 'read')`.
- Quotas: `requireQuota({ kind, limit })` (needs `usagePlugin`). Agent mandates: `requireAgentScope`, `requireMandate`, `requireDPoP`.
- `isRevoked` errors deny (fail-closed).

## Field-level

```typescript
import { fields } from '@classytic/arc/permissions';
fields: {
  password: fields.hidden(),
  salary: fields.visibleTo(['admin', 'hr']),
  role: fields.writableBy(['admin']),
  email: fields.redactFor(['viewer'], '***'),
}
```

## RequestScope

Discriminated on `kind`: `public`, `authenticated`, `member`, `service`, `elevated`. Always read through accessors from `@classytic/arc/scope`, never properties.

```typescript
import { getOrgId, getUserId, hasOrgAccess, isElevated, isMember, isService,
         requireClientId, requireOrgId, requireTeamId, requireUserId } from '@classytic/arc/scope';

const orgId = requireOrgId(req.scope);   // 403 ArcError when absent
const userId = getUserId(req.scope);     // string | undefined
```

| Throwing accessor | Status when missing |
|---|---|
| `requireUserId`, `requireClientId` | 401 |
| `requireOrgId`, `requireTeamId` | 403 |

| Helper | member | service | elevated |
|---|---|---|---|
| `requireOrgMembership()` | yes | yes | yes |
| `requireOrgRole(roles)` | role match | no | bypass |
| `requireServiceScope(scopes)` | no | scope match | bypass |
| `requireTeamMembership()` | `teamId` set | n/a | bypass |
| `requireOrgInScope(target)` | in chain | in chain | bypass |

Populate `scope.context` and `scope.ancestorOrgIds` in your auth function for branch or parent-child scoping; `multiTenantPreset({ tenantFields })` then filters every dimension. See `references/tenancy-*.md` / multi-tenancy references for the ladder.

## Auth wiring

```typescript
auth: { type: 'jwt', jwt: { secret, expiresIn: '15m' } }
auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth }) }
auth: { type: 'custom', plugin: myAuthPlugin }
auth: { type: 'authenticator', authenticate: async (req, reply) => {} }
auth: false
```

Decorates `app.authenticate`, `app.optionalAuthenticate`, `app.authorize`. Better Auth stores `member.role = "admin,recruiter"`; arc splits it into `scope.orgRoles`, so filter with `role[like]=admin`.
