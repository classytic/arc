# Changelog

## 2.8.0

- **`routes`** replaces `additionalRoutes` — no more `wrapHandler` boolean, use `raw: true` for raw Fastify handlers
- **`actions`** on `defineResource()` — declarative state transitions, replaces `onRegister` + `createActionRouter` pattern
- **`actionPermissions`** fallback for actions without per-action permissions
- **`onRegister` scope fix** — now runs inside the resource prefix scope, no manual prefix needed
- **Code quality** — removed 6 `any` types from `createActionRouter.ts`, `readonly` on all new interfaces
- **40 new tests** — routes, actions, validation, edge cases, type safety

### Migration

```typescript
// Before (v2.7)
additionalRoutes: [
  { method: 'GET', path: '/stats', handler: fn, wrapHandler: false, permissions: auth() },
],
onRegister: (fastify) => {
  fastify.register((instance, _opts, done) => {
    createActionRouter(instance, { actions: { approve: handler } });
    done();
  }, { prefix: '/transfers' });
},

// After (v2.8)
routes: [
  { method: 'GET', path: '/stats', handler: fn, raw: true, permissions: auth() },
],
actions: {
  approve: handler,
},
```

---

## 2.7.7

- WorkflowRunLike type fix, MongoKit 3.5.6 peer dep

## 2.7.5

- CI pipeline fix, runtime console cleanup, streamline execute/waitFor, MCP E2E script

## 2.7.3

- DX helpers, service scope, security fixes

## 2.7.2

- Webhooks: verifySignature, lifecycle cleanup, bounded concurrency

## 2.7.1

- `allOf()` scope plumbing fix, `requireServiceScope` helper, service scope in multiTenant preset, MCP auth + org scoping

## 2.6.3

- `idField` override works end-to-end (custom primary keys no longer rejected by AJV)

## 2.6.2

- Event WAL (write-ahead log) for durable at-least-once delivery, `arc.*` event skip

## 2.6.0

- Audit trail plugin + stores, per-resource opt-in, idempotency plugin

## 2.5.5

- `createApp({ resources })`, `loadResources()`, bracket notation filters, body sanitizer

## 2.4.3

- Better Auth adapter, org scoping, role hierarchy, field-level permissions

## 2.4.1

- Initial public release — defineResource, BaseController, CRUD router, permissions, events, cache, presets
