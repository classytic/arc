# Events: bus, transports, handlers

`createApp()` registers `eventPlugin` and decorates `app.events`. Event contract types and helpers come from `@classytic/primitives/events`; arc ships the runtime.

```typescript
import type { EventMeta, DomainEvent, EventHandler, EventTransport, DeadLetteredEvent } from '@classytic/primitives/events';
import { createEvent, createChildEvent, matchEventPattern } from '@classytic/primitives/events';
```

## Setup

```typescript
import { createApp } from '@classytic/arc/factory';
import { RedisStreamTransport } from '@classytic/arc/events/redis-stream';

const app = await createApp({
  stores: { events: new RedisStreamTransport(redis, { stream: 'arc:events', group: 'api', consumer: 'api-1' }) },
  arcPlugins: {
    events: {
      failOpen: true,                           // default: publish errors are logged, not thrown
      retry: { maxRetries: 3, backoffMs: 1000 },
      logEvents: true,
    },
  },
});
await createApp({ arcPlugins: { events: false } });   // disable
```

Without `createApp`: `await fastify.register(eventPlugin, { transport })` from `@classytic/arc/events`.

| `eventPlugin` option | Meaning |
|---|---|
| `transport` | Default `MemoryEventTransport`. arc closes only a transport it built |
| `memoryTransport` | `{ logger, onHandlerError: 'log'\|'throw', handlerDispatch: 'sequential'\|'parallel' }` for the default transport |
| `singleProcess` | Declare one-process topology on purpose (silences the memory-transport warning) |
| `failOpen` | `true` (default) suppress transport errors; `false` throw to caller |
| `retry` / `deadLetterQueue` | Auto-wrap subscribers with `withRetry`; DLQ needs `retry`, default sink publishes `$deadLetter` |
| `registry`, `validateMode` | Payload validation on publish: `'warn'` (default with registry) \| `'reject'` \| `'off'` |
| `onPublish`, `onPublishError` | Telemetry callbacks (isolated, never affect delivery) |
| `warnOnDuplicate` | Dual-publish detector, on outside production |
| `wal` | Low-level hook; not at-least-once. Use the outbox |

CRUD events auto-emit on `arcPlugins.emitEvents` (default true) as `<resource>.created|updated|deleted` with payload `{ resource, operation, data, userId?, organizationId?, timestamp }`. Build names with `crudEventType('product', 'created')`. Lifecycle names: `ARC_LIFECYCLE_EVENTS`.

## Publish and subscribe

```typescript
await app.events.publish('order.placed', { orderId: 'o1' }, {
  correlationId: req.id, organizationId: getOrgId(req.scope),
});
const unsub = await app.events.subscribe('order.*', async (event) => { /* event.type, payload, meta */ });
await app.events.subscribe('*', audit);
const stop = app.events.observe((event) => metrics.inc(event.type));   // read-only tap, also sees outbox relays
```

Patterns: exact, prefix `order.*`, global `*`. `app.events.registry?.catalog()` lists registered definitions.

`EventMeta`: `id`, `timestamp`, `schemaVersion?`, `correlationId?`, `causationId?`, `partitionKey?`, `source?`, `idempotencyKey?`, `resource?`, `resourceId?`, `userId?`, `organizationId?`, `aggregate?: { type, id }`.

```typescript
const placed = createEvent('order.placed', { orderId: 'o1' }, { correlationId: req.id });
const reserved = createChildEvent(placed, 'inventory.reserved', { sku: 'a' });
// reserved.meta.causationId === placed.meta.id; correlationId inherited; aggregate is NOT inherited
```

## Typed events and registry

```typescript
import { z } from 'zod';
import { defineEvent, createEventRegistry } from '@classytic/arc/events';

const OrderPlaced = defineEvent({
  name: 'order.placed', version: 1,
  payload: z.object({ orderId: z.string(), total: z.number() }),   // zod v4; or raw `schema` (JSON Schema)
});
const event = OrderPlaced.create({ orderId: 'o1', total: 10 }, { userId: 'u1' });
await app.events.publish(event.type, event.payload, event.meta);

const registry = createEventRegistry();      // optional { validate } to plug a full validator
registry.register(OrderPlaced);
createApp({ arcPlugins: { events: { registry, validateMode: 'reject' } } });
```

- Declare `payload` or `schema`, never both.
- Money or stock events: `durability: 'durable'` plus `occurrence(payload)` (fixed id). `app.events.publish` refuses them with `NonDurablePublishError`; write them to the outbox (see events-outbox.md).

## Handler wrappers

```typescript
import { withRetry, wrapWithSchema, subscribeWithSchema, wrapWithBoundary, subscribeWithBoundary,
         withSubscriberId, withInbox, createDeadLetterPublisher } from '@classytic/arc/events';

await app.events.subscribe('order.placed', withRetry(handler, {
  maxRetries: 3, backoffMs: 1000, maxBackoffMs: 30000, jitter: 0.1,
  transport,                              // your EventTransport: exhausted events go to transport.deadLetter()
  name: 'emailer',                        // DeadLetteredEvent.handlerName
  onDead: (event, errors) => alert(event),   // observability only, errors swallowed
  dlqFailureMode: 'rethrow',              // default; 'log-and-drop' acknowledges losses
}));
await subscribeWithSchema(app, OrderPlaced, handler);        // typed payload, invalid events skipped
await subscribeWithBoundary(app, 'cache.*', invalidate);     // log and swallow, no retry
```

| Helper | Use |
|---|---|
| `withSubscriberId(id, handler)` | Stable per-handler identity for durable per-handler progress (never an index) |
| `withInbox(name, handler, { store, leaseMs?, transaction? })` | Run a handler once per event id; `store` is a repo-core `IdempotencyClaimStore`; handler gets `{ session, eventId }` |
| `createDeadLetterPublisher(app.events)` | Handler that publishes exhausted events to `$deadLetter`; pass as `onDead` or `deadLetter` |

Dead-letter contract: a transport may implement `deadLetter(dlq: DeadLetteredEvent)`.

## Transports

| Transport | Import | Use |
|---|---|---|
| `MemoryEventTransport` | `@classytic/arc/events` | Dev, tests, one process |
| `RedisEventTransport(redis, { channel, externalLifecycle, logger })` | `@classytic/arc/events/redis` | Pub/Sub, fire-and-forget, live fan-out |
| `RedisStreamTransport(redis, opts)` | `@classytic/arc/events/redis-stream` | Persistent, consumer groups, replay, DLQ stream |

Streams options: `stream` ('arc:events'), `group` ('default'), `consumer`, `blockTimeMs` (5000), `batchSize` (10), `processingConcurrency` (1, keeps order), `maxRetries` (5), `claimTimeoutMs` (30000), `deadLetterStream` ('arc:events:dlq' or `false`), `maxLen` (0), `groupStart` ('latest' | 'beginning'), `maxPayloadBytes` (1 MB), `externalLifecycle`.

- Pub/Sub loses events when no subscriber is connected. Use Streams for billing, payments, audit, replay.
- Redis backing events, BullMQ jobs, or idempotency needs `maxmemory-policy noeviction`. Pure caches use `allkeys-lru`.
- Custom transport: implement `EventTransport` (`name`, `publish`, `subscribe(pattern, handler)` returning unsubscribe, `close`, optional `deadLetter`, `publishMany`).
- Every transport and wrapper takes `logger` (`fastify.log` works).
- Multi-instance deployments must not rely on the default memory transport.
