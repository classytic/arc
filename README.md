# @classytic/arc

**Database-agnostic resource framework for Fastify**

*Think Rails conventions, Django REST Framework patterns, Laravel's Eloquent — but for Fastify.*

Arc provides routing, permissions, and resource patterns. **You choose the database:**
- **MongoDB** → `npm install @classytic/mongokit`
- **PostgreSQL/MySQL/SQLite** → `@classytic/prismakit` (coming soon)

> **⚠️ ESM Only**: Arc requires Node.js 20+ with ES modules (`"type": "module"` in package.json). CommonJS is not supported. [Migration guide →](https://nodejs.org/api/esm.html)

---

## Why Arc?

Building REST APIs in Node.js often means making hundreds of small decisions: How do I structure routes? Where does validation go? How do I handle soft deletes consistently? What about multi-tenant isolation?

**Arc gives you conventions so you can focus on your domain, not boilerplate.**

| Without Arc | With Arc |
|-------------|----------|
| Write CRUD routes for every model | `defineResource()` generates them |
| Manually wire controllers to routes | Convention-based auto-wiring |
| Copy-paste soft delete logic | `presets: ['softDelete']` |
| Manually filter by tenant on every query | `presets: ['multiTenant']` auto-filters (configurable `tenantField`) |
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

### Required Peer Dependencies

```bash
npm install fastify@^5.7.4
```

### Optional Dependencies

Arc's security and utility plugins are opt-in via peer dependencies. Install only what you need:

```bash
# Security plugins (recommended for production)
npm install @fastify/helmet @fastify/cors @fastify/rate-limit

# Authentication (pick one)
npm install @fastify/jwt           # Arc's built-in JWT auth (uses fast-jwt internally)
# npm install better-auth          # Better Auth adapter

# Performance plugins
npm install @fastify/under-pressure

# Utility plugins
npm install @fastify/sensible @fastify/multipart fastify-raw-body

# Type-safe schemas (optional)
npm install @sinclair/typebox @fastify/type-provider-typebox

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

**Core:**
- **Resource-First Architecture** — Define your API as resources with `defineResource()`, not scattered route handlers
- **Presets System** — Composable behaviors: `softDelete`, `slugLookup`, `tree`, `ownedByUser`, `multiTenant`, `audited`
- **Function-Based Permissions** — `allowPublic()`, `requireRoles()`, `requireOwnership()`, `allOf()`, `anyOf()`, custom `PermissionCheck` functions
- **Pipeline** — `guard()`, `transform()`, `intercept()` for request processing
- **Database-Agnostic** — Works with any database via adapters (MongoDB/Mongoose optimized, Prisma coming soon)
- **Auto-Generated OpenAPI** — Documentation that stays in sync with your code

**Auth & Multi-Tenant:**
- **Flexible Auth** — Arc JWT (`@fastify/jwt` v10), Better Auth adapter (with org context bridge), custom function, custom plugin, or disabled
- **Organization Module** — Org CRUD, membership management, org-scoped queries, org-level role guards (`requireOrgRole`)
- **Multi-Tenant Isolation** — `multiTenant` preset auto-filters by `organizationId` on all queries

**Integrations:**
- **Domain Events** — Pub/sub with pluggable transports: Memory, Redis Pub/Sub, Redis Streams
- **Job Queue** — BullMQ adapter with `defineJob()`, dispatch, stats, event bridge
- **WebSocket** — Room-based real-time with auto-broadcast of CRUD events, org-scoped broadcasting
- **Streamline Workflows** — REST endpoints for `@classytic/streamline` workflows

**Production:**
- **Health Checks** — Kubernetes-ready liveness/readiness probes with custom checks
- **Audit Trail** — Change tracking with pluggable storage (Memory, MongoDB, custom)
- **Idempotency** — Exactly-once semantics for mutating operations (Memory, Redis, MongoDB stores)
- **OpenTelemetry Tracing** — Distributed tracing with custom spans
- **Graceful Shutdown** — Signal handling, connection draining, cleanup hooks
- **Circuit Breaker** — Prevent cascading failures with automatic fallbacks
- **State Machine** — FSM for workflow states with guards and transition history

**DX:**
- **CLI** — `arc init` (scaffolding), `arc generate` (resources), `arc introspect`, `arc describe` (AI metadata), `arc docs` (OpenAPI)
- **Environment Presets** — `production`, `development`, `testing`, `edge` with sensible defaults
- **TypeBox Integration** — Optional type-safe schemas with full TypeScript inference
- **Pluggable Query Parsers** — Built-in or MongoKit's advanced parser
- **Default Response Schemas** — `fast-json-stringify` for 2-3x faster serialization
- **Ultra-Fast Testing** — In-memory MongoDB, test harness, mock repositories, data factories
- **Tree-Shakable** — 27+ subpath imports, only load what you use

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
  preset: 'production', // or 'development', 'testing', 'edge'
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

Arc supports multiple auth strategies. All are optional and replaceable:

| Strategy | Import | Use Case |
|----------|--------|----------|
| **Arc JWT** | `@classytic/arc/auth` | Simple, production-ready (`@fastify/jwt` v10 / `fast-jwt`) |
| **Better Auth** | `@classytic/arc/auth` | Full-featured auth framework with org/session support |
| **Custom function** | `auth.authenticate` | Full control over authentication logic |
| **Custom plugin** | `auth.plugin` | Bring your own Fastify auth (Passport.js, OAuth, etc.) |
| **Disabled** | `auth: false` | No Arc auth — use your own |

**1. Arc JWT (default):**

```typescript
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  auth: {
    jwt: {
      secret: process.env.JWT_SECRET,      // Required, 32+ chars
      expiresIn: '15m',                    // Access token TTL
      refreshSecret: process.env.JWT_REFRESH_SECRET,
      refreshExpiresIn: '7d',              // Refresh token TTL
    },
  },
});

// Decorates: app.authenticate, app.optionalAuthenticate, app.authorize, app.auth
// app.auth.issueTokens(payload) → { accessToken, refreshToken, expiresIn, tokenType }
// app.auth.verifyRefreshToken(token) → decoded (enforces type === 'refresh')
```

**2. Better Auth adapter** (recommended for SaaS with organizations):

```typescript
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { createBetterAuthAdapter } from '@classytic/arc/auth';

const auth = betterAuth({
  database: ...,
  emailAndPassword: { enabled: true },
  plugins: [organization()],
});

const adapter = createBetterAuthAdapter({
  auth,
  basePath: '/api/auth',
  orgContext: true,  // Auto-extract org membership + roles from session
  // orgContext: { bypassRoles: ['superadmin'] },
});

const app = await createApp({
  auth: { betterAuth: adapter },
});
// Sets: request.user, request.organizationId, request.context.orgRoles, request.context.orgScope
```

**3. Disable or replace auth entirely:**

```typescript
const app = await createApp({ auth: false });
// Or: auth: { plugin: myPassportPlugin }
// Or: auth: { authenticate: async (request, { jwt }) => myUser }
```

### Organization-Based Authorization

For multi-tenant SaaS apps, Arc provides org-level role guards:

```typescript
import { orgGuard, requireOrg, requireOrgRole } from '@classytic/arc/org';

// Require org context (x-organization-id header)
fastify.get('/invoices', {
  preHandler: [fastify.authenticate, requireOrg()],
  handler: invoiceHandler,
});

// Require specific org-level roles
fastify.post('/invoices', {
  preHandler: [fastify.authenticate, requireOrgRole('admin', 'accountant')],
  handler: createInvoiceHandler,
});

// Superadmin users bypass org role checks automatically
```

**Fastify decorators from auth:**

| Decorator | Description |
|-----------|-------------|
| `fastify.authenticate` | Verify JWT/session, set `request.user` (returns 401 on failure) |
| `fastify.optionalAuthenticate` | Parse JWT if present, skip silently if absent (for public routes) |
| `fastify.authorize(...roles)` | Check `user.roles` (returns 403 on failure). `authorize('*')` = any authenticated user |

See [docs/auth.md](docs/auth.md) for full auth documentation.

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
    'multiTenant',     // Tenant isolation (configurable field name)
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
      wrapHandler: true,             // Arc context pattern (IRequestContext)
    },
    {
      method: 'GET',
      path: '/:id/download',
      handler: 'downloadFile',       // Fastify native handler
      permissions: requireAuth(),
      wrapHandler: false,            // Native Fastify (request, reply)
    },
  ],
});
```

### Controllers

Extend BaseController for built-in security and CRUD:

```typescript
import { BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';
import type { ISoftDeleteController, ISlugLookupController } from '@classytic/arc/presets';

// Type-safe controller with preset interfaces
class ProductController
  extends BaseController<Product>
  implements ISoftDeleteController<Product>, ISlugLookupController<Product>
{
  constructor() {
    super(productRepository);
  }

  // Custom method - Arc context pattern
  async getFeatured(req: IRequestContext): Promise<IControllerResponse> {
    const { organizationId } = req;

    const products = await this.repository.findAll({
      filter: { isFeatured: true, organizationId },
    });

    return { success: true, data: products };
  }

  // Preset methods
  async getBySlug(req: IRequestContext): Promise<IControllerResponse> {
    const { slug } = req.params;
    const product = await this.repository.getBySlug(slug);

    if (!product) {
      return { success: false, error: 'Product not found', status: 404 };
    }

    return { success: true, data: product };
  }
}
```

**Preset Type Interfaces:** Arc exports TypeScript interfaces for each preset that requires controller methods:

- `ISoftDeleteController` - requires `getDeleted()` and `restore()`
- `ISlugLookupController` - requires `getBySlug()`
- `ITreeController` - requires `getTree()` and `getChildren()`

**Note:** Presets like `multiTenant`, `ownedByUser`, and `audited` don't require controller methods—they work via middleware.

### Request Context API

Controller methods receive `req: IRequestContext`:

```typescript
interface IRequestContext {
  params: Record<string, string>;           // Route params: /users/:id
  query: Record<string, unknown>;           // Query string: ?page=1
  body: unknown;                            // Request body
  user: UserBase | null;                    // Authenticated user
  headers: Record<string, string | undefined>; // Request headers
  organizationId?: string;                  // Multi-tenant org ID
  metadata?: Record<string, unknown>;       // Custom data, _policyFilters, middleware context
}
```

**Key Fields:**
- `req.metadata` - Custom data from hooks, policies, or middleware
- `req.organizationId` - Set by `multiTenant` preset or org scope plugin
- `req.user` - Set by auth plugin, preserves original auth structure

### TypeScript Strict Mode

For maximum type safety:

```typescript
import { BaseController, IRequestContext, IControllerResponse } from '@classytic/arc';
import type { ISoftDeleteController, ISlugLookupController } from '@classytic/arc/presets';

interface Product {
  _id: string;
  name: string;
  slug: string;
  price: number;
  deletedAt?: Date;
}

class ProductController
  extends BaseController<Product>
  implements ISoftDeleteController<Product>, ISlugLookupController<Product>
{
  async getBySlug(req: IRequestContext): Promise<IControllerResponse<Product>> {
    const { slug } = req.params;
    const product = await this.repository.getBySlug(slug);

    if (!product) {
      return { success: false, error: 'Product not found', status: 404 };
    }

    return { success: true, data: product };
  }

  async getDeleted(req: IRequestContext): Promise<IControllerResponse<Product[]>> {
    const products = await this.repository.findDeleted();
    return { success: true, data: products };
  }

  async restore(req: IRequestContext): Promise<IControllerResponse<Product>> {
    const { id } = req.params;
    const product = await this.repository.restore(id);
    return { success: true, data: product };
  }
}
```

**Benefits:**
- Compile-time type checking
- IntelliSense autocomplete
- Safe refactoring

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

## Query Parsing

Arc includes a built-in query parser and supports pluggable parsers from database kits.

### Built-in ArcQueryParser

Handles standard REST query patterns out of the box:

```bash
# Pagination
GET /products?page=2&limit=20

# Sorting (- prefix = descending)
GET /products?sort=-createdAt,name

# Field selection
GET /products?select=name,price,status

# Filtering with operators
GET /products?price[gte]=100&price[lte]=500&status=active

# Search
GET /products?search=keyword

# Populate relations
GET /products?populate=category,brand
```

**Supported filter operators:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`, `contains`, `regex`, `exists`

**Security built-in:**
- ReDoS protection on regex filters (dangerous patterns auto-escaped)
- Field name validation prevents `$`-injection
- Configurable limits for regex length, search length, and filter depth

```typescript
import { createQueryParser } from '@classytic/arc/utils';

const parser = createQueryParser({
  maxLimit: 100,       // Max items per page (default: 1000)
  defaultLimit: 20,    // Default items per page
  maxRegexLength: 500, // Max regex pattern length
  maxSearchLength: 200,// Max search query length
});
```

### MongoKit QueryParser (Advanced)

For advanced MongoDB features, use MongoKit's QueryParser:

```typescript
import { QueryParser } from '@classytic/mongokit';

const productResource = defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
  queryParser: new QueryParser(),  // Swap in MongoKit's parser
  // ...
});
```

**Advanced populate with field selection:**

```bash
# Select specific fields from populated documents
GET /posts?populate[author][select]=name,email

# Multiple populations with different selections
GET /orders?populate[customer][select]=name,phone&populate[items][select]=name,price
```

This generates Mongoose-compatible populate options:
```typescript
// ?populate[author][select]=name,email
// → { path: 'author', select: 'name email' }
```

---

## Default Response Schemas

CRUD routes automatically include response schemas, enabling Fastify's `fast-json-stringify` for 2-3x faster serialization and preventing accidental field disclosure.

```typescript
// No configuration needed — defaults are applied automatically
const productResource = defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
  // Default response schemas are applied to all CRUD routes
});
```

**Default schemas per route:**
| Route | Response Schema |
|-------|----------------|
| `GET /` | `{ success, docs: [...], page, limit, total, pages, hasNext, hasPrev }` |
| `GET /:id` | `{ success, data: {...} }` |
| `POST /` | `{ success, data: {...}, message? }` |
| `PATCH /:id` | `{ success, data: {...} }` |
| `DELETE /:id` | `{ success, message? }` |

**Override with specific schemas** for full serialization performance:

```typescript
import { listResponse, itemResponse, mutationResponse, deleteResponse } from '@classytic/arc/utils';

const productSchema = {
  type: 'object',
  properties: {
    _id: { type: 'string' },
    name: { type: 'string' },
    price: { type: 'number' },
  },
};

const productResource = defineResource({
  name: 'product',
  schemas: {
    list: { response: { 200: listResponse(productSchema) } },
    get: { response: { 200: itemResponse(productSchema) } },
    create: { response: { 201: mutationResponse(productSchema) } },
    delete: { response: { 200: deleteResponse() } },
  },
  // ...
});
```

---

## TypeBox Integration (Optional)

For type-safe schemas with full TypeScript inference, install TypeBox:

```bash
npm install @sinclair/typebox @fastify/type-provider-typebox
```

### Enable in createApp

```typescript
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  preset: 'production',
  typeProvider: 'typebox',  // Enables TypeBox validator compiler
  auth: { jwt: { secret: process.env.JWT_SECRET } },
});
```

### Use Arc's TypeBox schema helpers

```typescript
import { Type, ArcListResponse, ArcItemResponse, ArcPaginationQuery } from '@classytic/arc/schemas';

const ProductSchema = Type.Object({
  _id: Type.String(),
  name: Type.String(),
  price: Type.Number(),
  createdAt: Type.String({ format: 'date-time' }),
});

// Use in route definitions — full TypeScript inference on request/response
fastify.get('/products', {
  schema: {
    querystring: ArcPaginationQuery(),
    response: { 200: ArcListResponse(ProductSchema) },
  },
}, handler);
```

**Available schema helpers:**
| Helper | Description |
|--------|-------------|
| `ArcListResponse(schema)` | Paginated list: `{ success, docs, page, limit, total, ... }` |
| `ArcItemResponse(schema)` | Single item: `{ success, data }` |
| `ArcMutationResponse(schema)` | Create/update: `{ success, data, message? }` |
| `ArcDeleteResponse()` | Delete: `{ success, message? }` |
| `ArcErrorResponse()` | Error: `{ success: false, error, code?, message? }` |
| `ArcPaginationQuery()` | Query params: `{ page?, limit?, sort?, select?, populate? }` |

---

## CLI

```bash
# Initialize a new project (interactive prompts)
arc init my-api

# Non-interactive with all flags
arc init my-api --mongokit --better-auth --single --ts
arc init my-api --mongokit --jwt --single --js     # JWT auth, JavaScript
arc init my-api --mongokit --multi --ts            # Multi-tenant

# Generate resources
arc generate resource product    # Full resource (model, repo, controller, schemas, resource def)
arc g r invoice                  # Shorthand
arc g controller auth            # Controller only
arc g model order                # Model only
arc g repository payment         # Repository only
arc g schemas ticket             # Schemas only

# Introspect and document
arc introspect --entry ./dist/index.js             # Show registered resources
arc describe ./dist/resources.js                   # JSON metadata for AI agents
arc describe ./dist/resources.js product --json    # Single resource
arc docs ./docs/openapi.json --entry ./dist/index.js  # Export OpenAPI spec
```

**Init flags:** `--mongokit` | `--custom` | `--better-auth` | `--jwt` | `--multi` | `--single` | `--ts` | `--js` | `--edge` | `--force` | `--skip-install`

**Generate types:** `resource (r)` | `controller (c)` | `model (m)` | `repository (repo)` | `schemas (s)` — auto-detects TypeScript from `tsconfig.json`

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

### Edge/Serverless
- Minimal cold-start overhead (disables all heavy plugins)
- No helmet, CORS, rate limiting (handled by API Gateway / CDN)
- No health monitoring (Lambda/runtime manages health)
- No multipart/rawBody (use pre-signed URLs)
- No Arc lifecycle plugins (requestId, health, gracefulShutdown)
- Warn-level logging only
- Events still enabled for business logic

```typescript
const app = await createApp({
  preset: 'edge',
  auth: { jwt: { secret: process.env.JWT_SECRET } },
});
```

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

Instance-scoped lifecycle hooks with shortcut functions:

```typescript
import { createHookSystem, beforeCreate, afterUpdate, defineHook } from '@classytic/arc/hooks';

const hooks = createHookSystem();

// Shortcut functions
beforeCreate(hooks, 'product', async (ctx) => {
  ctx.data.slug = slugify(ctx.data.name);
});

afterUpdate(hooks, 'product', async (ctx) => {
  await invalidateCache(ctx.result._id);
});

// Full defineHook API with priority + dependencies
const hook = defineHook({
  name: 'normalize',
  resource: 'product',
  operation: 'create',
  phase: 'before',
  handler: async (ctx) => { ctx.data.normalizedName = ctx.data.name.toLowerCase(); },
  priority: 5,             // lower = earlier (default: 10)
  dependsOn: ['validate'], // topological sort
});
hook.register(hooks);       // returns unregister function

// Available: beforeCreate, afterCreate, beforeUpdate, afterUpdate, beforeDelete, afterDelete
```

## Policies

```typescript
import { createAccessControlPolicy } from '@classytic/arc/policies';

const editorPolicy = createAccessControlPolicy({
  statements: [
    { resource: 'document', action: ['create', 'update'] },
    { resource: 'comment', action: ['create', 'read'] },
  ],
});

// Use as a permission check
export default defineResource({
  name: 'document',
  permissions: {
    create: editorPolicy,
    update: editorPolicy,
  },
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
import { tracingPlugin } from '@classytic/arc/plugins/tracing';

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

## Integrations

All integrations are separate subpath imports — only loaded when explicitly used.

### Job Queue (BullMQ)

```typescript
import { jobsPlugin, defineJob } from '@classytic/arc/integrations/jobs';

const sendEmail = defineJob({
  name: 'send-email',
  handler: async (data) => { await emailService.send(data.to, data.subject, data.body); },
  retries: 3,
  backoff: { type: 'exponential', delay: 1000 },
});

await fastify.register(jobsPlugin, {
  connection: { host: 'localhost', port: 6379 },
  jobs: [sendEmail],
  bridgeEvents: true,  // Emit job.send-email.completed / job.send-email.failed
});

await fastify.jobs.dispatch('send-email', { to: 'user@example.com', subject: 'Hi', body: 'Hello' });
```

### WebSocket (Real-Time)

```typescript
import { websocketPlugin } from '@classytic/arc/integrations/websocket';

await fastify.register(websocketPlugin, {
  path: '/ws',
  auth: true,
  resources: ['product', 'order'],  // Auto-broadcast CRUD events
  heartbeatInterval: 30000,
});

// Org-scoped broadcast (only clients in same org)
fastify.ws.broadcastToOrg('org-456', 'product', { action: 'price-updated' });
```

### Streamline Workflows

```typescript
import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
import { createWorkflow } from '@classytic/streamline';

const orderWorkflow = createWorkflow({ id: 'order', name: 'Order Processing', steps: { ... } });

await fastify.register(streamlinePlugin, {
  workflows: [orderWorkflow],
  prefix: '/api/workflows',
  auth: true,
  bridgeEvents: true,
});
// Auto-generates: POST /start, GET /runs/:runId, POST /resume, POST /cancel, etc.
```

### Audit Trail

```typescript
import { auditPlugin } from '@classytic/arc/audit';

await fastify.register(auditPlugin, {
  enabled: true,
  stores: ['mongodb'],
  mongoConnection: mongoose.connection,
  ttlDays: 90,
});

await fastify.audit.create('product', product._id, product, request.auditContext);
await fastify.audit.update('product', id, before, after, request.auditContext);
```

### Idempotency

```typescript
import { idempotencyPlugin } from '@classytic/arc/idempotency';

await fastify.register(idempotencyPlugin, {
  enabled: true,
  ttlMs: 86400000,           // 24 hours
  methods: ['POST', 'PUT', 'PATCH'],
  include: [/\/orders/],
});
// Client sends: Idempotency-Key header → first request processes, retries return cached response
```

See [docs/](docs/) for detailed integration guides.

## Battle-Tested Deployments

Arc has been validated in multiple production environments:

### Environment Compatibility

| Environment | Status | Notes |
|-------------|--------|-------|
| Docker | ✅ Tested | Use Node 20+ Alpine images |
| Kubernetes | ✅ Tested | Health checks + graceful shutdown built-in |
| AWS Lambda | ✅ Tested | Use `@fastify/aws-lambda` adapter |
| Google Cloud Run | ✅ Tested | Auto-scales, health checks work OOTB |
| Vercel Serverless | ✅ Tested | Use serverless functions adapter |
| Bare Metal / VPS | ✅ Tested | PM2 or systemd recommended |
| Railway / Render | ✅ Tested | Works with zero config |

### Production Checklist

Before deploying to production:

```typescript
import { createApp } from '@classytic/arc/factory';

// 1. Validate environment variables in your app code before startup
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set and at least 32 chars');
}

// 2. Use production preset
const app = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET } },

  // 3. Configure CORS explicitly in production
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [],
    credentials: true,
  },

  // 4. Adjust rate limits for your traffic
  rateLimit: {
    max: 300,
    timeWindow: '1 minute',
  },

  // 5. Arc health endpoints are enabled by default
  arcPlugins: {
    health: true,
    gracefulShutdown: true,
  },
});

// 6. Graceful shutdown
process.on('SIGTERM', () => app.close());
process.on('SIGINT', () => app.close());
```

### Multi-Region Deployment

For globally distributed apps:

```typescript
import mongoose from 'mongoose';
import { createApp } from '@classytic/arc/factory';
import { tracingPlugin } from '@classytic/arc/plugins/tracing';

// Database topology is configured by your DB client/driver
await mongoose.connect(process.env.MONGODB_URI!);

const app = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET! } },
});

await app.register(tracingPlugin, {
  serviceName: `api-${process.env.REGION ?? 'local'}`,
});
```

### Load Testing Results

Performance depends on your handlers, database, infra, and network.  
Benchmark your own workload (preferably with production-like data) before capacity planning.

## Performance Tips

1. **Use Proxy Compression** - Use Nginx/Caddy or CDN for Brotli/gzip compression
2. **Enable Memory Monitoring** - Detect leaks early in production
3. **Use Testing Preset** - Minimal overhead for test suites
4. **Apply Indexes** - Always index query fields in models
5. **Use Lean Queries** - Repository returns plain objects by default
6. **Rate Limiting** - Protect endpoints from abuse
7. **Validate Early** - Validate required environment variables at startup
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

## Version Compatibility

### Package Versions

| Package | Minimum | Recommended |
|---------|---------|-------------|
| `fastify` | ^5.0.0 | ^5.7.4 |
| `@fastify/jwt` | ^10.0.0 | ^10.0.0 |
| `@classytic/mongokit` | ^3.1.6 | ^3.2.1 |
| `mongoose` | ^8.0.0 or ^9.0.0 | ^9.2.1 |
| `@sinclair/typebox` | ^0.34.0 | ^0.34.0 |
| Node.js | 20+ | 22+ |

### Migrating from @fastify/jwt v9 to v10

Arc v2.0 requires `@fastify/jwt` v10, which replaces `jsonwebtoken` with `fast-jwt` internally:

- **No code changes needed** for standard `secret` + `expiresIn` usage
- If you pass sign/verify options directly, some were renamed:
  - `audience` → `aud` / `allowedAud`
  - `issuer` → `iss` / `allowedIss`
  - `subject` → `sub` / `allowedSub`
- `@fastify/jwt` is an optional peer dependency — npm will warn (not error) if you have v9 installed

### Upgrading Arc

```bash
# Update Arc
npm install @classytic/arc@latest

# Update peer dependencies
npm install fastify@^5.7.4 @fastify/jwt@^10.0.0

# Optional: add TypeBox support
npm install @sinclair/typebox @fastify/type-provider-typebox
```

## Subpath Imports (Tree-Shaking)

```typescript
import { defineResource, BaseController, allowPublic, requireRoles } from '@classytic/arc';
import { createApp } from '@classytic/arc/factory';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { createBetterAuthAdapter } from '@classytic/arc/auth';
import { orgGuard, requireOrg, requireOrgRole } from '@classytic/arc/org';
import { eventPlugin } from '@classytic/arc/events';
import { RedisEventTransport } from '@classytic/arc/events/redis';
import { jobsPlugin, defineJob } from '@classytic/arc/integrations/jobs';
import { websocketPlugin } from '@classytic/arc/integrations/websocket';
import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
import { healthPlugin, gracefulShutdownPlugin } from '@classytic/arc/plugins';
import { tracingPlugin } from '@classytic/arc/plugins/tracing';
import { auditPlugin } from '@classytic/arc/audit';
import { idempotencyPlugin } from '@classytic/arc/idempotency';
import { createHookSystem, beforeCreate } from '@classytic/arc/hooks';
import { registerPreset, ISoftDeleteController } from '@classytic/arc/presets';
import { createStateMachine, CircuitBreaker } from '@classytic/arc/utils';
import { createTestApp, TestHarness } from '@classytic/arc/testing';
import { defineMigration } from '@classytic/arc/migrations';
import { createAccessControlPolicy } from '@classytic/arc/policies';
import { Type, ArcListResponse } from '@classytic/arc/schemas';
```

## Documentation

| Guide | Description |
|-------|-------------|
| [docs/auth.md](docs/auth.md) | JWT, Better Auth, custom auth, multi-tenant auth |
| [docs/permissions.md](docs/permissions.md) | Permission functions, RBAC, ABAC, custom providers |
| [docs/presets.md](docs/presets.md) | softDelete, slugLookup, tree, ownedByUser, multiTenant, audited |
| [docs/core.md](docs/core.md) | Resource definition, controllers, adapters |
| [docs/events.md](docs/events.md) | Domain events, transports (Memory/Redis/Streams) |
| [docs/hooks.md](docs/hooks.md) | Lifecycle hooks, priority, dependencies |
| [docs/org.md](docs/org.md) | Organization module, membership, org-scoped queries |
| [docs/plugins.md](docs/plugins.md) | Health, graceful shutdown, request ID, SSE |
| [docs/audit.md](docs/audit.md) | Audit trail with pluggable storage |
| [docs/idempotency.md](docs/idempotency.md) | Exactly-once semantics for mutations |
| [docs/factory.md](docs/factory.md) | createApp() factory and presets |
| [docs/openapi.md](docs/openapi.md) | OpenAPI spec generation |
| [docs/registry.md](docs/registry.md) | Resource introspection |
| [docs/setup.md](docs/setup.md) | Project setup guide |
| [docs/tree-shaking.md](docs/tree-shaking.md) | Subpath imports reference |
| [docs/custom-adapters.md](docs/custom-adapters.md) | Building custom database adapters |

### Agent Skills

Install Arc's agent skills for AI-assisted development:

```bash
npx skills add classytic/arc
```

## License

MIT
