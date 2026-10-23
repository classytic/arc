# Events: transactional outbox

Persist the event in the same DB transaction as the business write; a relay publishes it at-least-once. Store contract types (`OutboxStore`, `OutboxFailurePolicy`, `OutboxOwnershipError`) come from `@classytic/primitives/outbox`. Arc ships the runtime.

## Outbox as a module (default path)

```typescript
import { createOutboxModule, repositoryAsOutboxStore, exponentialBackoff } from '@classytic/arc/events';
import type { OutboxModuleExports } from '@classytic/arc/events';
import { defineModule, getModuleExports } from '@classytic/arc/factory';

const app = await createApp({
  modules: [
    createOutboxModule({
      store: repositoryAsOutboxStore(outboxRepo),        // or a factory (app) => store
      relayEveryMs: 5000,
      failurePolicy: ({ attempts }) =>
        attempts >= 5 ? { deadLetter: true } : { retryAt: exponentialBackoff({ attempt: attempts }) },
    }),
    defineModule({
      name: 'order',
      dependsOn: ['outbox'],                             // missing outbox fails boot
      bootstrap: (f) => makeOrders({ outbox: getModuleExports<OutboxModuleExports>(f, 'outbox').store }),
    }),
  ],
});
```

| `createOutboxModule` option | Meaning |
|---|---|
| `store` | `OutboxStore` or `(fastify) => OutboxStore` |
| `transport` | Default: the app's raw event transport (not the `app.events` facade) |
| `name` | Module name and `dependsOn` key (default `'outbox'`) |
| `relayEveryMs` | Default 5000 |
| `batchSize`, `leaseMs`, `consumerId` | Relay tuning; `consumerId` defaults to a per-instance unique id |
| `failurePolicy` | `({ attempts, error }) => { retryAt } \| { deadLetter: true }`. Set one: without it failed rows retry every poll forever |
| `onError` | Per-event relay problems (default: structured logger) |
| `sessionProvider` | Default `() => transactionContext.get()`; `false` opts out |
| `runOnStart` | Drain backlog at boot (default true) |
| `health` | Readiness check `<name>.relay` + log alerts; `false` disables. `{ relayLagUnhealthyMs, probeCacheMs, alertEveryMs }` |

Exports at `getModuleExports<OutboxModuleExports>(app, 'outbox')`: `store`, `relay` (an `EventOutbox`), `requestDrain()` (coalesced, call after commit), `drain({ maxPasses })` (await in tests), `health()`.

## Writing

```typescript
await outbox.store(
  createEvent('order.placed', { orderId }, { idempotencyKey: `order:${orderId}:placed` }),
  { session },                       // omit inside transactionContext
);
```

- `meta.idempotencyKey` maps to `dedupeKey` (duplicates absorbed). Dedupe is scoped per event type.
- Inside a transactional write the ambient session is used, so the row commits with the domain write.
- Durable `defineEvent` definitions (money, stock) go through `store`; `app.events.publish` refuses them.

## EventOutbox (standalone)

```typescript
const outbox = new EventOutbox({ repository: repo, transport, failurePolicy, batchSize: 100, leaseMs: 30000 });
const r = await outbox.relayBatch();
// { relayed, attempted, publishFailed, ackFailed, ownershipMismatches, malformed, failHookErrors, deadLettered, usedPublishMany }
const dead = await outbox.getDeadLettered(100);      // DeadLetteredEvent[]
await outbox.purge(olderThanMs);                      // delivered rows
```

Options also include `store` (instead of `repository`), `consumerId`, `onError`, `onPublished`, `usePublishMany`, `sessionProvider`. `MemoryOutboxStore` is the in-memory store for tests.

## Stores

`repositoryAsOutboxStore(repository, { visibleAtField? })` adapts any repo-core repository (create, getOne, getAll, deleteMany, findOneAndUpdate). It owns claim leases with a fence token, retry, dead letter, `requeue`, `countByStatus`, `oldestPendingAgeMs`, `purge`. The table needs columns: id (event id), `event`, `type`, `status` (`pending` | `delivered` | `dead_letter`), `attempts`, `visibleAt`, `leaseOwner`, `leaseExpiresAt`, `fenceToken`, `deliveredAt`, `firstFailedAt`, `lastFailedAt`, `lastError`, `dedupeKey` (unique, nullable), `partitionKey`, `headers`, `createdAt`. Index `{ status, visibleAt }`; add a TTL index on `deliveredAt` for retention. Prove a custom store with `runOutboxStoreContract` (see testing.md).

## Operator surface

```typescript
import { createOutboxAdminModule } from '@classytic/arc/outbox-admin';
import { requirePlatformRole } from '@classytic/arc/permissions';

createOutboxAdminModule({
  store,                                              // needs getDeadLettered, requeue, countByStatus, oldestPendingAgeMs
  permissions: { view: requirePlatformRole('platform-ops'), replay: requirePlatformRole('platform-ops') },
  prefix: '/admin/outbox',                            // default
});
```

Routes: `GET {prefix}/health`, `GET {prefix}/dead-letter?limit=`, `POST {prefix}/dead-letter/:id/replay`. Depends on the outbox module. Gates must be platform-only or boot fails (`allowUnverifiedOperatorPermission` overrides). Payload and stack are hidden unless `exposePayload` / `exposeStack`. Also `readOutboxHealth`, `DEFAULT_RELAY_LAG_UNHEALTHY_MS` from `@classytic/arc/events`.

## Durable webhooks

See integrations-webhooks.md (`createDurableWebhookModule`, `webhookPlugin({ durable })`).
