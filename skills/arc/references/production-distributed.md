# Production: distributed runtime

`runtime: 'distributed'` is the "more than one replica" switch. Boot fails when any subsystem holds state that exists only in this process. Two checks, one policy.

## 1. Constructor guard (what `createApp` can see)

| Requirement | Applies when |
|---|---|
| `stores.events` durable transport | always |
| `stores.cache` | `arcPlugins.caching` enabled |
| `stores.queryCache` | `arcPlugins.queryCache` enabled |
| `stores.idempotency` | memory store is rejected; a missing one only warns |
| `rateLimit: { redis: client }` or `{ store }` | rate limiting on; `rateLimit: false` opts out |
| `arcPlugins.schedules.lock` (`LockAdapter`) or `singleReplica: true` | schedules object enabled; `singleReplica` claims exactly one replica arms schedules (the pinned `role: 'scheduler'` deployment) |

## 2. Capability audit (end of boot)

Covers everything wired in `plugins()`, `bootstrap[]` or module phases. Subsystems declare themselves; undeclared-shared memory defaults fail the boot in one error naming every violator.

| Subsystem | Memory default | Shared fix |
|---|---|---|
| `auth.sessions` | `MemorySessionStore` | `RedisSessionStore` (`@classytic/arc/auth/redis`) |
| `usage.store` | `MemoryUsageStore` | `RedisUsageStore` (`@classytic/arc/usage`) |
| `audit.store` | `MemoryAuditStore` | `auditPlugin` `repository` or `customStores` |
| `cache.query` | `MemoryCacheStore` | `stores.queryCache: new RedisCacheStore({ client })` (`@classytic/arc/cache`) |
| `permissions.dynamic-cache` | internal memory | `cacheStore` option, and pass `fastify` so the audit sees it |
| `websocket.adapter` | `LocalWebSocketAdapter` | `RedisWebSocketAdapter` (`@classytic/arc/integrations/websocket-redis`) |
| `websocket.pushref-store` | memory | `RedisPushRefStore` (`@classytic/arc/integrations/websocket-pushref-redis`) via `pushRefStore` |
| `webhooks.store` | `MemoryWebhookStore` | pass `store`, or `createDurableWebhookModule` |
| `mcp.resource-rate-limit` | memory limiter | shared `rateLimit` backend, when resources declare `rateLimit` |
| `http.response-cache` | memory | none: declared `accepted` (per replica by design, short TTLs). Logged, never a failure |

Events: `stores.events` with `RedisEventTransport` (`@classytic/arc/events/redis`) or `RedisStreamTransport` (`@classytic/arc/events/redis-stream`).

## Declare your own state

A replica-local cache built in `plugins()` belongs in the audit. Declare from anywhere a registration reaches, including your own encapsulated `fastify.register()`.

```typescript
import { declareRuntimeCapability } from '@classytic/arc/utils';

declareRuntimeCapability(fastify, {
  subsystem: 'billing.sequence-cache',
  durability: 'memory',                  // 'memory' | 'shared'
  detail: 'invoice numbering cached per process',
  // accepted: true,                     // only when per-process is intended
});
```

`accepted: true` must be stated by the declarant, never inferred.

## Circuit breakers count per replica

`CircuitBreaker` state is in-process: with 50 pods and `failureThreshold: 5`, a dead downstream absorbs 250 real requests. Share the failure window:

```typescript
import { CircuitBreaker, RedisCircuitBreakerState } from '@classytic/arc/utils';

const shared = new RedisCircuitBreakerState({ redis, windowMs: 60_000, prefix: 'arc:circuit:' });

const payments = new CircuitBreaker(charge, {
  name: 'stripe.charges',     // REQUIRED with sharedState: the key every replica counts under
  failureThreshold: 5,
  sharedState: shared,
});
```

- Shares the failure signal, not the state machine: each replica still owns its own OPEN/HALF_OPEN probing.
- The success path never touches the network; a throwing store degrades to local counting.
- `windowMs` must be positive (fixed window, default 60s).

## Gotchas

- Run migrations from one owner (deploy job) or pass a `lock`; see production-reliability.md.
- Relay, scheduler and worker processes: `role` in production-boot.md.
