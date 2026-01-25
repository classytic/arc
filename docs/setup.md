# Arc Setup Guide

Get started with Arc in under 5 minutes.

## Prerequisites

- Node.js 20+
- MongoDB (local or Atlas)
- npm or pnpm

## Quick Start

### 1. Install Dependencies

```bash
# Core packages
npm install @classytic/arc @classytic/mongokit fastify mongoose

# Optional: Security & performance plugins
npm install @fastify/cors @fastify/helmet @fastify/rate-limit @fastify/jwt

# Dev dependencies
npm install -D typescript @types/node vitest
```

### 2. Initialize TypeScript

```bash
npx tsc --init
```

Update `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 3. Create Project Structure

```
my-api/
├── src/
│   ├── index.ts              # App entry point
│   ├── modules/
│   │   └── product/
│   │       ├── product.model.ts
│   │       ├── product.repository.ts
│   │       └── product.resource.ts
│   └── config/
│       └── env.ts
├── package.json
└── tsconfig.json
```

### 4. Create Your First Resource

**src/modules/product/product.model.ts**
```typescript
import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, sparse: true },
    price: { type: Number, required: true, min: 0 },
    description: { type: String },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

productSchema.index({ slug: 1 });
productSchema.index({ isActive: 1, deletedAt: 1 });

export const Product = mongoose.model('Product', productSchema);
```

**src/modules/product/product.repository.ts**
```typescript
import { Repository, softDeletePlugin } from '@classytic/mongokit';
import { Product } from './product.model.js';

class ProductRepository extends Repository<typeof Product> {
  constructor() {
    super(Product, [softDeletePlugin()]);
  }

  async findActive() {
    return this.Model.find({ isActive: true, deletedAt: null }).lean();
  }

  async getBySlug(slug: string) {
    return this.Model.findOne({ slug, deletedAt: null }).lean();
  }
}

export const productRepository = new ProductRepository();
```

**src/modules/product/product.resource.ts**
```typescript
import { defineResource, createMongooseAdapter, allowPublic, requireRoles } from '@classytic/arc';
import { Product } from './product.model.js';
import { productRepository } from './product.repository.js';
import { productController } from './product.controller.js';

export const productResource = defineResource({
  name: 'product',
  displayName: 'Products',
  prefix: '/products',

  adapter: createMongooseAdapter({
    model: Product,
    repository: productRepository,
  }),
  controller: productController,

  presets: ['softDelete', 'slugLookup'],

  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
    deleted: requireRoles(['admin']),  // softDelete preset
    restore: requireRoles(['admin']),  // softDelete preset
    getBySlug: allowPublic(),          // slugLookup preset
  },
});
```

### 5. Create App Entry Point

**src/index.ts**
```typescript
import mongoose from 'mongoose';
import { createApp } from '@classytic/arc/factory';
import { productResource } from './modules/product/product.resource.js';

async function bootstrap() {
  // Connect to MongoDB
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/my-api');
  console.log('Connected to MongoDB');

  // Create Arc app
  const app = await createApp({
    preset: 'development', // or 'production'
    auth: {
      jwt: { secret: process.env.JWT_SECRET || 'dev-secret-change-in-production' },
    },
    plugins: async (fastify) => {
      // Register resources
      await fastify.register(productResource.toPlugin());
    },
  });

  // Start server
  const port = parseInt(process.env.PORT || '3000');
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Server running at http://localhost:${port}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await app.close();
    await mongoose.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
```

### 6. Add Scripts to package.json

```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "generate": "arc generate"
  }
}
```

### 7. Run the App

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

### 8. Test Your API

```bash
# List products
curl http://localhost:3000/products

# Create product (requires auth in production)
curl -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{"name": "Widget", "price": 29.99}'

# Get by ID
curl http://localhost:3000/products/<id>

# Get by slug
curl http://localhost:3000/products/slug/widget

# Update
curl -X PATCH http://localhost:3000/products/<id> \
  -H "Content-Type: application/json" \
  -d '{"price": 24.99}'

# Delete (soft)
curl -X DELETE http://localhost:3000/products/<id>

# Health check
curl http://localhost:3000/_health/live
```

---

## Using the CLI

Generate resources quickly:

```bash
# Generate full resource (model, repository, controller, routes, tests)
npx arc generate resource order --module sales

# With presets
npx arc generate resource invoice -p softDelete,multiTenant

# Preview without creating files
npx arc generate resource payment --dry-run

# Generate specific files only
npx arc generate controller auth
npx arc generate model customer
```

---

## Production Setup

### Environment Variables

```bash
# .env
NODE_ENV=production
PORT=3000
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/mydb
JWT_SECRET=your-32-char-minimum-secret-key
```

### Production App Configuration

```typescript
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  preset: 'production',

  // Authentication
  auth: {
    jwt: {
      secret: process.env.JWT_SECRET!,
      expiresIn: '7d',
    },
  },

  // Security
  cors: {
    origin: ['https://myapp.com'],
    credentials: true,
  },
  helmet: true,
  rateLimit: {
    max: 100,
    timeWindow: '1 minute',
  },

  // Logging
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: false },
    },
  },

  // Plugins
  plugins: async (fastify) => {
    await fastify.register(productResource.toPlugin());
    await fastify.register(orderResource.toPlugin());
  },
});
```

---

## Multi-Tenant Setup

For SaaS applications with organization isolation:

```typescript
import { defineResource, createMongooseAdapter, requireAuth } from '@classytic/arc';

export const invoiceResource = defineResource({
  name: 'invoice',
  prefix: '/invoices',

  adapter: createMongooseAdapter({
    model: Invoice,
    repository: invoiceRepository,
  }),

  // Enable multi-tenant isolation
  presets: ['multiTenant', 'softDelete'],
  organizationScoped: true,

  permissions: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: requireAuth(),
    delete: requireAuth(),
  },
});
```

Requests require `x-organization-id` header:

```bash
curl http://localhost:3000/invoices \
  -H "Authorization: Bearer <token>" \
  -H "x-organization-id: org_123"
```

---

## Adding Custom Routes

```typescript
export const productResource = defineResource({
  name: 'product',
  // ... adapter, permissions

  additionalRoutes: [
    {
      method: 'GET',
      path: '/featured',
      handler: 'getFeatured',
      summary: 'Get featured products',
      permissions: allowPublic(),
      wrapHandler: true,  // Arc context pattern
    },
    {
      method: 'POST',
      path: '/:id/publish',
      handler: 'publish',
      summary: 'Publish a product',
      permissions: requireRoles(['admin']),
      wrapHandler: true,  // Arc context pattern
    },
  ],
});
```

Implement handlers in your controller:

```typescript
import { BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';

class ProductController extends BaseController {
  async getFeatured(req: IRequestContext): Promise<IControllerResponse> {
    const products = await this.repository.Model.find({
      isFeatured: true,
      isActive: true
    }).limit(10);
    return { success: true, data: products };
  }

  async publish(req: IRequestContext): Promise<IControllerResponse> {
    const { id } = req.params;
    const product = await this.repository.update(id, {
      status: 'published',
      publishedAt: new Date(),
    });
    return { success: true, data: product };
  }
}
```

---

## Testing

**tests/product.test.ts**
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

describe('Product API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp({
      auth: { jwt: { secret: 'test-secret-32-chars-minimum-len' } },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('should list products', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/products',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
  });

  it('should create a product', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/products',
      payload: { name: 'Test Product', price: 99.99 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.name).toBe('Test Product');
  });
});
```

Run tests:

```bash
npm test
```

---

## Next Steps

- [Core Concepts](./core.md) - Understanding resources, adapters, controllers
- [Permissions](./permissions.md) - Fine-grained access control
- [Presets](./presets.md) - Reusable behaviors (softDelete, multiTenant, etc.)
- [Hooks](./hooks.md) - Lifecycle callbacks
- [Factory](./factory.md) - App configuration options
- [Tree-Shaking](./tree-shaking.md) - Optimizing bundle size

---

## Troubleshooting

### "Cannot find module" errors

Ensure your `package.json` has `"type": "module"` and imports use `.js` extensions:

```typescript
// Correct
import { Product } from './product.model.js';

// Wrong
import { Product } from './product.model';
```

### MongoDB connection issues

Check your connection string and ensure MongoDB is running:

```bash
# Local MongoDB
mongod --dbpath /data/db

# Or use Docker
docker run -d -p 27017:27017 mongo
```

### TypeScript path issues

If using path aliases, configure both `tsconfig.json` and your runtime:

```json
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "#modules/*": ["./src/modules/*"]
    }
  }
}
```

```json
// package.json
{
  "imports": {
    "#modules/*": "./dist/modules/*"
  }
}
```
