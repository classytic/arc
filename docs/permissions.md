# Permission System

Flexible, pluggable permission system that supports:
- Built-in role-based access control (RBAC)
- Custom permission providers (ABAC, Casbin, etc.)
- Permission helpers for common patterns
- Dynamic permissions based on data
- Multi-tenant isolation

---

## Quick Start

### Basic Permissions

```typescript
import { defineResource, allowPublic, requireAuth, requireRoles } from '@classytic/arc';

defineResource({
  name: 'post',
  permissions: {
    list: allowPublic(),                       // No auth required
    get: allowPublic(),                        // No auth required
    create: requireAuth(),                     // Any authenticated user
    update: requireRoles(['editor', 'admin']), // Specific roles
    delete: requireRoles(['admin']),           // Admins only
  },
});
```

### Ownership-Based Permissions

```typescript
import { requireOwnership, requireRoles, anyOf } from '@classytic/arc/permissions';

defineResource({
  name: 'post',
  permissions: {
    list: requireAuth(),
    create: requireAuth(),
    update: anyOf(
      requireOwnership('authorId'),  // Owner can update
      requireRoles(['admin'])        // OR admin can update
    ),
    delete: requireRoles(['admin']),
  },
});
```

---

## Permission Helpers

### `requireAuth()`

Require authentication (any authenticated user).

```typescript
permissions: {
  list: requireAuth(),
  get: requireAuth(),
}
```

### `requireRoles(roles, options?)`

Require specific roles.

```typescript
permissions: {
  create: requireRoles(['admin', 'editor']),
  delete: requireRoles(['admin']),
}
```

**Options:**
- `bypassRoles`: Roles that bypass this check (no default — must be explicit)

```typescript
permissions: {
  update: requireRoles(['manager'], {
    bypassRoles: ['superadmin', 'owner'],
  }),
}
```

### `requireOwnership(ownerField, options?)`

Require resource ownership (user can only access their own resources).

```typescript
permissions: {
  update: requireOwnership('createdBy'),
  delete: requireOwnership('userId'),
}
```

**Options:**
- `bypassRoles`: Roles that bypass ownership check (no default — must be explicit)

```typescript
permissions: {
  update: requireOwnership('authorId', {
    bypassRoles: ['admin', 'moderator'],
  }),
}
```

**How it works:**
1. For `list`/`create`: Adds ownership filter automatically
2. For `get`/`update`/`delete`: Checks ownership after fetching resource
3. Returns 403 if ownership check fails
4. Bypass roles skip the check

### `allowPublic()`

Allow public access (no authentication required).

```typescript
permissions: {
  list: allowPublic(),
  get: allowPublic(),
}
```

### `denyAll(reason?)`

Deny all access (useful for disabling specific operations).

```typescript
permissions: {
  delete: denyAll('Deletion not allowed for this resource'),
}
```

---

## Combining Permissions

### `allOf(...checks)`

Combine multiple checks with AND logic (all must pass).

```typescript
import { allOf, requireAuth, requireRoles, requireOwnership } from '@classytic/arc/permissions';

permissions: {
  update: allOf(
    requireAuth(),                // Must be authenticated
    requireRoles(['editor']),     // AND be an editor
    requireOwnership('authorId')  // AND own the resource
  ),
}
```

### `anyOf(...checks)`

Combine checks with OR logic (any check passes).

```typescript
import { anyOf, requireRoles, requireOwnership } from '@classytic/arc/permissions';

permissions: {
  update: anyOf(
    requireRoles(['admin']),      // Admin can update anything
    requireOwnership('authorId')  // OR author can update their own
  ),
}
```

---

## Dynamic Permissions

### Data-Based Permissions

Check permissions based on resource data. Any `PermissionCheck` function works:

```typescript
import type { PermissionCheck } from '@classytic/arc/permissions';

permissions: {
  update: (async (context) => {
    // Only allow updates if status is 'draft'
    return context.data?.status === 'draft';
  }) as PermissionCheck,
}
```

### Complex Business Logic

```typescript
const requireQuota = (): PermissionCheck => async (context) => {
  const count = await getPublishedCount(context.user.id);
  return count < context.user.maxPosts;
};

permissions: {
  publish: allOf(
    requireRoles(['editor', 'admin']),
    requireQuota(),
  ),
}
```

---

## Custom Permission Patterns

Arc's permission system is function-based — any `PermissionCheck` works. For complex RBAC/ABAC, write custom permission functions.

### Using Casbin

```typescript
import type { PermissionCheck } from '@classytic/arc/permissions';
import { newEnforcer } from 'casbin';

const enforcer = await newEnforcer('model.conf', 'policy.csv');

const requireCasbinAccess = (): PermissionCheck => async (context) => {
  const allowed = await enforcer.enforce(
    context.user?.id ?? 'anonymous',
    context.resource,
    context.action
  );
  return { granted: allowed };
};

defineResource({
  name: 'document',
  permissions: {
    list: requireCasbinAccess(),
    create: requireCasbinAccess(),
    update: requireCasbinAccess(),
    delete: requireCasbinAccess(),
  },
});
```

### Custom RBAC Service

```typescript
import type { PermissionCheck } from '@classytic/arc/permissions';
import { rbacService } from './services/rbac';

const requireRbac = (): PermissionCheck => async (context) => {
  const { user, resource, action } = context;
  const allowed = await rbacService.can(user, action, resource);

  return {
    granted: allowed,
    filters: allowed ? undefined : {},
    reason: allowed ? undefined : 'Access denied by RBAC',
  };
};

defineResource({
  name: 'invoice',
  permissions: {
    list: requireRbac(),
    create: requireRbac(),
  },
});
```

### Attribute-Based Access Control (ABAC)

```typescript
import type { PermissionCheck } from '@classytic/arc/permissions';

const requireAbac = (): PermissionCheck => async (context) => {
  const { user, data } = context;

  const rules = [
    user?.department === data?.department,
    user?.role === 'manager' && user?.region === data?.region,
    user?.role === 'admin',
  ];

  return { granted: rules.some(rule => rule === true) };
};
```

---

## Permission Context

Every permission check receives a `PermissionContext` object:

```typescript
interface PermissionContext {
  /** Authenticated user or null if unauthenticated */
  user: UserBase | null;

  /** Request object for additional context */
  request: FastifyRequest;

  /** Resource being accessed (e.g., 'post', 'user') */
  resource: string;

  /** Action being performed (e.g., 'list', 'create', 'update') */
  action: string;

  /** Resource ID (for get/update/delete) */
  resourceId?: string;

  /** Optional: The data being accessed/modified */
  data?: Record<string, unknown>;

  /** Organization context (for multi-tenant) */
  organizationId?: string;
}
```

**Example using context:**

```typescript
import type { PermissionCheck } from '@classytic/arc/permissions';

const requireBusinessHours = (): PermissionCheck => async (context) => {
  // Access request headers
  const apiKey = context.request.headers['x-api-key'];

  // Check time-based rules
  const hour = new Date().getHours();
  const isDuringBusinessHours = hour >= 9 && hour <= 17;

  // Check IP whitelist
  const clientIp = context.request.ip;
  const isWhitelisted = await ipWhitelist.check(clientIp);

  return isDuringBusinessHours && isWhitelisted;
};
```

---

## Permission Results

Permission checks can return:

1. **Boolean:** Simple yes/no
```typescript
return true; // Granted
return false; // Denied
```

2. **PermissionResult:** Advanced control
```typescript
return {
  granted: true,
  filters: { organizationId: user.orgId }, // Apply filters
  reason: 'Access denied by policy', // Reason for denial
};
```

### Applying Filters

Filters are automatically merged into queries:

```typescript
permissions: {
  list: (context) => ({
    granted: true,
    filters: {
      // User can only see their own organization's data
      organizationId: context.user?.organizationId,
      // And only active records
      status: 'active',
    },
  }),
}
```

---

## Multi-Tenant Permissions

Combine permissions with multi-tenant isolation:

```typescript
import { requireAuth, requireRoles } from '@classytic/arc/permissions';

defineResource({
  name: 'invoice',
  presets: ['multiTenant'], // Auto-filter by organizationId
  organizationScoped: true,
  
  permissions: {
    list: requireAuth(),           // Any authenticated user in their org
    create: requireRoles(['admin', 'finance']), // Admins/finance in their org
    update: requireRoles(['admin', 'finance']),
    delete: requireRoles(['admin']),
  },
});
```

**Superadmin bypass:**

```typescript
permissions: {
  list: requireRoles(['member'], {
    bypassRoles: ['superadmin'], // Superadmins see all orgs
  }),
}
```

---

## Permission Functions

Arc uses **function-based permissions** for type safety and composability.

### Standard Pattern

```typescript
import { allowPublic, requireRoles, requireAuth } from '@classytic/arc/permissions';

permissions: {
  list: allowPublic(),                      // No authentication required
  get: allowPublic(),
  create: requireRoles(['admin', 'editor']), // Specific roles required
  update: requireRoles(['admin']),
  delete: requireRoles(['admin']),
}
```

### Why Functions?

1. **Type-safe** - TypeScript catches mistakes at compile time
2. **Composable** - Combine with `allOf()`, `anyOf()`
3. **Testable** - Permission logic can be unit tested
4. **Explicit** - No magic, clear intent

---

## Best Practices

### 1. Use Helpers for Clarity

❌ **Don't:**
```typescript
permissions: {
  update: [],
}
```

✅ **Do:**
```typescript
permissions: {
  update: allowPublic(),
}
```

### 2. Combine Permissions Logically

```typescript
permissions: {
  update: allOf(
    requireAuth(),
    anyOf(
      requireRoles(['admin']),
      requireOwnership('authorId')
    )
  ),
}
```

### 3. Document Custom Permissions

```typescript
const requireQuota = (): PermissionCheck => async (ctx) => {
  const quota = await getQuota(ctx.user.id);
  return quota.remaining > 0;
};

permissions: {
  // Only allow publishing if user has available quota
  publish: allOf(
    requireRoles(['editor']),
    requireQuota(),
  ),
}
```

### 4. Extract Custom Checks into Named Functions

For complex RBAC/ABAC logic, write reusable `PermissionCheck` functions instead of inline logic.

### 5. Test Permissions Thoroughly

```typescript
import { createTestApp } from '@classytic/arc/testing';

describe('Post permissions', () => {
  it('should deny unauthenticated users', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      payload: { title: 'Test' },
    });
    expect(res.statusCode).toBe(401);
  });
  
  it('should allow editors to create posts', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: { Authorization: `Bearer ${editorToken}` },
      payload: { title: 'Test' },
    });
    expect(res.statusCode).toBe(201);
  });
});
```

---

## API Reference

### Helpers

| Helper | Description |
|--------|-------------|
| `allowPublic()` | Allow public access |
| `requireAuth()` | Require authentication |
| `requireRoles(roles, options?)` | At least one role matches |
| `requireOwnership(field, options?)` | Require resource ownership |
| `denyAll(reason?)` | Deny all access |
| `allOf(...checks)` | AND — all must pass |
| `anyOf(...checks)` | OR — any can pass |
| `when(condition)` | Conditional — returns PermissionCheck |

### Org Permissions

| Helper | Description |
|--------|-------------|
| `requireOrgMembership(options?)` | Require org membership |
| `requireOrgRole(...roles)` | Require org-level roles |
| `createOrgPermissions(config)` | Create org permission helpers |

---

## Examples

See [examples/custom-auth-providers.ts](../examples/custom-auth-providers.ts) for complete examples:
- OAuth integration
- Casbin RBAC
- Custom permission logic
- Multi-factor authentication
- IP-based restrictions
