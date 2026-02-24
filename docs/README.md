# Arc Documentation

Resource-oriented framework for Fastify + MongoDB. Define once, get routes, validation, permissions, and docs.

## Quick Links

| Guide | Purpose |
|-------|---------|
| [Setup](./setup.md) | Installation, dependencies, and quick start |
| [Core](./core.md) | Resources, controllers, adapters, query parsing, response schemas |
| [Auth](./auth.md) | JWT authentication (fast-jwt) and permissions |
| [Presets](./presets.md) | Reusable behaviors (softDelete, multiTenant, etc.) |
| [Factory](./factory.md) | Production-ready app creation, TypeBox type provider |
| [Hooks](./hooks.md) | Lifecycle callbacks |
| [Handler Patterns](./ARC_HANDLER_PATTERNS.md) | Arc context vs Fastify native handlers |
| [Org/Multi-tenant](./org.md) | Organization scoping |
| [Events](./events.md) | Domain events |
| [OpenAPI](./openapi.md) | Auto-generated API docs |

## Quick Example

```typescript
import { defineResource, BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';

// Controller
class ProductController extends BaseController {
  async getFeatured(req: IRequestContext): Promise<IControllerResponse> {
    const products = await this.repository.findAll({
      filter: { isFeatured: true },
    });
    return { success: true, data: products };
  }
}

// Resource
const productResource = defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: Product, repository: productRepo }),
  controller: new ProductController(productRepo),
  presets: ['softDelete', 'slugLookup'],
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
  additionalRoutes: [
    {
      method: 'GET',
      path: '/featured',
      handler: 'getFeatured',
      permissions: allowPublic(),
      wrapHandler: true, // Arc context pattern
    },
  ],
});

// Register
await app.register(productResource.toPlugin());
```

## Handler Patterns

Arc supports two patterns:

### 1. Arc Context (Recommended)

Use for standard API endpoints:

```typescript
async getProducts(req: IRequestContext): Promise<IControllerResponse> {
  const { organizationId, user } = req;
  const products = await this.repository.findAll({ filter: { organizationId } });
  return { success: true, data: products };
}

// additionalRoutes: [{ handler: 'getProducts', wrapHandler: true }]
```

### 2. Fastify Native

Use for files, streaming, custom headers:

```typescript
async downloadFile(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const file = await getFile(request.params.id);
  reply.header('Content-Type', file.mimeType);
  return reply.send(file.buffer);
}

// additionalRoutes: [{ handler: 'downloadFile', wrapHandler: false }]
```

## Core Concepts

### Request Context

```typescript
interface IRequestContext {
  params: Record<string, string>;        // Route params
  query: Record<string, unknown>;        // Query string
  body: unknown;                         // Request body
  user: UserBase | null;                 // Authenticated user
  headers: Record<string, string | undefined>; // Headers
  organizationId?: string;               // Multi-tenant org ID
  metadata?: Record<string, unknown>;    // Custom data from hooks/policies
}
```

### Response Format

```typescript
interface IControllerResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;       // Default: 200 for success, 400 for error
  meta?: Record<string, unknown>;
  details?: Record<string, unknown>;
}
```

## Key Features

- **Arc Context Pattern** - Framework-agnostic, clean API
- **Native Fastify Support** - Full control when needed
- **Auto-generated Routes** - CRUD + custom routes with default response schemas
- **Presets** - Reusable behaviors (softDelete, multiTenant, tree, etc.)
- **Type-Safe** - Full TypeScript support with optional TypeBox integration
- **Pluggable Query Parsing** - Built-in ArcQueryParser or MongoKit's advanced parser
- **fast-json-stringify** - Default response schemas enable 2-3x faster serialization
- **Multi-tenant** - Built-in organization scoping
- **OpenAPI** - Auto-generated documentation

## Next Steps

1. [Quick Start Guide](./setup.md) - Get up and running in 5 minutes
2. [Core Concepts](./core.md) - Resources, adapters, query parsing, response schemas
3. [Handler Patterns](./ARC_HANDLER_PATTERNS.md) - Choose the right pattern
4. [Factory & TypeBox](./factory.md) - Production config with optional TypeBox type provider
5. [Auth (JWT v10)](./auth.md) - fast-jwt powered authentication
