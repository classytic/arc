# Writes, hooks, errors, audit

## Write verbs and transactions

`writes` binds a domain command to a CRUD slot. `transactional: true` runs the persistence step inside the kit's `withTransaction`; the verb receives the tx-bound repository and `ctx.uow`.

```typescript
defineResource({
  name: 'order', adapter, transactional: true,
  writes: {
    create: async (data, ctx) => {
      const order = await ctx.repository.create(data);               // tx-bound
      await outbox.store(event, { session: ctx.uow?.session });       // same transaction
      return order;
    },
  },
});
```

- Hooks run once, outside the retry; only persistence re-runs on a transient conflict. `VersionConflictError` surfaces as 409, never retried.
- Retry belongs to the kit (`transactionRetry`); arc never stacks a second policy.
- Boot fails without `withTransaction`, and at registration when `capabilities.transactions !== true` (standalone Mongo, D1).
- `ctx.uow.session` is empty on connection-bound backends (SQLite): use the tx-bound repository.

## Hooks

```typescript
hooks: {
  beforeCreate: async (ctx) => { ctx.data.slug = slugify(ctx.data.name); },
  afterCreate: async (ctx) => { analytics.track('created', { id: ctx.data._id }); },
  beforeUpdate: async (ctx) => { /* ctx.meta.existing is the pre-image */ },
  beforeDelete: async (ctx) => { if (ctx.data.isProtected) throw new Error('locked'); },
}
```

`ctx = { data, user?, meta? }`; `meta` carries `id` and `existing`. Cross-resource: `createHookSystem()` and `beforeCreate(hooks, 'product', fn)` from `@classytic/arc/hooks`.

## Errors

```typescript
import { createDomainError, NotFoundError } from '@classytic/arc';

throw new NotFoundError('Product');                                     // 404 arc.not_found
throw createDomainError('SELF_REFERRAL', 'Cannot self-refer', 422, { field });
```

Wire (repo-core `ErrorContract`, no envelope, HTTP status discriminates): `{ code, message, status, details?, meta?, correlationId? }`. AJV and zod failures are `400 arc.validation_error` with `details[]`. Unknown routes are `404 arc.not_found`.

```typescript
errorHandler: { errorMappers: [{ type: AccountingError,
  toResponse: (e) => ({ status: e.status, code: e.code, message: e.message }) }] }
```

Modules ship mappers with `defineModule({ errorMappers })`; host mappers keep priority. A raw `ZodError` from your own `.parse()` is not mapped (use `routeInput`). Driver duplicate-key errors become 409 `arc.conflict`.

## Audit and history

```typescript
await fastify.register(auditPlugin, { autoAudit: { perResource: true } });

defineResource({ name: 'order', audit: true });
defineResource({ name: 'invoice', history: true });          // adds GET /:id/history from audit rows; implies audit
defineResource({ name: 'payment', audit: { operations: ['delete'] } });
await app.audit.custom('order', id, 'refund', { reason }, { user });   // manual, e.g. read auditing
```

History is gated update -> get -> `requireAuth` unless you pass `{ permissions, limit }`.

## Refusing from your own hook

A hook that refuses must end the lifecycle itself. `reply.sent` stays false while 2+ async `preSerialization`/`onSend` hooks defer the write, so Fastify runs the handler after a `reply.send(...)` that returned nothing (the write happened, so did the side effects).

```typescript
fastify.addHook('preHandler', async (req, reply) => {
  if (!allowed(req)) return reply.code(403).send({ code: 'arc.forbidden', message: 'No', status: 403 });   // return the reply
});
// or throw: createError(403, 'No') from @classytic/arc/utils; the error handler serializes it
```

Arc's own gates (permissions, auth, org scope, rate limit, cache hit) return the reply. `defineGuard` and a custom `auth.authenticate` that reply without returning are detected and ended for you. Pinned by `tests/core/refusal-ends-lifecycle.test.ts`; guard a host app with `checkRefusalDoesNoWork` from `@classytic/arc-testkit/conformance`.
