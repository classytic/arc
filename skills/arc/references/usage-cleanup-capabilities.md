# Usage counters, tenant cleanup, runtime capabilities

## Usage counters and plan limits

`usagePlugin` (`@classytic/arc/usage`) decorates `fastify.usage` with per-actor, per-UTC-month counters: `record`, `summary`, `period`, `actorOf` (actor chain: org, user, client, ip). It tracks `api.requests` by default and `api.egress.bytes` on request; recording is fail-safe (a throwing store never fails a request).

| Store | Use |
|---|---|
| `MemoryUsageStore` | single process (default) |
| `RedisUsageStore` | distributed; retention is opt-in (`retentionSeconds`), counters are kept forever otherwise |
| a kit's `usage` store | counters beside domain data |

Quota gate: `requireQuota({ kind: 'ai.tokens', limit })` (number, `false` = unlimited, or a plan-aware resolver); denies with 429 `quota.exceeded` carrying `{ kind, used, limit, period, resetsAt }`. Fail-open on store errors unless `onStoreError: 'deny'`. Per-plan request ceilings: `createApp({ rateLimit: { plan } })` (the limiter runs before auth, so `resolve` sees the raw request).

## Tenant cleanup (GDPR / SOX / HIPAA)

```typescript
defineResource({ name: 'invoice', tenantField: 'organizationId',
  onTenantDelete: { strategy: { type: 'anonymize', fields: { customerName: '[REDACTED]', email: null } },
                    priority: 50, batchSize: 1000 } });
defineResource({ name: 'event', onTenantDelete: { strategy: { type: 'hard' } } });
defineResource({ name: 'ledger', onTenantDelete: { strategy: { type: 'skip', reason: 'SOX retention' } } });

import { assertNoTenantData, cascadeDeleteForOrganization } from '@classytic/arc/registry';
const report = await cascadeDeleteForOrganization(fastify.arc.registry, { organizationId, concurrency: 4, logger: fastify.log });
```

Strategies: `hard`, `soft`, `anonymize` (`fields` static or `(doc) => value`), `skip` (`reason` mandatory). Resources without `onTenantDelete` are never touched. Index `tenantField` on every cascading resource. Smoke check: `assertNoTenantData(registry, { organizationId })`.

## Runtime capability registry

Under `runtime: 'distributed'`, a subsystem holding process-local state must declare it, or the end-of-boot audit fails naming every violator.

```typescript
import { declareRuntimeCapability } from '@classytic/arc/utils';

declareRuntimeCapability(fastify, {
  subsystem: 'billing.sequence-cache',
  durability: 'memory',          // 'memory' | 'shared'
  detail: 'invoice numbering cached per process',
  // accepted: true,             // only when per-process is intended by design; never inferred
});
```

Arc's own memory defaults declare themselves (`auth.sessions`, `usage.store`, `audit.store`, `cache.query`, `permissions.dynamic-cache`, `websocket.adapter`, `webhooks.store`); a distributed app must replace each with a shared store or accept it explicitly. See the production references for the store-by-store table.
