# Arc Framework

Resource-oriented backend framework for Fastify + MongoDB.

**Define once → Routes, validation, permissions, docs generated.**

## Install

```bash
npm install @classytic/arc
# Recommended: Add MongoKit for rich query parsing and schema generation
npm install @classytic/mongokit
```

## 5-Minute Quick Start

```typescript
import Fastify from 'fastify';
import { defineResource, BaseController, BaseRepository } from '@classytic/arc';
import Product from './models/Product.js';

// 1. Create repository and controller
const productRepo = new BaseRepository(Product);
const productController = new BaseController(productRepo);

// 2. Define resource
const productResource = defineResource({
  name: 'product',
  model: Product,
  repository: productRepo,
  controller: productController,
  presets: ['softDelete'],
  permissions: {
    list: [],           // Public
    get: [],            // Public
    create: ['admin'],  // Admin only
    update: ['admin'],
    delete: ['admin'],
  },
});

// 3. Register with Fastify
const fastify = Fastify({ logger: true });
await fastify.register(productResource.toPlugin());
await fastify.listen({ port: 3000 });
```

**Result:** Full REST API at `/products` with validation, auth, soft-delete.

## What You Get

| Feature | Description |
|---------|-------------|
| **CRUD Routes** | `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| **Query Parsing** | `?price[gte]=100&sort=-createdAt&page=2&populate=category` |
| **Role-Based Auth** | Per-route permissions via `permissions` config |
| **Presets** | `softDelete`, `slugLookup`, `tree`, `ownedByUser`, `multiTenant` |
| **Validation** | Fail-fast config validation with clear error messages |
| **OpenAPI** | Auto-generated spec + Scalar UI |

## Documentation

| Module | Purpose |
|--------|---------|
| [Core](./core.md) | `defineResource`, `BaseController`, `BaseRepository` |
| [Presets](./presets.md) | Reusable behaviors: softDelete, tree, ownedByUser |
| [Auth](./auth.md) | JWT + role-based authorization |
| [Org](./org.md) | Multi-tenant organization scoping |
| [Hooks](./hooks.md) | Lifecycle callbacks (before/after CRUD) |
| [Events](./events.md) | Domain events with pluggable transports |
| [Plugins](./plugins.md) | Health checks, request ID, graceful shutdown |
| [Audit](./audit.md) | Audit trail with pluggable stores |
| [OpenAPI](./openapi.md) | API documentation with Scalar UI |
| [Idempotency](./idempotency.md) | Safe request retries |

## Architecture

```
defineResource(config)
       ↓
  Apply Presets → Add routes, middlewares, schema options
       ↓
  Validate Config → Fail-fast with clear errors
       ↓
  ResourceDefinition
       ↓
  toPlugin() → Fastify plugin with all routes
```

## MongoKit Integration

Arc auto-detects `@classytic/mongokit` when installed:

```typescript
// Rich query parsing (automatic)
// GET /products?price[gte]=100&sort=-createdAt&populate=category

// OpenAPI schemas from Mongoose models (automatic)
await fastify.register(openApiPlugin);
// → Real schemas instead of placeholders
```

No configuration needed - just install MongoKit.

## Production Checklist

| Concern | Development | Production |
|---------|-------------|------------|
| Idempotency | MemoryStore | RedisStore / MongoStore |
| Audit | MemoryStore | MongoAuditStore |
| Events | MemoryTransport | Redis / RabbitMQ / Kafka |
| Sessions | JWT (stateless) | JWT (stateless) |

In-memory stores are dev-friendly. Swap to durable stores for production.

## Example: Full Resource

```typescript
import { defineResource, BaseController, BaseRepository } from '@classytic/arc';

const orderResource = defineResource({
  name: 'order',
  model: Order,
  repository: new BaseRepository(Order),
  controller: new OrderController(),

  // Behaviors
  presets: [
    'softDelete',
    { name: 'ownedByUser', ownerField: 'customerId' },
  ],

  // Auth
  permissions: {
    list: ['admin'],
    get: ['admin', 'customer'],
    create: ['customer'],
    update: ['admin'],
    delete: ['admin'],
    deleted: ['admin'],
    restore: ['admin'],
  },

  // Multi-tenant
  organizationScoped: true,

  // Custom routes
  additionalRoutes: [
    {
      method: 'POST',
      path: '/:id/cancel',
      handler: 'cancelOrder',
      authRoles: ['admin', 'customer'],
    },
  ],
});
```
