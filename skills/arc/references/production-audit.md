# Production: audit trail

Disabled unless `enabled: true`. With no `repository` or `customStores` it falls back to `MemoryAuditStore` (dev only; the capability audit rejects it under `runtime: 'distributed'`).

```typescript
import { auditPlugin } from '@classytic/arc/audit';
import { Repository } from '@classytic/mongokit';

await fastify.register(auditPlugin, {
  enabled: true,
  repository: new Repository(AuditModel),      // any RepositoryLike: create + findAll
  customStores: [kafkaAuditStore],             // compose with, or instead of, a repository
  retention: { maxAgeMs: 365 * 86_400_000, purgeIntervalMs: 86_400_000 },
  autoAudit: { perResource: true },
});
```

## Automatic auditing

`autoAudit` (default `true`) logs create, update, delete for every resource through hooks.

| Value | Effect |
|---|---|
| `true` | All resources, all three operations |
| `{ perResource: true }` | Only resources declaring `audit: true` (or `audit: { operations: ['delete'] }`) |
| `{ include: ['order'] }` / `{ exclude: ['health'] }` | Allowlist / denylist (include wins if both) |
| `{ operations: ['create', 'delete'] }` | Restrict operations |
| `false` | Manual calls only |

```typescript
defineResource({ name: 'order', audit: true });
```

## Manual entries

Prefer a request-bound logger: actor and organization come from the validated scope and cannot be forged.

```typescript
const audit = fastify.audit.forRequest(request);
await audit.custom('product', id, 'price_changed', { oldPrice: 100, newPrice: 150 });
await audit.update('product', id, before, after);

// Or with an explicit context
await fastify.audit.create('product', id, doc, request.auditContext);
await fastify.audit.delete('product', id, doc, ctx);
await fastify.audit.restore('product', id, doc, ctx);
```

`request.auditMetadata = { reason }` adds fields to the row arc writes for that request.

## Query and purge

```typescript
const entries = await fastify.audit.query({
  resource: 'product', documentId: 'p1', userId, organizationId,
  action: ['update', 'delete'], from: new Date('2026-01-01'), to, limit: 100, offset: 0,
});
const deleted = await fastify.audit.purge(new Date(Date.now() - 90 * 86_400_000));
```

`query` is deliberately narrow and uses the first store that supports it. For filter, sort and keyset search (admin UI, MCP), mount the audit repository as a read-only resource:

```typescript
defineResource({
  name: 'audit-log',
  adapter: auditAdapter,                                   // adapter over the audit repository
  disabledRoutes: ['create', 'update', 'delete'],
  queryParser: new QueryParser({ allowedFilterFields: ['resource', 'documentId', 'userId', 'action', 'organizationId'] }),
  permissions: { list: requireRoles(['auditor']), get: requireRoles(['auditor']) },
});
```

## Entry shape

```typescript
interface AuditEntry {
  id: string; timestamp: Date;
  action: 'create' | 'update' | 'delete' | 'restore' | 'custom';
  resource: string; documentId: string;
  userId?: string; organizationId?: string;
  before?: Record<string, unknown>; after?: Record<string, unknown>;
  changes?: string[];                                      // changed field names
  requestId?: string; ipAddress?: string; userAgent?: string;
  metadata?: Record<string, unknown>;                      // custom actions: { customAction, ...data }
}
```

Custom store: implement `AuditStore` (`name`, `log`, optional `query`, `purgeOlderThan`, `close`).

## Retention

| Option | Use |
|---|---|
| MongoDB TTL index on `timestamp` (`expireAfterSeconds`) | Zero code, server side |
| `retention: { maxAgeMs, purgeIntervalMs }` | Built-in timer; runs on every replica, so wasteful in a fleet |
| `purgeIntervalMs: 0` plus a `schedulesPlugin` entry calling `fastify.audit.purge(cutoff)` | Multi-replica, leader-safe |

## Gotchas

- Index the audit model yourself: `{ resource: 1, documentId: 1, timestamp: -1 }`; SQL kits index `(resource, document_id, timestamp)`.
- The repository store writes with the active transaction session (`sessionProvider`, default `transactionContext.get()`), so the audit row commits or rolls back with the domain write. `sessionProvider: false` opts out.
