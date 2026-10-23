# Testing (`@classytic/arc/testing`)

| Need | Use |
|---|---|
| Auto CRUD + permission + validation coverage for one resource | `createHttpTestHarness` |
| Custom scenarios, one app with auth and fixtures | `createTestApp` + `expectArc` |
| Real app around modules (boots green means it composes) | `bootModuleApp` |
| Prove an adapter or store satisfies a contract | `runStorageContract`, `runOutboxStoreContract` (`/testing/outbox`), `runCleanupRunStoreContract` (`/testing/cleanup`) |

## createTestApp

```typescript
import { createTestApp, expectArc } from '@classytic/arc/testing';
import type { TestAppContext } from '@classytic/arc/testing';

let ctx: TestAppContext;
beforeAll(async () => {
  ctx = await createTestApp({
    resources: [productResource],
    authMode: 'jwt',          // 'jwt' (default) | 'better-auth' | 'none'
    db: 'in-memory',          // default | { uri } | false
    connectMongoose: true,    // mongoose.connect(dbUri) for Mongoose apps
  });
  ctx.auth!.register('admin', { user: { id: '1', roles: ['admin'] }, orgId: 'org-1' });
});
afterAll(() => ctx.close());

it('POST /products as admin', async () => {
  const res = await ctx.app.inject({
    method: 'POST', url: '/products',
    headers: ctx.auth!.as('admin').headers,
    payload: { name: 'Widget', price: 99 },
  });
  expectArc(res).ok(201);
});
```

- `TestAppContext`: `{ app, auth, fixtures, dbUri, close }`. `auth` is `undefined` when `authMode: 'none'`.
- Other `createApp` options pass through (`plugins`, `auth`, `ports` ...). Defaults: `preset: 'testing'`, no logger, helmet, cors, rate limit.
- `db: 'in-memory'` needs `mongodb-memory-server` (dev dependency). `dbUri` is NOT wired into your adapters: connect them yourself.
- `authMode: 'better-auth'` requires you to pass `auth: { type: 'better-auth', ... }`; it throws otherwise.
- `ok()` defaults to 200, so pass the exact status (`ok(201)`).

## Auth sessions

`ctx.auth.register(role, { user | token, orgId?, extraHeaders? })`, then `ctx.auth.as(role).headers` (`authorization`, `x-organization-id`), `.withExtra({...})`, `ctx.auth.anonymous()` for 401 tests, `ctx.auth.roles`.

```typescript
import { createJwtAuthProvider, createBetterAuthProvider, createCustomAuthProvider } from '@classytic/arc/testing';
const auth = createJwtAuthProvider(app, { defaultOrgId: 'org-1' }); // signs via app.jwt.sign
```

`user` is signed by the JWT provider; Better Auth and custom providers need a pre-minted `token`.

## expectArc

Success bodies have no envelope, failures are `{ code, message, status }`.

```typescript
expectArc(res).ok(201);
expectArc(res).forbidden();                 // also unauthorized(), notFound(), validationError(), conflict(), failed(status?)
expectArc(res).notFound().hasError(/not exist/);
expectArc(res).paginated({ total: 10 });    // docs[] plus pagination fields
expectArc(res).hidesField('password');      // also showsField, hasData(), hasMeta(key, value?)
```

## createHttpTestHarness

```typescript
createHttpTestHarness(productResource, () => ({
  app: ctx.app,
  auth: ctx.auth!,
  adminRole: 'admin',
  fixtures: { valid: { name: 'P', price: 10 }, update: { price: 20 }, invalid: { price: 'x' } },
  apiPrefix: '/api',          // optional
})).runAll();                 // or runCrud() / runPermissions() / runValidation()
```

Reads the resource config (`disabledRoutes`, `updateMethod`) and probes each enabled route. Pass a getter when the app is built in `beforeAll`.

## Fixtures

```typescript
import { createTestFixtures } from '@classytic/arc/testing';
const fixtures = createTestFixtures();
fixtures.register('product', {
  create: (data) => Product.create(data),
  destroy: (doc) => Product.deleteOne({ _id: doc._id }).then(() => undefined),
});
await fixtures.create('product', { name: 'Widget' });
await fixtures.createMany('product', 3);
await fixtures.clear();       // destroyers run newest first
```

`register` also accepts a bare factory function (no cleanup). `ctx.fixtures` is the same tracker.

## bootModuleApp

```typescript
import { bootModuleApp, testActorHeaders } from '@classytic/arc/testing';

const t = await bootModuleApp((ctx) => [catalogModule(ctx.connection)], {
  replset: false,             // true for transactions
  actor: { roles: ['manager'], organizationId: 'org-1' },  // default actor
  ports: { /* host ports */ },
  app: { /* extra createApp options */ },
});
const engine = t.exports<CatalogEngine>('catalog');
await t.app.inject({ url: '/x', headers: testActorHeaders('cashier', 'org-1') });
await t.close();
```

- Database is a seam: `database` (default `mongoMemoryDatabase`) returns `{ uri, connection, teardown }`; kits inject their own.
- Identity comes from the `x-test-actor` header (`testActorHeaders(actor | roleString | null, orgId?)`). `null` stays public. Only `bootModuleApp` installs it; `createApp` never does.
- Gate routes with arc primitives (`requireRoles`, `requireOrgMembership`), not test-only gates.
- `assertModuleBootsAlone(modules, name, { probe })` boots a module with its dependency closure only.
- `assertRequiresPorts(module, ports, { with, ports })` proves declared required ports.
- `createTestModuleSetup({ ports })` gives `{ context, deferred, dispose }` to unit-test module phases.
- `runAuthorizationConformance`, `scopeRoleGate(...roles)` exist for authorization suites.

## Better Auth

```typescript
import { setupBetterAuthTestApp } from '@classytic/arc/testing';

const r = await setupBetterAuthTestApp({
  app,                                        // built app with Better Auth registered
  org: { name: 'Acme', slug: 'acme' },
  users: [
    { key: 'admin', email: 'a@x.co', password: 'pw', name: 'A', role: 'owner', isCreator: true },
  ],
  addMember,                                  // required for non-creator users
});
r.auth.as('admin').headers; r.orgId; r.users.admin.token; await r.teardown();
```

Exactly one user has `isCreator: true`. Lower level: `createBetterAuthTestHelpers()` gives `signUp`, `signIn`, `createOrg`, `setActiveOrg`, `authHeaders`.

## Contracts

```typescript
runStorageContract('my-storage', async () => ({ storage, teardown: async () => storage.close() }));
runOutboxStoreContract('my-store', async () => ({ store, reset: async () => { /* empty it */ }, teardown }));
```

`reset` is required for the outbox contract and runs before every test.

## Unit-test mocks

`createMockRepository`, `createMockController`, `createMockUser`, `createMockRequest`, `createMockReply`, `createDataFactory`, `createSpy`, `createTestTimer`, `waitFor`.

## Tips

- Use `app.inject()`, never a real port.
- Register one auth session per role in `beforeAll`.
- Call `ctx.fixtures.clear()` in `afterEach`.
- Assert denials with `expectArc(res).forbidden()`, not raw status codes.
