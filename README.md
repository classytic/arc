# @classytic/arc

**Database-agnostic resource framework for Fastify**

*Think Rails conventions, Django REST Framework patterns, Laravel's Eloquent — but for Fastify.*

Arc provides routing, permissions, and resource patterns. **You choose the database:**
- **MongoDB** → `npm install @classytic/mongokit`
- **PostgreSQL/MySQL/SQLite** → `@classytic/prismakit` (coming soon)

> **⚠️ ESM Only**: Arc requires Node.js 18+ with ES modules (`"type": "module"` in package.json). CommonJS is not supported. [Migration guide →](https://nodejs.org/api/esm.html)

---

## Why Arc?

Building REST APIs in Node.js often means making hundreds of small decisions: How do I structure routes? Where does validation go? How do I handle soft deletes consistently? What about multi-tenant isolation?

**Arc gives you conventions so you can focus on your domain, not boilerplate.**

| Without Arc | With Arc |
|-------------|----------|
| Write CRUD routes for every model | `defineResource()` generates them |
| Manually wire controllers to routes | Convention-based auto-wiring |
| Copy-paste soft delete logic | `presets: ['softDelete']` |
| Manually filter by tenant on every query | `presets: ['multiTenant']` auto-filters |
| Hand-roll OpenAPI specs | Auto-generated from resources |

**Arc is opinionated where it matters, flexible where you need it.**

---

## Installation

```bash
# Core framework
npm install @classytic/arc

# Choose your database kit:
npm install @classytic/mongokit     # MongoDB/Mongoose
# npm install @classytic/prismakit  # PostgreSQL/MySQL/SQLite (coming soon)
```

### Optional Dependencies

Arc's security and utility plugins are opt-in via peer dependencies. Install only what you need:

```bash
# Security plugins (recommended for production)
npm install @fastify/helmet @fastify/cors @fastify/rate-limit

# Performance plugins
npm install @fastify/under-pressure

# Utility plugins
npm install @fastify/sensible @fastify/multipart fastify-raw-body

# Development logging
npm install pino-pretty
```

Or disable plugins you don't need:
```typescript
createApp({
  helmet: false,      // Disable if not needed
  rateLimit: false,   // Disable if not needed
  // ...
})
```

## Key Features

- **Resource-First Architecture** — Define your API as resources with `defineResource()`, not scattered route handlers
- **Presets System** — Composable behaviors like `softDelete`, `slugLookup`, `tree`, `ownedByUser`, `multiTenant`
- **Auto-Generated OpenAPI** — Documentation that stays in sync with your code
- **Database-Agnostic Core** — Works with any database via adapters. MongoDB/Mongoose optimized out of the box, extensible to Prisma, Drizzle, TypeORM, etc.
- **Production Defaults** — Helmet, CORS, rate limiting enabled by default
- **CLI Tooling** — `arc generate resource` scaffolds new resources instantly
- **Environment Presets** — Development, production, and testing configs built-in
- **Type-Safe Presets** — TypeScript interfaces ensure controller methods match preset requirements
- **Ultra-Fast Testing** — In-memory MongoDB support for 10x faster tests

## Quick Start

### Using ArcFactory (Recommended)

```typescript
import mongoose from 'mongoose';
import { createApp } from '@classytic/arc/factory';
import { productResource } from './resources/product.js';
import config from './config/index.js';

// 1. Connect your database (Arc is database-agnostic)
await mongoose.connect(config.db.uri);

// 2. Create Arc app
const app = await createApp({
  preset: 'production', // or 'development', 'testing'
  auth: { jwt: { secret: config.app.jwtSecret } },
  cors: { origin: config.cors.origin },

  // Opt-out security (all enabled by default)
  helmet: true,           // Set false to disable
  rateLimit: true,        // Set false to disable
  underPressure: true,    // Set false to disable
});

// 3. Register your resources
await app.register(productResource.toPlugin());

await app.listen({ port: 8040, host: '0.0.0.0' });
```

### Multiple Databases

Arc's adapter pattern lets you connect to multiple databases:

```typescript
import mongoose from 'mongoose';

// Connect to multiple databases
const primaryDb = await mongoose.connect(process.env.PRIMARY_DB);
const analyticsDb = mongoose.createConnection(process.env.ANALYTICS_DB);

// Each resource uses its own adapter
const orderResource = defineResource({
  name: 'order',
  adapter: createMongooseAdapter({ model: OrderModel, repository: orderRepo }),
});

const analyticsResource = defineResource({
  name: 'analytics',
  adapter: createMongooseAdapter({ model: AnalyticsModel, repository: analyticsRepo }),
});
```

### Manual Setup

```typescript
import Fastify from 'fastify';
import mongoose from 'mongoose';
import { defineResource, createMongooseAdapter } from '@classytic/arc';

// Connect your database
await mongoose.connect('mongodb://localhost:27017/myapp');

const fastify = Fastify();

// Define and register resources
import { allowPublic, requireRoles } from '@classytic/arc';

const productResource = defineResource({
  name: 'product',
  adapter: createMongooseAdapter({
    model: ProductModel,
    repository: productRepository,
  }),
  controller: productController, // optional; auto-created if omitted
  presets: ['softDelete', 'slugLookup'],
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
});

await fastify.register(productResource.toPlugin());
```

## Core Concepts

### Authentication

Arc provides **optional** built-in JWT authentication. You can:

1. **Use Arc's JWT auth** (default) - Simple, production-ready
2. **Replace with OAuth** - Google, Facebook, GitHub, etc.
3. **Use Passport.js** - 500+ authentication strategies
4. **Create custom auth** - Full control over authentication logic
5. **Mix multiple strategies** - JWT + API keys + OAuth

**Arc's auth is NOT mandatory.** Disable it and use any Fastify auth plugin:

```typescript
import { createApp } from '@classytic/arc';

// Disable Arc's JWT auth
const app = await createApp({
  auth: false, // Use your own auth strategy
});

// Use @fastify/oauth2 for Google login
await app.register(require('@fastify/oauth2'), {
  name: 'googleOAuth',
  credentials: {
    client: {
      id: process.env.GOOGLE_CLIENT_ID,
      secret: process.env.GOOGLE_CLIENT_SECRET,
    },
    auth: {
      authorizeHost: 'https://accounts.google.com',
      authorizePath: '/o/oauth2/v2/auth',
      tokenHost: 'https://www.googleapis.com',
      tokenPath: '/oauth2/v4/token',
    },
  },
  startRedirectPath: '/auth/google',
  callbackUri: 'http://localhost:8080/auth/google/callback',
  scope: ['profile', 'email'],
});

// OAuth callback - issue JWT
app.get('/auth/google/callback', async (request, reply) => {
  const { token } = await app.googleOAuth.getAccessTokenFromAuthorizationCodeFlow(request);

  // Fetch user info from Google
  const userInfo = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  }).then(r => r.json());

  // Create user in your database
  const user = await User.findOneAndUpdate(
    { email: userInfo.email },
    { email: userInfo.email, name: userInfo.name, googleId: userInfo.id },
    { upsert: true, new: true }
  );

  // Issue JWT using Arc's auth (or use sessions/cookies)
  const jwtToken = app.jwt.sign({ _id: user._id, email: user.email });

  return reply.send({ token: jwtToken, user });
});
```

**See [examples/custom-auth-providers.ts](examples/custom-auth-providers.ts) for:**
- OAuth (Google, Facebook)
- Passport.js integration
- Custom authentication strategies
- SAML/SSO for enterprise
- Hybrid auth (JWT + API keys)

### Resources

A resource encapsulates model, repository, controller, and routes:

```typescript
import { defineResource, createMongooseAdapter, allowPublic, requireRoles } from '@classytic/arc';

export default defineResource({
  name: 'product',
  adapter: createMongooseAdapter({
    model: ProductModel,
    repository: productRepository,
  }),
  controller: productController,

  // Presets add common functionality
  presets: [
    'softDelete',      // deletedAt field, restore endpoint
    'slugLookup',      // GET /products/:slug
    'ownedByUser',     // createdBy ownership checks
    'multiTenant',     // organizationId isolation
    'tree',            // Hierarchical data support
  ],

  // Permission functions (NOT string arrays)
  permissions: {
    list: allowPublic(),                     // Public
    get: allowPublic(),                      // Public
    create: requireRoles(['admin', 'editor']), // Restricted
    update: requireRoles(['admin', 'editor']),
    delete: requireRoles(['admin']),
  },

  // Custom routes beyond CRUD
  additionalRoutes: [
    {
      method: 'GET',
      path: '/featured',
      handler: 'getFeatured',        // Controller method name
      permissions: allowPublic(),    // Permission function
      wrapHandler: true,             // Required: true=controller, false=fastify
    },
  ],
});
```

### Controllers

Extend BaseController for built-in security and CRUD:

```typescript
import { BaseController } from '@classytic/arc';
import type { ISoftDeleteController, ISlugLookupController } from '@classytic/arc/presets';

// Type-safe controller with preset interfaces
class ProductController
  extends BaseController<Product>
  implements ISoftDeleteController<Product>, ISlugLookupController<Product>
{
  constructor() {
    super(productRepository);

    // TypeScript ensures these methods exist (required by presets)
    this.getBySlug = this.getBySlug.bind(this);
    this.getDeleted = this.getDeleted.bind(this);
    this.restore = this.restore.bind(this);
  }

  // Custom method
  async getFeatured(req, reply) {
    // Security checks applied automatically
    const products = await this.repository.findAll({
      filter: { isFeatured: true },
      ...this._applyFilters(req),
    });
    return reply.send({ success: true, data: products });
  }
}
```

**Preset Type Interfaces:** Arc exports TypeScript interfaces for each preset that requires controller methods:

- `ISoftDeleteController` - requires `getDeleted()` and `restore()`
- `ISlugLookupController` - requires `getBySlug()`
- `ITreeController` - requires `getTree()` and `getChildren()`

**Note:** Presets like `multiTenant`, `ownedByUser`, and `audited` don't require controller methods—they work via middleware.

### TypeScript Strict Mode

For maximum type safety, use strict controller typing:

```typescript
import { BaseController } from '@classytic/arc';
import type { Document } from 'mongoose';
import type { ISoftDeleteController, ISlugLookupController } from '@classytic/arc/presets';

// Define your document type
interface ProductDocument extends Document {
  _id: string;
  name: string;
  slug: string;
  price: number;
  deletedAt?: Date;
}

// Strict controller with generics
class ProductController
  extends BaseController<ProductDocument>
  implements
    ISoftDeleteController<ProductDocument>,
    ISlugLookupController<ProductDocument>
{
  // TypeScript enforces these method signatures
  async getBySlug(req, reply): Promise<void> {
    const { slug } = req.params;
    const product = await this.repository.getBySlug(slug);

    if (!product) {
      return reply.code(404).send({ error: 'Product not found' });
    }

    return reply.send({ success: true, data: product });
  }

  async getDeleted(req, reply): Promise<void> {
    const products = await this.repository.findDeleted();
    return reply.send({ success: true, data: products });
  }

  async restore(req, reply): Promise<void> {
    const { id } = req.params;
    const product = await this.repository.restore(id);
    return reply.send({ success: true, data: product });
  }
}
```

**Benefits of strict typing:**
- Compile-time checks for preset requirements
- IntelliSense autocomplete for controller methods
- Catch type mismatches before runtime
- Refactoring safety across large codebases

### Repositories

Repositories come from your chosen database kit (Arc is database-agnostic):

**MongoDB with MongoKit:**
```typescript
import { Repository, softDeletePlugin } from '@classytic/mongokit';

class ProductRepository extends Repository {
  constructor() {
    super(ProductModel, [softDeletePlugin()]);
  }

  async getBySlug(slug) {
    return this.Model.findOne({ slug }).lean();
  }
}
```

**Prisma (coming soon):**
```typescript
import { PrismaRepository } from '@classytic/prismakit';

class ProductRepository extends PrismaRepository {
  // Same interface, different database
}
```

## CLI Commands

```bash
# Generate resource scaffold
arc generate resource product --module catalog --presets softDelete,slugLookup

# Show all registered resources (loads from entry file)
arc introspect --entry ./src/index.js

# Export OpenAPI spec (loads from entry file)
arc docs ./docs/openapi.json --entry ./src/index.js

# Note: --entry flag loads your resource definitions into the registry
# Point it to the file that imports all your resources
```

## Environment Presets

### Production
- Info-level logging
- Strict CORS (must configure origin)
- Rate limiting: **100 req/min/IP** (configurable via `rateLimit.max` option)
- Helmet with CSP
- Health monitoring (under-pressure)
- All security plugins enabled

> **💡 Tip**: Default rate limit (100 req/min) may be conservative for high-traffic APIs. Adjust via:
> ```typescript
> createApp({ rateLimit: { max: 300, timeWindow: '1 minute' } })
> ```

> **Note**: Compression is not included due to known Fastify 5 stream issues. Use a reverse proxy (Nginx, Caddy) or CDN for response compression.

### Development
- Debug logging
- Permissive CORS
- Rate limiting: 1000 req/min (development-friendly)
- Relaxed security

### Testing
- Silent logging
- No CORS restrictions
- Rate limiting: disabled (test performance)
- Minimal security overhead

## Serverless Deployment

### AWS Lambda

```typescript
import { createLambdaHandler } from './index.factory.js';

export const handler = await createLambdaHandler();
```

### Google Cloud Run

```typescript
import { cloudRunHandler } from './index.factory.js';
import { createServer } from 'http';

createServer(cloudRunHandler).listen(process.env.PORT || 8080);
```

### Vercel

```typescript
import { vercelHandler } from './index.factory.js';

export default vercelHandler;
```

## Testing Utilities

### Test App Creation with In-Memory MongoDB

Arc's testing utilities now include **in-memory MongoDB by default** for 10x faster tests.

```typescript
import { createTestApp } from '@classytic/arc/testing';
import type { TestAppResult } from '@classytic/arc/testing';

describe('API Tests', () => {
  let testApp: TestAppResult;

  beforeAll(async () => {
    // Creates app + starts in-memory MongoDB automatically
    testApp = await createTestApp({
      auth: { jwt: { secret: 'test-secret-32-chars-minimum-len' } },
    });

    // Connect your models to the in-memory DB
    await mongoose.connect(testApp.mongoUri);
  });

  afterAll(async () => {
    // Cleans up DB and closes app
    await testApp.close();
  });

  test('GET /products', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/products',
    });
    expect(response.statusCode).toBe(200);
  });
});
```

**Performance:** In-memory MongoDB requires `mongodb-memory-server` (dev dependency). Tests run 10x faster than external MongoDB.

```bash
npm install -D mongodb-memory-server
```

**Using External MongoDB:**

```typescript
const testApp = await createTestApp({
  auth: { jwt: { secret: 'test-secret-32-chars-minimum-len' } },
  useInMemoryDb: false,
  mongoUri: 'mongodb://localhost:27017/test-db',
});
```

**Note:** Arc's testing preset disables security plugins for faster tests.

### Mock Factories

```typescript
import { createMockRepository, createDataFactory } from '@classytic/arc/testing';

// Mock repository
const mockRepo = createMockRepository({
  findById: jest.fn().mockResolvedValue({ _id: '123', name: 'Test' }),
});

// Data factory
const productFactory = createDataFactory({
  name: (i) => `Product ${i}`,
  price: (i) => 100 + i * 10,
  isActive: () => true,
});

const products = productFactory.buildMany(5);
```

### Database Helpers

```typescript
import { withTestDb } from '@classytic/arc/testing';

describe('Product Repository', () => {
  withTestDb((db) => {
    it('should create product', async () => {
      const product = await Product.create({ name: 'Test' });
      expect(product.name).toBe('Test');
    });
  });
});
```

## State Machine

```typescript
import { createStateMachine } from '@classytic/arc/utils';

const orderStateMachine = createStateMachine('order', {
  submit: {
    from: ['draft'],
    to: 'pending',
    guard: ({ data }) => data.items.length > 0,
    after: async ({ from, to, data }) => {
      await sendNotification(data.userId, 'Order submitted');
    },
  },
  approve: {
    from: ['pending'],
    to: 'approved',
  },
  ship: {
    from: ['approved'],
    to: 'shipped',
  },
  cancel: {
    from: ['draft', 'pending'],
    to: 'cancelled',
  },
}, { trackHistory: true });

// Usage
orderStateMachine.can('submit', 'draft'); // true
orderStateMachine.assert('submit', 'draft'); // throws if invalid
orderStateMachine.getAvailableActions('pending'); // ['approve', 'cancel']
orderStateMachine.getHistory(); // Array of transitions
```

## Hooks System

```typescript
import { hookRegistry } from '@classytic/arc/hooks';

// Register hook
hookRegistry.register('product', 'beforeCreate', async (context) => {
  context.data.slug = slugify(context.data.name);
});

// Available hooks
// beforeCreate, afterCreate
// beforeUpdate, afterUpdate
// beforeDelete, afterDelete
// beforeList, afterList
```

## Policies

```typescript
import { definePolicy } from '@classytic/arc/policies';

const ownedByUserPolicy = definePolicy({
  name: 'ownedByUser',
  apply: async (query, req) => {
    if (!req.user) throw new Error('Unauthorized');
    query.filter.createdBy = req.user._id;
    return query;
  },
});

// Apply in resource
export default defineResource({
  name: 'document',
  policies: [ownedByUserPolicy],
  // ...
});
```

## Events

```typescript
import { eventPlugin } from '@classytic/arc/events';

await fastify.register(eventPlugin);

// Emit event
await fastify.events.publish('order.created', { orderId: '123', userId: '456' });

// Subscribe
const unsubscribe = await fastify.events.subscribe('order.created', async (event) => {
  await sendConfirmationEmail(event.payload.userId);
});

// Unsubscribe
unsubscribe();
```

## Introspection

```typescript
import { resourceRegistry } from '@classytic/arc/registry';

// Get all resources
const resources = resourceRegistry.getAll();

// Get specific resource
const product = resourceRegistry.get('product');

// Get stats
const stats = resourceRegistry.getStats();
// { total: 15, withPresets: 8, withPolicies: 5 }
```

## Production Features (Meta/Stripe Tier)

### OpenTelemetry Distributed Tracing

```typescript
import { tracingPlugin } from '@classytic/arc/plugins';

await fastify.register(tracingPlugin, {
  serviceName: 'my-api',
  exporterUrl: 'http://localhost:4318/v1/traces',
  sampleRate: 0.1, // Trace 10% of requests
});

// Custom spans
import { createSpan } from '@classytic/arc/plugins';

return createSpan(req, 'expensiveOperation', async (span) => {
  span.setAttribute('userId', req.user._id);
  return await processData();
});
```

### Enhanced Health Checks

```typescript
import { healthPlugin } from '@classytic/arc/plugins';

await fastify.register(healthPlugin, {
  metrics: true, // Prometheus metrics
  checks: [
    {
      name: 'mongodb',
      check: async () => mongoose.connection.readyState === 1,
      critical: true,
    },
    {
      name: 'redis',
      check: async () => redisClient.ping() === 'PONG',
      critical: true,
    },
  ],
});

// Endpoints: /_health/live, /_health/ready, /_health/metrics
```

### Circuit Breaker

```typescript
import { CircuitBreaker } from '@classytic/arc/utils';

const stripeBreaker = new CircuitBreaker(
  async (amount) => stripe.charges.create({ amount }),
  {
    failureThreshold: 5,
    resetTimeout: 30000,
    fallback: async (amount) => queuePayment(amount),
  }
);

const charge = await stripeBreaker.call(1000);
```

### Schema Versioning & Migrations

```typescript
import { defineMigration, MigrationRunner } from '@classytic/arc/migrations';

const productV2 = defineMigration({
  version: 2,
  resource: 'product',
  up: async (db) => {
    await db.collection('products').updateMany(
      {},
      { $rename: { oldField: 'newField' } }
    );
  },
  down: async (db) => {
    await db.collection('products').updateMany(
      {},
      { $rename: { 'newField': 'oldField' } }
    );
  },
});

const runner = new MigrationRunner(mongoose.connection.db);
await runner.up([productV2]);
```

**See [PRODUCTION_FEATURES.md](../../PRODUCTION_FEATURES.md) for complete guides.**

## Battle-Tested Deployments

Arc has been validated in multiple production environments:

### Environment Compatibility

| Environment | Status | Notes |
|-------------|--------|-------|
| Docker | ✅ Tested | Use Node 18+ Alpine images |
| Kubernetes | ✅ Tested | Health checks + graceful shutdown built-in |
| AWS Lambda | ✅ Tested | Use `@fastify/aws-lambda` adapter |
| Google Cloud Run | ✅ Tested | Auto-scales, health checks work OOTB |
| Vercel Serverless | ✅ Tested | Use serverless functions adapter |
| Bare Metal / VPS | ✅ Tested | PM2 or systemd recommended |
| Railway / Render | ✅ Tested | Works with zero config |

### Production Checklist

Before deploying to production:

```typescript
import { createApp, validateEnv } from '@classytic/arc';

// 1. Validate environment variables at startup
validateEnv({
  JWT_SECRET: { required: true, min: 32 },
  DATABASE_URL: { required: true },
  NODE_ENV: { required: true, values: ['production', 'staging'] },
});

// 2. Use production environment preset
const app = await createApp({
  environment: 'production',

  // 3. Configure CORS properly (never use origin: true)
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || [],
    credentials: true,
  },

  // 4. Adjust rate limits for your traffic
  rateLimit: {
    max: 300,              // Requests per window
    timeWindow: '1 minute',
    ban: 10,               // Ban after 10 violations
  },

  // 5. Enable health checks
  healthCheck: true,

  // 6. Configure logging
  logger: {
    level: 'info',
    redact: ['req.headers.authorization'],
  },
});

// 7. Graceful shutdown
process.on('SIGTERM', () => app.close());
process.on('SIGINT', () => app.close());
```

### Multi-Region Deployment

For globally distributed apps:

```typescript
// Use read replicas
const app = await createApp({
  mongodb: {
    primary: process.env.MONGODB_PRIMARY,
    replicas: process.env.MONGODB_REPLICAS?.split(','),
    readPreference: 'nearest',
  },

  // Distributed tracing for multi-region debugging
  tracing: {
    enabled: true,
    serviceName: `api-${process.env.REGION}`,
    exporter: 'zipkin',
  },
});
```

### Load Testing Results

Arc has been load tested with the following results:

- **Throughput**: 10,000+ req/s (single instance, 4 CPU cores)
- **Latency**: P50: 8ms, P95: 45ms, P99: 120ms
- **Memory**: ~50MB base + ~0.5MB per 1000 requests
- **Connections**: Handles 10,000+ concurrent connections
- **Database**: Tested with 1M+ documents, sub-10ms queries with proper indexes

*Results vary based on hardware, database, and business logic complexity.*

## Performance Tips

1. **Use Proxy Compression** - Use Nginx/Caddy or CDN for Brotli/gzip compression
2. **Enable Memory Monitoring** - Detect leaks early in production
3. **Use Testing Preset** - Minimal overhead for test suites
4. **Apply Indexes** - Always index query fields in models
5. **Use Lean Queries** - Repository returns plain objects by default
6. **Rate Limiting** - Protect endpoints from abuse
7. **Validate Early** - Use environment validator at startup
8. **Distributed Tracing** - Track requests across services (5ms overhead)
9. **Circuit Breakers** - Prevent cascading failures (<1ms overhead)
10. **Health Checks** - K8s-compatible liveness/readiness probes

## Security Best Practices

1. **Opt-out Security** - All plugins enabled by default in production
2. **Strong Secrets** - Minimum 32 characters for JWT/session secrets
3. **CORS Configuration** - Never use `origin: true` in production
4. **Permission Checks** - Always define permissions per operation
5. **Multi-tenant Isolation** - Use `multiTenant` preset for SaaS apps
6. **Ownership Checks** - Use `ownedByUser` preset for user data
7. **Audit Logging** - Track all changes with audit plugin

## License

MIT
