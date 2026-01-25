# Org Module

Multi-tenant organization scoping for SaaS applications.

## Quick Start

```typescript
import { createApp } from '@classytic/arc/factory';
import { defineResource, requireAuth } from '@classytic/arc';

const app = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  org: {
    header: 'x-organization-id',       // Header name
    bypassRoles: ['superadmin'],        // Roles that skip validation
  },
});

// Define multi-tenant resource
const orderResource = defineResource({
  name: 'order',
  organizationScoped: true,  // Enable org scoping
  presets: ['multiTenant'],  // Auto-filter by organizationId
  permissions: {
    list: requireAuth(),
    create: requireAuth(),
  },
});

await app.register(orderResource.toPlugin());
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

## Request Context

Organization data available in `req`:

```typescript
import type { IRequestContext, IControllerResponse } from '@classytic/arc';

class OrderController extends BaseController {
  async list(req: IRequestContext): Promise<IControllerResponse> {
    const { organizationId, user, metadata } = req;

    // Verify user access (done automatically by org scope middleware)
    const hasAccess = user?.organizations?.some(
      (org) => org.organizationId === organizationId
    );

    if (!hasAccess) {
      return { success: false, error: 'Forbidden', status: 403 };
    }

    // Query scoped to org
    const orders = await this.repository.findAll({
      filter: { organizationId },
    });

    return { success: true, data: orders };
  }
}
```

### Organization Metadata

The org scope plugin adds metadata to `req.metadata`:

```typescript
interface OrgMetadata {
  orgScope: 'public' | 'global' | 'member' | 'bypass' | 'none' | 'explicit';
  orgRoles?: string[];       // User's roles in this org
  bypassReason?: string;     // Why bypass was allowed
}
```

**Access via:**

```typescript
async list(req: IRequestContext): Promise<IControllerResponse> {
  const orgScope = req.metadata?.orgScope;
  const orgRoles = req.metadata?.orgRoles;

  console.log('Org scope:', orgScope);      // 'member' | 'bypass' | etc.
  console.log('Org roles:', orgRoles);      // ['admin', 'manager']
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

## User Organization Structure

```typescript
// User must have organizations array
const user = {
  _id: 'user-123',
  email: 'user@example.com',
  roles: ['user'],
  organizations: [
    { organizationId: 'org-123', roles: ['member', 'manager'] },
    { organizationId: 'org-456', roles: ['member'] },
  ],
};
```

## Automatic Data Filtering

With `multiTenant` preset, BaseController automatically filters:

```typescript
// GET /orders with x-organization-id: org-123
// Internally becomes:
repository.findAll({ filter: { organizationId: 'org-123' } });

// POST /orders with x-organization-id: org-123
// Automatically sets:
data.organizationId = 'org-123';
```

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
const isMember = orgMembershipCheck(user, 'org-123');  // true/false

// Get user's roles in org
const roles = getOrgRoles(user, 'org-123');  // ['member', 'manager']

// Check specific role
const isManager = hasOrgRole(user, 'org-123', 'manager');  // true/false
```

## Manual Setup (Without Factory)

```typescript
import Fastify from 'fastify';
import { orgScopePlugin } from '@classytic/arc/org';

const fastify = Fastify();

await fastify.register(orgScopePlugin, {
  header: 'x-organization-id',
  bypassRoles: ['superadmin'],
});
```

## Example: Full Multi-Tenant Resource

```typescript
import { defineResource, createMongooseAdapter, requireAuth } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';

// Controller
class InvoiceController extends BaseController {
  async list(req: IRequestContext): Promise<IControllerResponse> {
    const { organizationId, user, metadata } = req;

    // Check org metadata
    const { orgScope, orgRoles } = metadata || {};
    console.log('Scope:', orgScope);       // 'member'
    console.log('Roles:', orgRoles);       // ['admin']

    // Query scoped to org (automatic with multiTenant preset)
    const invoices = await this.repository.findAll({
      filter: { organizationId },
    });

    return { success: true, data: invoices };
  }

  async create(req: IRequestContext): Promise<IControllerResponse> {
    const { organizationId, user } = req;

    // Verify user has required org role
    const orgRoles = req.metadata?.orgRoles || [];
    if (!orgRoles.includes('admin')) {
      return { success: false, error: 'Requires admin role', status: 403 };
    }

    // Create with org scope (automatic)
    const invoice = await this.repository.create({
      ...req.body,
      organizationId,  // Auto-set by multiTenant preset
    });

    return { success: true, data: invoice };
  }
}

// Resource definition
const invoiceResource = defineResource({
  name: 'invoice',
  adapter: createMongooseAdapter({ model: Invoice, repository: invoiceRepo }),
  controller: new InvoiceController(invoiceRepo),
  presets: ['multiTenant', 'softDelete'],
  organizationScoped: true,  // Required for multiTenant
  permissions: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: requireAuth(),
    delete: requireAuth(),
  },
});
```

## Making Requests

```bash
# List invoices for org-123
curl http://localhost:3000/invoices \
  -H "Authorization: Bearer <token>" \
  -H "x-organization-id: org-123"

# Create invoice for org-123
curl -X POST http://localhost:3000/invoices \
  -H "Authorization: Bearer <token>" \
  -H "x-organization-id: org-123" \
  -H "Content-Type: application/json" \
  -d '{"amount": 1000, "customer": "customer-id"}'
```

## Bypass for Superadmins

```typescript
// User with bypass role
const superadmin = {
  _id: 'admin-123',
  roles: ['superadmin'],  // Bypass role
  organizations: [],       // No org membership needed
};

// Can access any org
// GET /invoices with x-organization-id: any-org-id
// Works even if user is not a member
```

## Best Practices

1. **Always use organizationScoped: true** - For multi-tenant resources
2. **Combine with multiTenant preset** - Automatic filtering
3. **Validate org membership** - Even with automatic scoping
4. **Use org roles for fine-grained access** - Admin, manager, member
5. **Test with different org contexts** - Ensure isolation works
6. **Never trust client-provided org IDs** - Validate against user.organizations

## Common Patterns

### Org-Scoped Aggregations

```typescript
async getStats(req: IRequestContext): Promise<IControllerResponse> {
  const { organizationId } = req;

  const stats = await Order.aggregate([
    { $match: { organizationId } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  return { success: true, data: stats };
}
```

### Cross-Org Queries (Superadmin)

```typescript
async listAll(req: IRequestContext): Promise<IControllerResponse> {
  const { user, metadata } = req;

  // Check if bypass
  if (metadata?.orgScope !== 'bypass') {
    return { success: false, error: 'Superadmin only', status: 403 };
  }

  // Query all orgs
  const invoices = await this.repository.findAll({
    // No organizationId filter
  });

  return { success: true, data: invoices };
}
```

## See Also

- [Auth Module](./auth.md) - Authentication and permissions
- [Presets](./presets.md) - multiTenant preset
- [Core Module](./core.md) - Request context
