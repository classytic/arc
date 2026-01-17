# Core Module

The foundation: resource definition and CRUD routing.

## defineResource

Single entry point for defining resources.

```typescript
import { defineResource } from '@classytic/arc';

import { allowPublic, requireRoles } from '@classytic/arc';

const resource = defineResource({
  // Required
  name: 'product',
  adapter: createMongooseAdapter({ model: Product, repository: productRepository }),
  controller: productController,

  // Optional
  prefix: '/products',         // Route prefix (default: /{name}s)
  displayName: 'Products',     // UI/docs name
  tag: 'Products',             // OpenAPI tag

  // Features
  presets: ['softDelete', 'slugLookup'],
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
  organizationScoped: true,

  // Advanced
  skipValidation: false,       // Bypass config validation
  disableDefaultRoutes: false, // Only use additionalRoutes
});

// Register with Fastify
fastify.register(resource.toPlugin());
```

## BaseController

Standard CRUD with built-in features.

```typescript
import { BaseController } from '@classytic/arc';
import { Repository } from '@classytic/mongokit'; // Or your chosen database kit

class ProductController extends BaseController {
  constructor(repository: Repository) {
    super(repository);
  }

  // Override for custom logic
  async create(context) {
    if (!context.body.sku) {
      return { success: false, error: 'SKU required', status: 400 };
    }
    return super.create(context);
  }
}
```

### Built-in Methods

| Method | Route | Description |
|--------|-------|-------------|
| `getAll` | GET / | List with pagination, filtering, sorting |
| `getById` | GET /:id | Get single item |
| `create` | POST / | Create new item |
| `update` | PATCH /:id | Partial update |
| `delete` | DELETE /:id | Delete item |

### Query Features

Arc parses query parameters automatically:

```
GET /products?price[gte]=100&price[lte]=500   # Operators
GET /products?sort=-createdAt,name            # Sorting
GET /products?search=keyword                  # Search
GET /products?page=2&limit=20                 # Pagination
GET /products?populate=category,brand         # Relations
```

> **Tip:** QueryParser comes from your database kit (MongoKit, PrismaKit, etc.)

### Custom Query Parser

```typescript
import { QueryParser } from '@classytic/mongokit'; // Or your database kit

// Option 1: In controller
class ProductController extends BaseController {
  constructor(repository) {
    super(repository, { queryParser: new QueryParser() });
  }
}

// Option 2: In defineResource
defineResource({
  name: 'product',
  queryParser: new QueryParser(),
});
```

### Built-in Features

- **Ownership enforcement** - `ownedByUser` preset blocks unauthorized access
- **Organization scoping** - Automatic tenant filtering
- **Pagination** - `{ data, pagination }` response format
- **Consistent errors** - Standard error response format

## Additional Routes

Add custom routes beyond CRUD:

```typescript
import { requireRoles, allowPublic } from '@classytic/arc';

defineResource({
  name: 'product',
  additionalRoutes: [
    {
      method: 'POST',
      path: '/import',
      handler: 'importProducts',       // Controller method name
      permissions: requireRoles(['admin']),
      wrapHandler: true,               // Required: true=controller handler
      summary: 'Bulk import',
    },
    {
      method: 'GET',
      path: '/stats',
      handler: async (req, reply) => { // Fastify handler
        return reply.send({ success: true, data: await getStats() });
      },
      permissions: allowPublic(),
      wrapHandler: false,              // Required: false=Fastify handler
    },
  ],
});
```

## Validation

Arc validates configs at definition time (fail-fast):

```typescript
defineResource({
  name: 'product',
  repository: null,  // ← Throws immediately
  controller: productController,
});

// Error:
// Resource "product" validation failed:
// ERRORS:
//   ✗ repository: Repository is required
```

**Validated:**
- Required fields (name, repository, controller)
- Controller methods exist
- Preset names are valid
- Permission keys match routes

## createCrudRouter (Advanced)

Low-level route creation. Used internally by defineResource.

> **Warning:** When using `createCrudRouter` directly (instead of `defineResource`), you MUST provide the `resourceName` option, otherwise lifecycle hooks will not execute. If you need hooks, use `defineResource()` instead.

```typescript
import { createCrudRouter } from '@classytic/arc';

createCrudRouter(fastify, controller, {
  resourceName: 'product',  // ⚠️ Required for hooks to work!
  tag: 'Products',
  schemas: crudSchemas,
  auth: { create: ['admin'] },
  middlewares: { create: [validateProduct] },
  additionalRoutes: [...],
});
```

**Why `defineResource` is recommended:**
- Automatically sets `resourceName` for hook execution
- Provides validation of config at definition time
- Centralized resource registration
- Better TypeScript integration
