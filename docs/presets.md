# Presets

Reusable resource configurations. Add routes, middlewares, and schema options.

## Usage

```typescript
defineResource({
  name: 'post',
  presets: [
    'softDelete',                              // String form
    { name: 'ownedByUser', ownerField: 'authorId' },  // Object form with options
    'tree',
  ],
});
```

## Available Presets

### softDelete

Soft-delete instead of hard-delete. Adds routes to view/restore deleted items.

```typescript
presets: ['softDelete']
// Or with custom field:
presets: [{ name: 'softDelete', deletedField: 'isArchived' }]
```

**Added Routes:**
| Route | Permission Key | Description |
|-------|----------------|-------------|
| GET /deleted | `deleted` | List soft-deleted items |
| POST /:id/restore | `restore` | Restore deleted item |

**Controller Methods Required:** `getDeleted`, `restore`

---

### slugLookup

Lookup resources by slug instead of ID.

```typescript
presets: ['slugLookup']
// Or with custom field:
presets: [{ name: 'slugLookup', slugField: 'urlSlug' }]
```

**Added Routes:**
| Route | Permission Key | Description |
|-------|----------------|-------------|
| GET /slug/:slug | `getBySlug` | Get by slug |

**Controller Methods Required:** `getBySlug`

---

### tree

Hierarchical tree structures (categories, folders, etc.).

```typescript
presets: ['tree']
// Or with custom parent field:
presets: [{ name: 'tree', parentField: 'parentCategory' }]
```

**Added Routes:**
| Route | Permission Key | Description |
|-------|----------------|-------------|
| GET /tree | `tree` or `getTree` | Full hierarchical tree |
| GET /:parent/children | `children` or `getChildren` | Direct children |

**Controller Methods Required:** `getTree`, `getChildren`

---

### ownedByUser

Ownership enforcement. Users can only update/delete their own resources.

```typescript
presets: [{ name: 'ownedByUser', ownerField: 'authorId' }]
// With bypass roles:
presets: [{
  name: 'ownedByUser',
  ownerField: 'userId',
  bypassRoles: ['admin', 'moderator']
}]
```

**Behavior:**
- On update/delete, checks if `item[ownerField] === user.id`
- Returns 403 if ownership check fails
- Users with `bypassRoles` skip the check (default: `['admin', 'superadmin']`)

**No Additional Routes** - Adds middleware to update/delete operations.

---

### multiTenant

Multi-tenant data isolation by tenant/organization.

```typescript
presets: [{ name: 'multiTenant', tenantField: 'organizationId' }]
```

**Behavior:**
- Automatically filters queries by tenant
- Injects tenant ID on create
- Users with `bypassRoles` can access all tenants

---

### audited

Adds audit tracking (who created/updated).

```typescript
presets: ['audited']
```

**Behavior:**
- Sets `createdBy`, `updatedBy` fields from `request.user`
- Requires auth middleware to be active

---

## Permission Keys

Presets add permission keys to the `permissions` object:

```typescript
defineResource({
  name: 'category',
  presets: ['softDelete', 'tree'],
  permissions: {
    // CRUD
    list: [],
    create: ['admin'],
    update: ['admin'],
    delete: ['admin'],

    // softDelete preset
    deleted: ['admin'],
    restore: ['admin'],

    // tree preset (use semantic or handler name)
    tree: [],          // or getTree: []
    children: [],      // or getChildren: []
  },
});
```

## Custom Presets

Register your own presets:

```typescript
import { registerPreset } from '@classytic/arc/presets';

registerPreset('timestamped', (options = {}) => ({
  name: 'timestamped',
  middlewares: {
    create: [setCreatedAt],
    update: [setUpdatedAt],
  },
}));

// Use it
defineResource({
  presets: ['timestamped'],
});
```

## Preset Result Shape

```typescript
interface PresetResult {
  name: string;
  additionalRoutes?: AdditionalRoute[] | ((permissions) => AdditionalRoute[]);
  middlewares?: {
    list?: RouteHandler[];
    get?: RouteHandler[];
    create?: RouteHandler[];
    update?: RouteHandler[];
    delete?: RouteHandler[];
  };
  schemaOptions?: RouteSchemaOptions;
  controllerOptions?: { slugField?: string; parentField?: string };
}
```
