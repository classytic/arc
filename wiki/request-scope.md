# RequestScope

**Summary**: `RequestScope` is a discriminated union on `kind` describing the current request's auth state. Always use accessors; never read properties directly.
**Sources**: src/scope/.
**Last updated**: 2026-04-21.

---

## Kinds

| `kind` | Meaning |
|---|---|
| `public` | Unauthenticated |
| `authenticated` | User identified, not org-bound |
| `member` | Org member (human) |
| `service` | API-key / machine-to-machine |
| `elevated` | Platform-level admin (via `x-arc-scope: platform`) |

All org-bound kinds (`member`, `service`, `elevated`) carry optional `context?: Readonly<Record<string, string>>` for app dimensions (branchId, region) and `ancestorOrgIds?: readonly string[]` for parent-child org chains.

## Accessors

Always import from `@classytic/arc/scope`:

```ts
import {
  getUserId, getUserRoles, getOrgId, getServiceScopes,
  getScopeContext, getAncestorOrgIds, hasOrgAccess,
} from '@classytic/arc/scope';

getUserId(scope);                    // works for all kinds
getUserRoles(scope);                 // string[]
getOrgId(scope);                     // member | service | elevated
getServiceScopes(scope);             // service only
getScopeContext(scope, 'branchId');  // custom dimension
getAncestorOrgIds(scope);            // always returns array
hasOrgAccess(scope);                 // member | service | elevated
```

Never reach into `scope.userId` or `scope.organizationId` directly — shape changes with `kind`, the accessors hide that.

## Elevation

`x-arc-scope: platform` upgrades `member` → `elevated` if permission granted. Every successful elevation emits `arc.scope.elevated` on `fastify.events` (v2.9). Subscribe for audit; `onElevation` callback still works. See [[gotchas]] #12.

## Related
- [[auth]] — populates scope
- [[permissions]] — consumes scope
- [[events]] — `arc.scope.elevated` audit event
