# Production: outbox, compensation, migrations

## Event outbox

At-least-once delivery even when the transport is down. Prefer the module form: it owns the relay schedule, shutdown and a readiness check.

```typescript
import { createOutboxModule, exponentialBackoff, repositoryAsOutboxStore } from '@classytic/arc/events';
import { Repository } from '@classytic/mongokit';

const outbox = createOutboxModule({
  store: repositoryAsOutboxStore(new Repository(OutboxModel)),
  relayEveryMs: 5000,                       // default
  failurePolicy: ({ attempts }) =>
    attempts >= 5 ? { deadLetter: true } : { retryAt: exponentialBackoff({ attempt: attempts }) },
  health: { relayLagUnhealthyMs: 5 * 60_000, probeCacheMs: 5000 },
});

const app = await createApp({ modules: [outbox, orderModule] });   // consumers declare dependsOn: ['outbox']
```

Writers use the module exports (`getModuleExports<OutboxModuleExports>(f, 'outbox')` from `@classytic/arc/factory`):

| Export | Use |
|---|---|
| `store` | Write events: `await store.save(event)`. Joins the active transaction automatically (`sessionProvider` defaults to `transactionContext.get()`), so the row commits with the domain write |
| `requestDrain()` | Nudge a relay pass after commit (milliseconds, not `relayEveryMs`); coalesced; never throws |
| `drain({ maxPasses })` | Await delivery including cascades; for tests and shutdown |
| `health()` | Same reading as the readiness check |
| `relay` | The `EventOutbox` |

- Always set a `failurePolicy`. Without one a failing row stays pending and is retried every poll forever, logging per event. `attempts` is the durable count and survives restarts.
- Readiness check `<name>.relay` is non-critical (pulling a pod does not drain the relay). Unhealthy on any dead letter or pending lag past `relayLagUnhealthyMs`; `alertEveryMs` also logs `OUTBOX_RELAY_LAG` / `OUTBOX_DEAD_LETTER`.
- `transport` defaults to the app's own event transport; `consumerId` defaults to a per-instance id and must stay unique per relay.
- Under `role: 'api'` or `'worker'` the relay arm does not run; run it in a `role: 'relay'` process.
- Store contract (`@classytic/primitives/outbox`): required `save`, `getPending`, `acknowledge`; optional `claimPending`, `claimPendingFenced`, `fail`, `getDeadLettered`, `requeue`, `purge`, `countByStatus`, `oldestPendingAgeMs`. Prove a custom store with `runOutboxStoreContract` from `@classytic/arc/testing/outbox`.

Hand-wired form (tests, custom scheduling):

```typescript
import { EventOutbox, MemoryOutboxStore } from '@classytic/arc/events';

const relay = new EventOutbox({ store: new MemoryOutboxStore(), transport, batchSize: 100, failurePolicy });
// or { repository: new Repository(OutboxModel), transport }
await relay.store(event, { session });
await relay.relay();                         // publishes pending to the transport
```

## Compensating transactions

In-process rollback: steps run in order, completed steps compensate in reverse on failure. A process crash skips compensation; for durable distributed workflows use `@classytic/streamline` or a workflow engine.

```typescript
import { withCompensation, defineCompensation } from '@classytic/arc/utils';

const result = await withCompensation('place-order', [
  {
    name: 'reserve-inventory',
    execute: async (ctx) => { const r = await inventory.reserve(ctx.items); ctx.reservationId = r.id; return r; },
    compensate: async (_ctx, r) => { await inventory.release(r.id); },
  },
  { name: 'charge', execute: async (ctx) => payments.charge(ctx.total), compensate: async (_c, r) => payments.refund(r.chargeId) },
  { name: 'email', execute: async (ctx) => mailer.send(ctx.email), fireAndForget: true },
], { items, total, email }, {
  onStepComplete: (step, res) => {}, onStepFailed: (step, err) => {}, onCompensate: (step) => {}, onHookError: (hook, err) => {},
});

if (!result.success) { /* result.failedStep, result.error, result.compensationErrors */ }
const placeOrder = defineCompensation('place-order', steps);      // reusable: placeOrder.execute(ctx, hooks)
```

- The context is a mutable copy shared by all steps.
- `fireAndForget` steps do not block, are not compensated, and appear only via `onStepFailed` on error; put must-survive side effects in the outbox.
- Compensation errors are collected in `result.compensationErrors` and never stop the rollback.
- Result is a union: `success: true` has `completedSteps` and `results`; `success: false` adds `failedStep`, `error`.

## Migrations

```typescript
import { defineMigration, MigrationRunner, MongoMigrationStore } from '@classytic/arc/migrations';

const v2 = defineMigration({
  version: 2,
  resource: 'product',
  description: 'rename oldField',
  up: async (db) => { await (db as mongo.Db).collection('products').updateMany({}, { $rename: { oldField: 'newField' } }); },
  down: async (db) => { await (db as mongo.Db).collection('products').updateMany({}, { $rename: { newField: 'oldField' } }); },
});

const runner = new MigrationRunner(mongoose.connection.db, {
  store: new MongoMigrationStore(mongoose.connection.db),   // required
  lock,                                                      // LockAdapter: concurrent runners fail fast
  checksumMismatch: 'error',                                 // default 'warn'
});
await runner.up([v2]);
```

- Run migrations from one owner (deploy job or leader), not every replica at startup.
- Write migrations idempotently: a crash between `up()` and recording re-runs that migration.
- `runner.down(...)` and `runner.downTo(...)` roll back; `computeMigrationChecksum` detects edits to applied migrations.
