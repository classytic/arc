# Production: idempotency

Replays the stored response for a repeated mutation. Disabled unless `enabled: true`. Register it after authentication so the principal and tenant isolate keys.

```typescript
import { idempotencyPlugin } from '@classytic/arc/idempotency';

await fastify.register(idempotencyPlugin, {
  enabled: true,
  headerName: 'idempotency-key',   // default
  ttlMs: 86_400_000,               // cached response lifetime, default 24h
  lockTimeoutMs: 30_000,           // in-flight lease, default 30s
  methods: ['POST', 'PUT', 'PATCH'],
  include: [/\/orders/],           // regex allowlist (optional)
  exclude: [/\/health/],           // wins over include
  retryAfterSeconds: 1,
  namespace: 'api',                // fold into the fingerprint when deployments share one store
});
```

| Case | Result |
|---|---|
| First request | Runs, stores the response |
| Retry, same key and body | Stored response, header `x-idempotency-replayed: true` |
| Same key, different body | 422 (fingerprint mismatch) |
| Concurrent, first still running | 409 with `Retry-After` |
| Key required but missing | 400 `arc.idempotency_key_required` |

```typescript
fetch('/api/orders', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body });
```

## Require a key

```typescript
defineResource({ name: 'order', idempotency: { required: ['create', 'update'] } });   // built-in write routes
```

Boot fails when a listed op is not mounted or the plugin is disabled. Custom routes:

```typescript
routes: [{
  method: 'POST', path: '/:id/charge', handler: 'charge',
  config: { idempotency: { required: true } },            // any method, DELETE included
}]
// action routes: { requiredActions: ['refund'] }
// handler owns at-most-once: { required: true, dedup: 'handler', owner: 'payments-runner' }
```

`dedup: 'handler'` still demands the key and exposes `request.idempotencyKey`, but stores and replays nothing. A custom route using `fastify.idempotency.middleware` in its own `preHandler` must place it after `fastify.authenticate`.

## Stores

```typescript
// Memory (default; dev, single instance): omit repository and store.

// Redis (multi-instance)
import { RedisIdempotencyStore } from '@classytic/arc/idempotency/redis';
store: new RedisIdempotencyStore({ client: redis, prefix: 'idem:', ttlMs: 86_400_000 })
// ioredisAsIdempotencyClient / upstashAsIdempotencyClient adapt other clients

// Database via any RepositoryLike (needs getOne, deleteMany, findOneAndUpdate)
import { Repository, methodRegistryPlugin, batchOperationsPlugin, mongoOperationsPlugin } from '@classytic/mongokit';
const IdempotencyModel = mongoose.model(
  'IdempotencyKey',
  new Schema({ _id: String }, { strict: false, strictQuery: false, timestamps: false }),
);
repository: new Repository(IdempotencyModel, [methodRegistryPlugin(), batchOperationsPlugin(), mongoOperationsPlugin()])
```

- The schema must declare `_id: String` and `strictQuery: false`. A pathless schema under global `strictQuery: true` strips the key filter and replays one cached response to every key and user. A boot self-check (`selfCheck`, default on) refuses such a store.
- `repository` takes precedence over `store`. Arc closes only stores it built.
- With `createApp({ runtime: 'distributed' })`, pass `stores.idempotency`; a memory store is rejected.

## IdempotencyStore contract

Required: `name`, `get`, `set`, `tryLock`, `unlock`, `isLocked`, `delete`, `deleteByPrefix`, `findByPrefix`. Optional: `acquire` (atomic check-and-lock), `setIfLocked` (fenced completion), `supportsFencedCompletion`, `completionReleasesLock`, `close`. A custom store without fencing needs `allowUnfencedCompletion: true`.

## Gotchas

- A crash between the business write and completion, or a handler outliving its lease, can repeat effects: use `dedup: 'handler'` with a shared transaction or a unique constraint when replay protection alone is not enough.
- Utilities: `fastify.idempotency.invalidate(key)`, `.has(key)`, `.store`.
- MCP mutating tools accept `_idempotencyKey` against the same store (mcp-setup.md).
