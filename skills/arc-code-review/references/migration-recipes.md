# Arc Migration Recipes — Before / After

Concrete diffs for the most common transformations. Apply in the order listed in [SKILL.md](../SKILL.md#audit-workflow). Each recipe shows the *minimum* arc replacement — add presets and field rules as the audit reveals them.

---

## §0. arc 2.x → 3.0 — every kit-specific adapter moves to its kit

**Why:** Through arc 2.12, kit-specific adapter factories (`createMongooseAdapter`, `createDrizzleAdapter`, `createPrismaAdapter`) shipped from `@classytic/arc` and arc had a peer dep on `@classytic/mongokit`. This coupled arc's release cadence to every kit's, dragged mongoose into every arc consumer's resolution graph (even Drizzle/Prisma users), and double-published the adapter contract types.

In arc 2.12:
- Adapter contract → `@classytic/repo-core/adapter` (new subpath in repo-core 0.4.0).
- Mongoose adapter → `@classytic/mongokit/adapter` (3.13.0).
- Drizzle adapter → `@classytic/sqlitekit/adapter` (0.3.0).
- Prisma adapter → `@classytic/prismakit/adapter` (0.1.0 — new kit).
- `mergeFieldRuleConstraints` + `applyNullable` → `@classytic/repo-core/schema`.
- `@classytic/mongokit`, `@prisma/client`, `mongoose` all dropped from arc's `peerDependencies`. Arc 2.12 has zero kit- or driver-bound peers.
- The `@classytic/arc/adapters` subpath was removed entirely. The `src/adapters/` directory inside arc is gone.
- `RepositoryLike` is still re-exported from `@classytic/arc` for convenience.
- Custom kits implementing `DataAdapter<TDoc>` plug in identically — same contract, no special-casing.

### Coordinated versions

| Package | Min |
|---|---|
| `@classytic/arc` | 2.12.0 |
| `@classytic/repo-core` | 0.4.0 |
| `@classytic/mongokit` | 3.13.0 |
| `@classytic/sqlitekit` | 0.3.0 |
| `@classytic/prismakit` | 0.1.0 |

### Import migration table

| Old (arc 2.11.x) | New (arc 2.12+) |
|---|---|
| `import { createMongooseAdapter } from '@classytic/arc'` | `import { createMongooseAdapter } from '@classytic/mongokit/adapter'` |
| `import { createMongooseAdapter } from '@classytic/arc/adapters'` | `import { createMongooseAdapter } from '@classytic/mongokit/adapter'` |
| `import { createDrizzleAdapter } from '@classytic/arc/adapters'` | `import { createDrizzleAdapter } from '@classytic/sqlitekit/adapter'` |
| `import { createPrismaAdapter } from '@classytic/arc/adapters'` | `import { createPrismaAdapter } from '@classytic/prismakit/adapter'` |
| `import type { DataAdapter, RepositoryLike, AdapterRepositoryInput } from '@classytic/arc'` | `import type { DataAdapter, RepositoryLike, AdapterRepositoryInput } from '@classytic/repo-core/adapter'` |
| `import type { ... } from '@classytic/arc/adapters'` (any contract type) | `import type { ... } from '@classytic/repo-core/adapter'` |
| `import type { InferMongooseDoc } from '@classytic/arc/adapters'` | `import type { InferMongooseDoc } from '@classytic/mongokit/adapter'` |
| `import { mergeFieldRuleConstraints } from '@classytic/arc/adapters'` | `import { mergeFieldRuleConstraints } from '@classytic/repo-core/schema'` |
| `MongooseAdapter`, `DrizzleAdapter`, `PrismaAdapter` (classes) | Same path moves: `@classytic/mongokit/adapter` / `@classytic/sqlitekit/adapter` / `@classytic/prismakit/adapter` |
| Any `from '@classytic/arc/adapters'` import | The subpath was removed in arc 2.12 — re-route to the kit or repo-core per the rows above. |

### Mechanical steps

1. Bump versions in `package.json` to the matrix above. Drop `mongoose` from explicit deps if you only used it for the adapter — mongokit will pull it as its own peer.
2. Run a project-wide find/replace using the table above. Detection regex: see anti-patterns.md §32g.
3. `npx tsc --noEmit` — zero errors.
4. Smoke test the resource OpenAPI endpoint and one MCP tool — confirm the schema is non-empty (still requires `schemaGenerator`).

No runtime behavior change — the symbols are identical, only their package paths moved.

---

## §1. Manual CRUD module → `defineResource()`

**Scope:** typically 5 routes (`GET`, `GET /:id`, `POST`, `PATCH /:id`, `DELETE /:id`) + ~150 LOC of pagination/validation/permission glue per resource.

### Before

```typescript
// routes/products.ts (≈170 LOC)
import { Product } from '../models/product.js';
import { z } from 'zod';

const createBody = z.object({
  name: z.string().min(1),
  price: z.number().min(0),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
});

export async function productRoutes(fastify) {
  fastify.get('/products', async (req) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const filters: any = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.user) filters.organizationId = req.user.orgId;        // tenant scope
    const items = await Product.find(filters)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    const total = await Product.countDocuments(filters);
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  });

  fastify.get('/products/:id', async (req) => {
    const item = await Product.findOne({ _id: req.params.id, organizationId: req.user?.orgId });
    if (!item) throw fastify.httpErrors.notFound();
    return item;
  });

  fastify.post('/products', async (req, reply) => {
    if (!req.user) throw fastify.httpErrors.unauthorized();
    if (!req.user.roles.includes('admin')) throw fastify.httpErrors.forbidden();
    const data = createBody.parse(req.body);
    const item = await Product.create({ ...data, organizationId: req.user.orgId });
    await fastify.events.emit('product.created', { id: item._id });
    return reply.code(201).send(item);
  });

  fastify.patch('/products/:id', async (req) => {
    if (!req.user) throw fastify.httpErrors.unauthorized();
    if (!req.user.roles.includes('admin')) throw fastify.httpErrors.forbidden();
    const item = await Product.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.user.orgId },
      req.body,
      { new: true, runValidators: true },
    );
    if (!item) throw fastify.httpErrors.notFound();
    return item;
  });

  fastify.delete('/products/:id', async (req, reply) => {
    if (!req.user || !req.user.roles.includes('admin')) throw fastify.httpErrors.forbidden();
    const result = await Product.deleteOne({ _id: req.params.id, organizationId: req.user.orgId });
    if (result.deletedCount === 0) throw fastify.httpErrors.notFound();
    return reply.code(204).send();
  });
}
```

### After

```typescript
// resources/product/product.resource.ts (≈30 LOC)
import { defineResource, requireRoles, allowPublic } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { Repository, buildCrudSchemasFromModel } from '@classytic/mongokit';
import { Product } from './product.model.js';

const productRepo = new Repository(Product);

export const productResource = defineResource({
  name: 'product',

  adapter: createMongooseAdapter({
    model: Product,
    repository: productRepo,
    schemaGenerator: buildCrudSchemasFromModel,
  }),

  presets: [{ name: 'multiTenant', tenantField: 'organizationId' }],

  permissions: {
    list:   allowPublic(),
    get:    allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },

  schemaOptions: {
    fieldRules: {
      name:   { type: 'string', minLength: 1, required: true },
      price:  { type: 'number', minimum: 0, required: true },
      status: { type: 'string', enum: ['draft', 'active', 'archived'], default: 'draft' },
      organizationId: { systemManaged: true },
    },
  },

  events: { created: {}, updated: {}, deleted: {} },
});
```

```typescript
// app.ts
import { createApp } from '@classytic/arc/factory';
import { productResource } from './resources/product/product.resource.js';

const app = await createApp({
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET! } },
  resources: [productResource],
});
await app.listen({ port: 8040 });
```

**What changed:**
- 170 LOC → 30 LOC (≈82% reduction).
- Tenant scoping via preset, not duplicated `organizationId` filter.
- `requireRoles(['admin'])` declarative, no inline 401/403 throws.
- Events auto-emitted; no `await fastify.events.emit('product.created', ...)`.
- Validation via `fieldRules` — both AJV (request) and OpenAPI (docs) derived.
- 404/422/409 mapped automatically via arc's error resolution chain.

---

## §2. Inline permission checks → declarative combinators

### Before
```typescript
fastify.patch('/posts/:id', async (req) => {
  if (!req.user) throw fastify.httpErrors.unauthorized();
  const post = await Post.findById(req.params.id);
  if (!post) throw fastify.httpErrors.notFound();
  const isAuthor = post.authorId.toString() === req.user.id;
  const isAdmin  = req.user.roles?.includes('admin');
  if (!isAuthor && !isAdmin) throw fastify.httpErrors.forbidden();
  // ... mutate
});
```

### After
```typescript
import { defineResource, anyOf, requireRoles, requireOwnership } from '@classytic/arc';

defineResource({
  name: 'post',
  permissions: {
    update: anyOf(requireRoles(['admin']), requireOwnership('authorId')),
    delete: requireRoles(['admin']),
  },
});
```

Ownership check is row-level (`requireOwnership` returns `filters: { authorId: userId }` for non-admins, propagated into the repo query).

For mixed human + service auth: `anyOf(requireOrgRole('admin'), requireServiceScope('jobs:bulk-write'))`.

---

## §3. Manual `toJSON` transforms → `fieldRules.hidden`

### Before
```typescript
// user.model.ts
const userSchema = new Schema({ name: String, email: String, password: String, mfaSecret: String });
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.mfaSecret;
    delete ret.__v;
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});
```
(And easy to forget on a new sensitive field. Doesn't fire on `.lean()`.)

### After
```typescript
// user.resource.ts
import { fields } from '@classytic/arc';

defineResource({
  name: 'user',
  schemaOptions: {
    fieldRules: {
      password:  fields.hidden(),
      mfaSecret: fields.hidden(),
      salary:    fields.visibleTo(['admin', 'hr']),
      email:     fields.redactFor(['viewer'], '***'),
    },
  },
});
```
Applies at framework serialization for both REST and MCP. Works with lean reads. New sensitive fields go in one place.

---

## §4. Hand-coded soft-delete → `presets: ['softDelete']`

### Before
```typescript
defineResource({
  name: 'order',
  schemaOptions: { fieldRules: { deletedAt: { type: 'date', nullable: true } } },
  routes: [
    { method: 'GET', path: '/deleted', handler: 'listDeleted', permissions: requireRoles(['admin']) },
    { method: 'POST', path: '/:id/restore', handler: 'restore', permissions: requireRoles(['admin']) },
  ],
  hooks: {
    afterDelete: async (ctx) => repo.updateOne(ctx.meta.id, { deletedAt: new Date() }),
  },
});
// Plus filter `deletedAt: null` injected in every read manually
```

### After
```typescript
defineResource({
  name: 'order',
  presets: ['softDelete'],   // adds /deleted, /:id/restore, deletedAt field, filter injection
});
```
Deep config: `{ name: 'softDelete', deletedField: 'archivedAt' }`.

---

## §5. Manual events → declarative `events` + `hooks`

### Before
```typescript
fastify.post('/orders', async (req, reply) => {
  const order = await orderRepo.create(req.body);
  await eventBus.emit('order.created', { id: order._id, customer: order.customerId });
  return order;
});
fastify.patch('/orders/:id', async (req) => {
  const order = await orderRepo.update(req.params.id, req.body);
  // forgot to emit 'order.updated' — silent inconsistency
  return order;
});
fastify.post('/orders/:id/refund', async (req) => {
  await orderRepo.refund(req.params.id);
  await eventBus.emit('order.refunded', { id: req.params.id });
});
```

### After
```typescript
defineResource({
  name: 'order',
  events: {
    created:  {},
    updated:  {},
    deleted:  {},
    refunded: { description: 'Order refunded', schema: { reason: 'string' } },
  },
  actions: {
    refund: {
      handler: async (id, data, req) => {
        const result = await orderRepo.refund(id, data.reason);
        await req.fastify.events.publish('order.refunded', { id, reason: data.reason });
        return result;
      },
      permissions: requireRoles(['admin']),
    },
  },
});
```
CRUD events fire automatically. Custom events stay in handlers but are now co-located with permissions.

For at-least-once delivery, wire `EventOutbox`:
```typescript
import { EventOutbox } from '@classytic/arc/events';
new EventOutbox({ repository: outboxRepo, transport });
```

---

## §6. Manual cache + invalidation → `cache` config

### Before
```typescript
fastify.get('/products', async (req) => {
  const cached = await redis.get('products-list');
  if (cached) return JSON.parse(cached);
  const items = await Product.find({});
  await redis.setex('products-list', 30, JSON.stringify(items));
  return items;
});
fastify.post('/products', async (req) => {
  const item = await Product.create(req.body);
  await redis.del('products-list');
  await redis.del(`product-${item._id}`);
  return item;
});
```

### After
```typescript
const app = await createApp({
  arcPlugins: { queryCache: true },
  stores: { queryCache: new RedisCacheStore({ client: redis }) },
});

defineResource({
  name: 'product',
  cache: { staleTime: 30, gcTime: 300, tags: ['catalog'] },
});
```
Mutations bump the resource version; reads see the new state on next miss. Response: `x-cache: HIT | STALE | MISS`.

For cross-resource invalidation:
```typescript
cache: { tags: ['catalog'], invalidateOn: { 'category.*': ['catalog'] } }
```

---

## §7. `req.user._id` access → scope accessors

### Before
```typescript
app.post('/orders', async (req) => {
  const userId = req.user._id;          // crashes on public route
  const orgId  = req.user.orgId;        // undefined for service tokens
  return orderRepo.create({ ...req.body, userId, orgId });
});
```

### After
```typescript
import { getUserId, getOrgId, isAuthenticated, hasOrgAccess } from '@classytic/arc/scope';

app.post('/orders', async (req, reply) => {
  if (!isAuthenticated(req.scope)) return reply.unauthorized();
  return orderRepo.create({
    ...req.body,
    userId: getUserId(req.scope),
    orgId:  getOrgId(req.scope),
  });
});
```
Even better — make it declarative via permission `filters` and let arc inject `userId`/`orgId` server-side:
```typescript
permissions: { create: allOf(requireAuth(), requireOrgMembership()) },
hooks: {
  beforeCreate: async (ctx) => {
    ctx.data.userId = getUserId(ctx.request.scope);
    ctx.data.orgId  = getOrgId(ctx.request.scope);
  },
},
// Or use ownedByUser + multiTenant presets which inject these automatically.
```

---

## §8. Driver imports leaking out of adapters

### Before
```typescript
// services/orderService.ts — service layer importing mongoose
import mongoose from 'mongoose';
import { Order } from '../models/order.js';

export class OrderService {
  async fulfill(id: string) {
    const session = await mongoose.startSession();
    return session.withTransaction(async () => {
      const order = await Order.findById(id).session(session);
      // ...
    });
  }
}
```

### After
```typescript
// services/orderService.ts — DB-agnostic
import type { RepositoryLike } from '@classytic/repo-core/adapter';

export class OrderService {
  constructor(private orderRepo: RepositoryLike<Order>) {}

  async fulfill(id: string) {
    return this.orderRepo.withTransaction!(async (session) => {
      const order = await this.orderRepo.getOne(id, { session });
      // ...
    });
  }
}

// adapters/order.adapter.ts — only place mongoose appears
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { Order } from '../models/order.js';
export const orderRepo = new Repository(Order);
```
Service tests now use any `RepositoryLike` mock — no `mongodb-memory-server` required for unit tests.

---

## §9. Hand-rolled MCP tools → `mcpPlugin`

### Before
```typescript
// mcp/tools.ts — 200+ LOC of MCP plumbing
const tools = [
  {
    name: 'list_products',
    description: 'List products',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
    handler: async (input) => Product.find(input).limit(20).lean(),
  },
  { name: 'create_product', /* ... */ },
];
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);
  return tool.handler(request.params.arguments);
});
```

### After
```typescript
import { mcpPlugin } from '@classytic/arc/mcp';

await app.register(mcpPlugin, {
  resources: [productResource, orderResource],
  auth: false,                              // or getAuth() / custom
  exclude: ['credential'],
});
// 5 CRUD tools + custom routes + actions auto-generated per resource.
// Permissions and field rules carry through.
```
For domain-specific tools, use `extraTools: buildMcpToolsFromBridges([...])`.

---

## §10. Hand-coded `Idempotency-Key` → `idempotencyPlugin`

### Before
```typescript
fastify.post('/payments', async (req) => {
  const key = req.headers['idempotency-key'];
  if (key) {
    const existing = await Idempotency.findOne({ key });
    if (existing) return existing.response;
  }
  const result = await processPayment(req.body);
  if (key) await Idempotency.create({ key, response: result, expiresAt: ... });
  return result;
});
```

### After
```typescript
import { idempotencyPlugin } from '@classytic/arc/idempotency';

await app.register(idempotencyPlugin, {
  repository: idempotencyRepo,            // any RepositoryLike with getOne/deleteMany/findOneAndUpdate
  ttlMs: 24 * 3600_000,
});
```
Applies to all mutating routes that accept `Idempotency-Key` header.

---

## §11. Manual job queue wiring → `jobsPlugin`

### Before
```typescript
import { Queue, Worker } from 'bullmq';
const emailQueue = new Queue('email', { connection: redis });
new Worker('email', processor, { connection: redis });
fastify.post('/users', async (req) => {
  const user = await User.create(req.body);
  await emailQueue.add('welcome', { userId: user._id });
});
```

### After
```typescript
import { jobsPlugin } from '@classytic/arc/integrations/jobs';

await app.register(jobsPlugin, {
  queues: { email: { handler: emailHandler } },
  redis,
});

defineResource({
  name: 'user',
  events: { created: {} },
  hooks: {
    afterCreate: async (ctx) => {
      await ctx.fastify.jobs.email.add('welcome', { userId: ctx.result._id });
    },
  },
});
```
Or wire from an event handler subscribed to `user.created`.

---

## §12. Custom controller → mixin composition

### Before — full custom controller (loses preset wiring)
```typescript
class OrderController {
  constructor(private repo: OrderRepository) {}
  async list(req) { /* manual pagination */ }
  async getById(req) { /* manual lookup */ }
  async create(req) { /* manual validation + permission */ }
  async update(req) { /* ... */ }
  async delete(req) { /* ... */ }
  async restore(req) { /* manual soft-delete handling */ }
  async bulkCreate(req) { /* manual bulk */ }
}
```

### After — mixin composition
```typescript
import { BaseCrudController, SoftDeleteMixin, BulkMixin } from '@classytic/arc';

class OrderController extends SoftDeleteMixin(BulkMixin(BaseCrudController))<Order> {
  // domain methods only
  async fulfill(id, data, req) { return orderService.fulfill(id, getUserId(req.scope)); }
}

defineResource({
  name: 'order',
  controller: new OrderController(orderRepo, { resourceName: 'order' }),
  presets: ['softDelete', 'bulk'],
  routes: [{ method: 'POST', path: '/:id/fulfill', handler: 'fulfill', permissions: requireRoles(['admin']) }],
});
```
Available mixins: `SoftDeleteMixin`, `TreeMixin`, `SlugMixin`, `BulkMixin`. Or skip the controller entirely and let arc auto-build `BaseController`.

---

## §13. Multi-tenancy from middleware → `multiTenantPreset`

### Before
```typescript
app.addHook('preHandler', async (req, reply) => {
  const orgId = req.headers['x-org-id'];
  if (!orgId) return reply.code(400).send({ error: 'Missing org' });
  req.orgId = orgId;
});
fastify.get('/jobs', async (req) => Job.find({ orgId: req.orgId }));
fastify.post('/jobs', async (req) => Job.create({ ...req.body, orgId: req.orgId }));
// Repeated across every resource and every CRUD method
```

### After
```typescript
defineResource({
  name: 'job',
  presets: [{ name: 'multiTenant', tenantField: 'organizationId' }],
});
// Tenant filter auto-applied to every read; org auto-injected on create/update;
// body 'organizationId' overwritten with caller's scope on update (closes tenant-hop).
```

For multi-level (org + branch + project):
```typescript
import { multiTenantPreset } from '@classytic/arc/presets';

defineResource({
  presets: [multiTenantPreset({
    tenantFields: [
      { field: 'organizationId', type: 'org' },
      { field: 'branchId',  contextKey: 'branchId' },
      { field: 'projectId', contextKey: 'projectId' },
    ],
  })],
});
```
Populate `scope.context` and `scope.ancestorOrgIds` in the auth function — see `references/multi-tenancy.md` in the `arc` skill.

---

## §14. Test setup: hand-rolled in-memory Mongo → `createTestApp`

### Before
```typescript
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
let server;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
});
afterAll(async () => { await mongoose.disconnect(); await server.stop(); });
test('creates product', async () => {
  const app = buildApp(); /* ... custom auth header construction ... */
});
```

### After
```typescript
import { createTestApp, expectArc } from '@classytic/arc/testing';

test('creates product', async () => {
  const ctx = await createTestApp({
    resources: [productResource],
    authMode: 'jwt',
    connectMongoose: true,
  });
  ctx.auth.register('admin', { user: { id: '1', role: 'admin' }, orgId: 'org-1' });

  const res = await ctx.app.inject({
    method: 'POST', url: '/products',
    headers: ctx.auth.as('admin').headers,
    payload: { name: 'Widget', price: 10 },
  });
  expectArc(res).ok().hidesField('password');

  await ctx.close();
});
```
Or `createHttpTestHarness(productResource)` to auto-generate ~16 CRUD/permission/validation tests per resource.

---

## Rollout strategy for large projects

1. **Pick one resource** with thin business logic (no domain edge cases). Migrate end-to-end.
2. **Land the auth + scope changes first.** They unlock declarative permissions for every subsequent resource.
3. **Migrate adapters before resources.** A resource without an adapter migration is a half-step.
4. **Bundle preset adoption with the relevant resource.** Don't introduce `softDelete` as a separate PR — change the resource that needs it.
5. **Keep old routes alongside new for one release.** Tag with `versioningPlugin` or a path prefix; cut over after consumer confirmation.
6. **Run `arc docs ./openapi.json`** at the end and diff against the hand-maintained spec — discrepancies are bugs in either side.
7. **Drop the old code** once the report shows zero hits for the §3 / §4 / §7 patterns.
