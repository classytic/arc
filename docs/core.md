# Core Module

Resources, controllers, and routing fundamentals.

## defineResource

Single entry point for defining resources.

```typescript
import { defineResource, createMongooseAdapter, allowPublic, requireRoles } from '@classytic/arc';

const productResource = defineResource({
  // Required
  name: 'product',
  adapter: createMongooseAdapter({ model: Product, repository: productRepo }),
  controller: productController,

  // Optional
  prefix: '/products',         // Route prefix (default: /{name}s)
  displayName: 'Products',     // UI/docs name
  tag: 'Products',             // OpenAPI tag

  // Presets
  presets: ['softDelete', 'slugLookup'],

  // Permissions (functions, not arrays)
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },

  // Multi-tenant
  organizationScoped: true,

  // Advanced
  skipValidation: false,       // Bypass config validation
  disableDefaultRoutes: false, // Only use additionalRoutes
});

// Register with Fastify
await fastify.register(productResource.toPlugin());
```

## BaseController

Standard CRUD with built-in features.

```typescript
import { BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';

class ProductController extends BaseController {
  constructor(repository) {
    super(repository);
  }

  // Override CRUD methods
  async create(req: IRequestContext): Promise<IControllerResponse> {
    // Custom validation
    if (!req.body.sku) {
      return { success: false, error: 'SKU required', status: 400 };
    }

    // Call parent implementation
    return super.create(req);
  }

  // Custom methods
  async getFeatured(req: IRequestContext): Promise<IControllerResponse> {
    const { organizationId, user } = req;

    const products = await this.repository.findAll({
      filter: { isFeatured: true, organizationId },
    });

    return { success: true, data: products };
  }
}
```

### Built-in CRUD Methods

| Method | Route | Signature |
|--------|-------|-----------|
| `list` | GET / | `async list(req: IRequestContext): Promise<IControllerResponse>` |
| `get` | GET /:id | `async get(req: IRequestContext): Promise<IControllerResponse>` |
| `create` | POST / | `async create(req: IRequestContext): Promise<IControllerResponse>` |
| `update` | PATCH /:id | `async update(req: IRequestContext): Promise<IControllerResponse>` |
| `delete` | DELETE /:id | `async delete(req: IRequestContext): Promise<IControllerResponse>` |

### Request Context API

```typescript
interface IRequestContext {
  params: Record<string, string>;           // Route params: /users/:id
  query: Record<string, unknown>;           // Query string: ?page=1&limit=10
  body: unknown;                            // Request body (POST/PATCH/PUT)
  user: UserBase | null;                    // Authenticated user (or null)
  headers: Record<string, string | undefined>; // Request headers
  organizationId?: string;                  // Multi-tenant org ID
  metadata?: Record<string, unknown>;       // Custom data from hooks/policies
}
```

**Key Fields:**

- `req.metadata` - Populated by hooks, policies, or middleware. Use for passing custom data between layers.
- `req.organizationId` - Set automatically by `multiTenant` preset or org scope plugin.
- `req.user` - Set by auth plugin. Preserves original auth structure (no role normalization).

### Response Format

```typescript
interface IControllerResponse<T> {
  success: boolean;                      // true/false
  data?: T;                              // Response payload
  error?: string;                        // Error message
  status?: number;                       // HTTP status (default: 200/400)
  meta?: Record<string, unknown>;        // Pagination, counts, etc.
  details?: Record<string, unknown>;     // Debug info
}
```

### Query Features

Arc parses query parameters automatically:

```bash
# Operators
GET /products?price[gte]=100&price[lte]=500

# Sorting
GET /products?sort=-createdAt,name

# Search
GET /products?search=keyword

# Pagination
GET /products?page=2&limit=20

# Relations
GET /products?populate=category,brand
```

Query parsing comes from your database kit (MongoKit, PrismaKit, etc.).

## Additional Routes

Add custom routes beyond CRUD.

```typescript
import { requireRoles, allowPublic } from '@classytic/arc';
import type { FastifyRequest, FastifyReply } from 'fastify';

defineResource({
  name: 'product',
  controller: productController,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/featured',
      handler: 'getFeatured',       // Controller method (Arc context)
      permissions: allowPublic(),
      wrapHandler: true,             // IRequestContext pattern
      summary: 'Get featured products',
    },
    {
      method: 'GET',
      path: '/:id/download',
      handler: 'downloadFile',       // Fastify native handler
      permissions: requireAuth(),
      wrapHandler: false,            // Fastify request/reply
      summary: 'Download product file',
    },
    {
      method: 'POST',
      path: '/import',
      handler: async (req: IRequestContext) => {
        // Inline handler (Arc context)
        const result = await importProducts(req.body);
        return { success: true, data: result };
      },
      permissions: requireRoles(['admin']),
      wrapHandler: true,
    },
  ],
});
```

### Handler Patterns

**Arc Context Pattern** (`wrapHandler: true`):

```typescript
class ProductController extends BaseController {
  async getFeatured(req: IRequestContext): Promise<IControllerResponse> {
    const { organizationId, metadata, user } = req;

    const products = await this.repository.findAll({
      filter: { isFeatured: true, organizationId },
    });

    return { success: true, data: products };
  }
}
```

**Fastify Native Pattern** (`wrapHandler: false`):

```typescript
class ProductController extends BaseController {
  async downloadFile(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.params as { id: string };
    const file = await this.repository.getFile(id);

    reply.header('Content-Type', file.mimeType);
    reply.header('Content-Disposition', `attachment; filename="${file.name}"`);

    return reply.send(file.buffer);
  }
}
```

**When to use which:**
- Arc context: Standard CRUD, business logic, JSON responses
- Fastify native: File downloads, streaming, custom headers, redirects

See [Handler Patterns Guide](./ARC_HANDLER_PATTERNS.md) for detailed comparison.

## Using Metadata

Pass custom data between hooks, policies, and controllers:

```typescript
// In a hook
beforeCreate('product', async (context) => {
  context.metadata = { calculatedPrice: calculatePrice(context.data) };
});

// In controller
async create(req: IRequestContext): Promise<IControllerResponse> {
  const calculatedPrice = req.metadata?.calculatedPrice;

  const product = await this.repository.create({
    ...req.body,
    price: calculatedPrice,
  });

  return { success: true, data: product };
}
```

## Validation

Arc validates configs at definition time (fail-fast):

```typescript
defineResource({
  name: 'product',
  adapter: null,  // Throws immediately
  controller: productController,
});

// Error:
// Resource "product" validation failed:
// ERRORS:
//   ✗ adapter: Adapter is required
```

**Validated:**
- Required fields (name, adapter, controller)
- Controller methods exist
- Preset names are valid
- Permission keys match routes
- wrapHandler matches handler signature

## createCrudRouter (Advanced)

Low-level route creation. Used internally by defineResource.

```typescript
import { createCrudRouter } from '@classytic/arc';

createCrudRouter(fastify, controller, {
  resourceName: 'product',  // Required for hooks!
  tag: 'Products',
  schemas: crudSchemas,
  permissions: {
    list: allowPublic(),
    create: requireRoles(['admin']),
  },
  additionalRoutes: [...],
});
```

**Warning:** When using `createCrudRouter` directly, you MUST provide `resourceName` for hooks to work. Use `defineResource()` instead for automatic resource registration.

## TypeScript Interfaces

```typescript
import type {
  IRequestContext,
  IControllerResponse,
  IController,
} from '@classytic/arc';

// Strict controller interface
class ProductController implements IController<Product> {
  async list(req: IRequestContext): Promise<IControllerResponse<{ docs: Product[]; total: number }>> {
    // Implementation
  }

  async get(req: IRequestContext): Promise<IControllerResponse<Product>> {
    // Implementation
  }

  async create(req: IRequestContext): Promise<IControllerResponse<Product>> {
    // Implementation
  }

  async update(req: IRequestContext): Promise<IControllerResponse<Product>> {
    // Implementation
  }

  async delete(req: IRequestContext): Promise<IControllerResponse<{ message: string }>> {
    // Implementation
  }
}
```

## Best Practices

1. **Use Arc context by default** - Only use Fastify native for special cases
2. **Pass data via metadata** - Use `req.metadata` for hook/policy data
3. **Validate early** - Return errors with proper status codes
4. **Type your responses** - Use `IControllerResponse<T>` generics
5. **Keep controllers thin** - Business logic in services/repositories
6. **Use presets** - Don't reinvent softDelete, multiTenant, etc.

## See Also

- [Handler Patterns Guide](./ARC_HANDLER_PATTERNS.md) - Detailed comparison of patterns
- [Presets](./presets.md) - Reusable behaviors
- [Hooks](./hooks.md) - Lifecycle callbacks
- [Permissions](./permissions.md) - Access control
