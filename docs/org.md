# Org Module

Multi-tenant organization scoping for SaaS applications.

## Setup

```typescript
import { orgScopePlugin } from '@classytic/arc/org';

await fastify.register(orgScopePlugin, {
  header: 'x-organization-id',
  bypassRoles: ['superadmin'],
});
```

## Configuration

```typescript
interface OrgScopeOptions {
  header?: string;           // Header name (default: 'x-organization-id')
  bypassRoles?: string[];    // Roles that skip validation (default: ['superadmin'])
  userOrgsPath?: string;     // Path to user's orgs array (default: 'organizations')
  validateMembership?: (user, orgId) => boolean;  // Custom validation
}
```

## Philosophy

**"Lenient with Public, Strict with Authenticated"**

| Route Type | Behavior |
|------------|----------|
| Public (no auth) | Allow without org filter |
| Authenticated | Validate org membership, filter data |
| Admin (bypass role) | Access any org |

## Enable on Resources

```typescript
defineResource({
  name: 'order',
  organizationScoped: true,  // Enable org scoping
  permissions: {
    list: ['user'],
    create: ['user'],
  },
});
```

## Request Context

When org scoping is enabled, `request.context` contains:

```typescript
interface RequestContext {
  organizationId?: string;
  orgScope: 'public' | 'global' | 'member' | 'bypass' | 'none' | 'explicit';
  orgRoles?: string[];
  bypassReason?: string;
}
```

## Scope Types

| Scope | Meaning |
|-------|---------|
| `public` | No auth required, no org filter |
| `member` | User is member of org |
| `bypass` | User has bypass role (superadmin) |
| `global` | Org not required for this route |
| `explicit` | Org explicitly set |

## Guards

For route-level org enforcement:

```typescript
import { orgGuard, requireOrg, requireOrgRole } from '@classytic/arc/org';

// Require org header
fastify.get('/orders', {
  preHandler: [fastify.authenticate, requireOrg()],
  handler: listOrders,
});

// Require specific org role
fastify.post('/orders', {
  preHandler: [fastify.authenticate, requireOrgRole('manager')],
  handler: createOrder,
});
```

## Membership Utilities

```typescript
import { orgMembershipCheck, getOrgRoles, hasOrgRole } from '@classytic/arc/org';

// Check if user is member of org
const isMember = orgMembershipCheck(user, 'org-123');

// Get user's roles in org
const roles = getOrgRoles(user, 'org-123');  // ['member', 'manager']

// Check specific role
const isManager = hasOrgRole(user, 'org-123', 'manager');  // true/false
```

## Data Filtering

BaseController automatically filters by org when enabled:

```typescript
// GET /orders with x-organization-id: org-123
// Internally becomes:
repository.getAll({ filters: { organizationId: 'org-123' } });

// POST /orders with x-organization-id: org-123
// Automatically sets:
data.organizationId = 'org-123';
```

## User Organization Structure

```typescript
// User must have organizations array
const user = {
  _id: 'user-123',
  roles: ['user'],
  organizations: [
    { organizationId: 'org-123', roles: ['member', 'manager'] },
    { organizationId: 'org-456', roles: ['member'] },
  ],
};
```
