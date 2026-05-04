# Arc Testing Utilities (2.11)

Three primary entry points — pick by what you're testing. Everything else composes with one of them.

| Entry point | Use when | Tests in scope |
|---|---|---|
| `createHttpTestHarness(resource, ctxFn)` | You want auto-generated CRUD + permission + validation coverage per resource | ~16 tests / resource, zero boilerplate |
| `createTestApp({ resources, authMode, db })` | Custom scenarios, end-to-end flows, integration across resources | You write assertions with `expectArc(res)` |
| `runStorageContract(setup)` | You're building an adapter and want to prove it satisfies arc's Storage contract | DB-agnostic adapter conformance |

---

## `createTestApp()` — turnkey Fastify + in-memory Mongo + auth + fixtures

```typescript
import { createTestApp, expectArc } from '@classytic/arc/testing';
import type { TestAppContext } from '@classytic/arc/testing';

describe('Product API', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({
      resources: [productResource],
      authMode: 'jwt',           // 'jwt' | 'better-auth' | 'none'
      db: 'in-memory',           // default; or { uri } | false
      connectMongoose: true,     // optional — one-liner for Mongoose apps
    });

    ctx.auth.register('admin', {
      user: { id: '1', roles: ['admin'] },
      orgId: 'org-1',
    });
  });

  afterAll(() => ctx.close());

  it('GET /products — public', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/products' });
    expectArc(res).ok().paginated();
  });

  it('POST /products — admin required', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/products',
      headers: ctx.auth.as('admin').headers,
      payload: { name: 'Widget', price: 99 },
    });
    expectArc(res).ok();
  });
});
```

**`TestAppContext` shape**: `{ app, auth, fixtures, dbUri, close }`. Auth is `undefined` when `authMode: 'none'`; `dbUri` is present when `db: 'in-memory'` or `{ uri }`.

**`db` modes**:
- `'in-memory'` (default) — boots `MongoMemoryServer`, exposes `dbUri`, stops on `close()`. Needs `npm i -D mongodb-memory-server`.
- `{ uri }` — external Mongo URI; caller owns lifecycle.
- `false` — no DB wiring (pure Fastify unit tests).

**`authMode: 'better-auth'`** requires the caller to also pass `auth: { type: 'better-auth', ... }`. Mismatched config fails fast at setup.

---

## `TestAuthProvider` — unified session primitive

One `register()` → `.as(role).headers` flow across JWT, Better Auth, and custom providers.

```typescript
// JWT — provider signs on-the-fly via app.jwt.sign()
ctx.auth.register('admin', { user: { id: '1', roles: ['admin'] }, orgId: 'org-1' });
ctx.auth.register('user', { user: { id: '2', roles: ['user'] } });

// Better Auth / custom — pre-signed tokens
ctx.auth.register('admin', { token: existingToken, orgId: 'org-1' });

// Use
const headers = ctx.auth.as('admin').headers;              // { authorization, x-organization-id }
const withExtra = ctx.auth.as('admin').withExtra({ 'x-request-id': 'r-1' }).headers;
```

Directly construct without `createTestApp`:

```typescript
import { createJwtAuthProvider, createBetterAuthProvider } from '@classytic/arc/testing';
const auth = createJwtAuthProvider(app, { defaultOrgId: 'org-1' });
```

---

## `createHttpTestHarness(resource, ctxFn)` — auto-generated resource coverage

~16 tests per resource (CRUD + permission + validation + error envelope) from a single factory call. Reads `defineResource()` config and probes every route.

```typescript
import { createTestApp, createHttpTestHarness } from '@classytic/arc/testing';

describe('Product resource — full coverage', () => {
  const ctx = await createTestApp({ resources: [productResource] });
  ctx.auth.register('admin', { user: { id: '1', roles: ['admin'] } });

  createHttpTestHarness(productResource, () => ({
    app: ctx.app,
    auth: ctx.auth,
    adminRole: 'admin',
    fixtures: { product: (i) => ({ name: `P${i}`, price: 10 + i }) },
  })).runAll();
});
```

---

## `expectArc(response)` — fluent envelope matchers

```typescript
expectArc(res).ok();                         // 200/201 with data envelope
expectArc(res).forbidden();                  // 403, arc error envelope
expectArc(res).notFound().hasError(/not exist/);
expectArc(res).validationError().hasData({ fields: ['email'] });
expectArc(res).paginated({ total: 10 });     // meta.pagination present
expectArc(res).hidesField('password');       // field stripped from response
expectArc(res).hasMeta('traceId');
```

Available: `.ok`, `.failed`, `.unauthorized`, `.forbidden`, `.notFound`, `.validationError`, `.conflict`, `.hasData`, `.hidesField`, `.showsField`, `.paginated`, `.hasError`, `.hasMeta`.

---

## `createTestFixtures()` — DB-agnostic seeding

```typescript
import { createTestFixtures } from '@classytic/arc/testing';

const fixtures = createTestFixtures();
fixtures.register('product', async (data) => {
  const doc = await Product.create(data);
  return { record: doc, destroy: () => Product.deleteOne({ _id: doc._id }) };
});

const widget = await fixtures.create('product', { name: 'Widget' });
await fixtures.clear();  // runs destroyers newest-first
```

Destroyers bind at create time — no global cleanup registry. Works with any backend (Mongoose, sqlitekit, Prisma, in-memory).

---

## Better Auth orchestration — `setupBetterAuthTestApp`

Composes `createTestApp` with Better Auth sign-up + org creation. Use when you need real Better Auth tokens rather than pre-signed stubs:

```typescript
import { setupBetterAuthTestApp, createBetterAuthTestHelpers } from '@classytic/arc/testing';

const { ctx, helpers } = await setupBetterAuthTestApp({ resources: [orderResource], auth });
const { user, token, orgId } = await helpers.signUpWithOrg({ email: 'a@x.co', name: 'A' });
ctx.auth.register('admin', { token, orgId });
```

---

## Mocks (non-Fastify unit tests)

```typescript
import {
  createMockRepository,
  createDataFactory,
  createMockUser,
  createMockRequest,
  createMockReply,
  waitFor,
  createSpy,
  createTestTimer,
} from '@classytic/arc/testing';
```

---

## `runStorageContract(setup)` — adapter conformance

DB-agnostic Storage contract check. Build a setup that returns your adapter factory + a cleanup fn; arc runs the full contract suite against it.

```typescript
import { runStorageContract } from '@classytic/arc/testing';
runStorageContract(async () => {
  const storage = createMyAdapter();
  return { storage, cleanup: async () => storage.close() };
});
```

---

## Tips

1. **`app.inject()` over real HTTP** — same server, zero network.
2. **Register auth sessions once per role** — not per test.
3. **Use `ctx.fixtures.clear()` in `afterEach`** — destroyers handle dependency order.
4. **Test permission denials explicitly** — `expectArc(res).forbidden()` beats status-code assertions.
5. **Reach for `createHttpTestHarness` first** — 16 tests for one function call.

## Migration from pre-2.11 testing APIs

| Pre-2.11 | 2.11 |
|---|---|
| `TestHarness` / `createTestHarness` | `createHttpTestHarness(resource, ctxFn)` |
| `TestAppResult` | `TestAppContext` |
| `testApp.mongoUri` | `ctx.dbUri` |
| `createJwtAuthProvider` / `createBetterAuthProvider` (as `HttpTestHarness` imports) | `ctx.auth` from `createTestApp` (or direct factory import) |
| `withTestDb()` | `createTestApp({ db: 'in-memory' })` + `ctx.dbUri` |
| `TestDatabase` / `TestSeeder` / `TestTransaction` | `createTestFixtures` + kit-level cleanup |
| `setupBetterAuthOrg` | `setupBetterAuthTestApp` + `helpers.signUpWithOrg` |
