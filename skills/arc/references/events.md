# Arc Events System

Domain event pub/sub with pluggable transports. Auto-emits events on CRUD operations.

## Hooks vs Events

| Aspect | Hooks | Events |
|--------|-------|--------|
| Purpose | Internal lifecycle callbacks | External integration |
| Scope | Same process, synchronous flow | Cross-service, async |
| Use when | Validating, transforming, auditing | Notifying services, event-driven systems |
| Transport | In-process only | Pluggable (Memory → Redis → Kafka) |
| Pattern | `beforeCreate`, `afterUpdate` | `product.created`, `order.updated` |

## Setup

The `createApp()` factory auto-registers `eventPlugin` — no manual registration needed:

```typescript
import { createApp } from '@classytic/arc/factory';

// Development (in-memory, default — zero config)
const app = await createApp({ preset: 'development' });
// app.events is ready to use

// Production (Redis transport, with retry)
import { RedisEventTransport } from '@classytic/arc/events/redis';

const app = await createApp({
  stores: { events: new RedisEventTransport(redis) },
  arcPlugins: {
    events: {
      logEvents: true,
      failOpen: true,            // default: suppress transport failures
      retry: { maxRetries: 3, backoffMs: 1000 },
    },
  },
});

// Disable event plugin entirely
const app = await createApp({ arcPlugins: { events: false } });
```

**Manual registration** (for apps not using `createApp`):

```typescript
import { eventPlugin } from '@classytic/arc/events';

await fastify.register(eventPlugin);  // Memory transport

// Redis Pub/Sub
import { RedisEventTransport } from '@classytic/arc/events/redis';
await fastify.register(eventPlugin, {
  transport: new RedisEventTransport(redisClient, { channel: 'arc-events' }),
  logEvents: true,
});

// Redis Streams (ordered, persistent, consumer groups)
import { RedisStreamTransport } from '@classytic/arc/events/redis-stream';
await fastify.register(eventPlugin, {
  transport: new RedisStreamTransport(redisClient, {
    stream: 'arc:events',
    group: 'api-service',
    consumer: 'worker-1',
  }),
});
```

`failOpen` behavior:
- `true` (default): publish/subscribe/close transport errors are logged and suppressed.
- `false`: transport errors are thrown to caller.

## Auto-Emitted Events

BaseController automatically emits events when eventPlugin is registered:

| Operation | Event Type | Payload |
|-----------|------------|---------|
| `create()` | `{resource}.created` | Created document |
| `update()` | `{resource}.updated` | Updated document |
| `delete()` | `{resource}.deleted` | Deleted document |
| `restore()` | `{resource}.restored` | Restored document |

Disable per-controller: `super({ disableEvents: true })`

## Publishing & Subscribing

```typescript
// Publish
await fastify.events.publish('order.created', {
  orderId: 'order-123',
  total: 99.99,
}, {
  userId: request.user._id,
  organizationId: getOrgId(request.scope),
  correlationId: request.id,
});

// Subscribe to specific event
await fastify.events.subscribe('order.created', async (event) => {
  await sendConfirmation(event.payload);
});

// Subscribe to pattern (wildcard)
await fastify.events.subscribe('order.*', async (event) => {
  await updateAnalytics(event.type, event.payload);
});

// Subscribe to all
await fastify.events.subscribe('*', async (event) => {
  await auditLog.create(event);
});

// Unsubscribe
const unsub = await fastify.events.subscribe('order.created', handler);
unsub();
```

## Event Structure

Event types live in `@classytic/primitives/events` (canonical source). Arc re-exports the runtime `MemoryEventTransport` only — every type below is imported from primitives.

```typescript
interface EventMeta {
  id: string;              // UUID v4 (fresh per emit; a retry gets a new id)
  timestamp: Date;
  schemaVersion?: number;  // bump on payload breaking change
  correlationId?: string;  // stable across causal chain
  causationId?: string;    // direct parent event id
  partitionKey?: string;   // ordering hint (Kafka/Kinesis/Streams)
  source?: string;         // originating service/package ('commerce', 'billing')
  idempotencyKey?: string; // cross-transport dedupe hint — stable per operation
  resource?: string;
  resourceId?: string;
  userId?: string;
  organizationId?: string;
  aggregate?: { type: string; id: string }; // DDD aggregate marker
}

interface DomainEvent<T> {
  type: string;            // e.g., 'order.created'
  payload: T;
  meta: EventMeta;
}
```

**`@classytic/primitives/events` is source of truth** — `EventMeta`, `DomainEvent`, `EventHandler`, `EventLogger`, `EventTransport`, `DeadLetteredEvent`, `PublishManyResult`, `createEvent`, `createChildEvent`, `matchEventPattern` all live there. Arc consumes them and re-exports the runtime `MemoryEventTransport`.

### DDD aggregate narrowing

`aggregate.type` is `string` in arc's base contract so it stays framework-neutral. Domain packages narrow it to a closed union via interface extension:

```typescript
// @classytic/cart
type CartAggregateType = 'cart' | 'cart-item';

interface CartEventMeta extends EventMeta {
  aggregate?: { type: CartAggregateType; id: string };
}
```

Unlike `correlationId` / `causationId`, `aggregate` is **not inherited** by `createChildEvent`. Child events usually belong to a different aggregate (e.g. an `order.placed` event emitted by the order aggregate spawns `inventory.reserved` owned by the inventory aggregate). Each event names its own aggregate explicitly.

### Causation chains

```typescript
import { createEvent, createChildEvent } from '@classytic/primitives/events';

const placed = createEvent('order.placed', { orderId: 'o1' }, {
  correlationId: req.id, userId: user.id,
});

// Downstream handler emits child — causation linked, correlation inherited:
const reserved = createChildEvent(placed, 'inventory.reserved', { sku: 'a' });
// reserved.meta.causationId   === placed.meta.id
// reserved.meta.correlationId === placed.meta.correlationId
```

### Dead-letter contract

```typescript
import type { DeadLetteredEvent, EventTransport } from '@classytic/primitives/events';

class KafkaTransport implements EventTransport {
  async deadLetter(dlq: DeadLetteredEvent) {
    await producer.send({ topic: `${dlq.event.type}.DLQ`, messages: [{ value: JSON.stringify(dlq) }] });
  }
}
```

## Custom Transport

Implement `EventTransport` for RabbitMQ, Kafka, etc.:

```typescript
import type { EventTransport, DomainEvent } from '@classytic/primitives/events';

class KafkaTransport implements EventTransport {
  readonly name = 'kafka';

  async publish(event: DomainEvent): Promise<void> {
    await this.producer.send({ topic: event.type, messages: [{ value: JSON.stringify(event) }] });
  }

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    // Subscribe to Kafka topic matching pattern
    return () => { /* unsubscribe */ };
  }

  async close(): Promise<void> {
    await this.producer.disconnect();
  }
}
```

## Built-in Transports

| Transport | Import | Use Case |
|-----------|--------|----------|
| Memory | `@classytic/arc/events` (default) | Development, testing, single-instance |
| Redis Pub/Sub | `@classytic/arc/events/redis` | Multi-instance, real-time |
| Redis Streams | `@classytic/arc/events/redis-stream` | Ordered, persistent, consumer groups |

### Streams vs Pub/Sub — pick the right one

Choosing wrong loses messages silently. Default to **Streams** for anything business-critical.

| Requirement | Use |
|---|---|
| Message MUST NOT be lost (billing, payments, audit) | **Streams** |
| Real-time notifications, OK to miss when no subscriber is up | Pub/Sub |
| Need to replay/reprocess past events | **Streams** |
| Multiple workers processing the same queue | **Streams** (consumer groups) |
| Simple broadcast to live WebSocket clients | Pub/Sub |
| Event sourcing or audit trail | **Streams** |
| Single-instance dev | Memory |
| At-least-once delivery with durable WAL | **Streams** + outbox pattern |

**Why it matters:** Pub/Sub is fire-and-forget. If no subscriber is connected when you publish, the message is gone. Streams persist until every consumer group acknowledges them — crashes, restarts, and network blips are survivable.

**Defense-in-depth:** pair `eventPlugin` with the transactional outbox (`EventOutbox` + `MemoryOutboxStore` or your own persistent store) for guaranteed delivery even if Redis is unreachable at publish time.

### Redis eviction policy — required for queues and idempotency

When you back events (Streams), jobs (BullMQ), idempotency, or cache with Redis, your Redis instance **must** be configured with `maxmemory-policy: noeviction`. Any other policy can silently evict in-flight stream entries or pending jobs.

- **Self-hosted Redis:** `redis-cli CONFIG SET maxmemory-policy noeviction` (or set in `redis.conf`).
- **Upstash:** free/paid DBs default to `optimistic-volatile`. You'll see `IMPORTANT! Eviction policy is optimistic-volatile. It should be "noeviction"` in BullMQ logs. **Do one of:** open a support ticket to request `noeviction`, use a dedicated DB for queues, or accept that long-idle jobs may be evicted.
- **ElastiCache / Redis Cloud:** set the parameter group's `maxmemory-policy` to `noeviction` before pointing arc at it.

For a pure cache DB (no queues, no idempotency), `allkeys-lru` is correct and what you want.

## Injectable Logger

All transports and retry accept a `logger` option — defaults to `console`, compatible with pino/fastify.log:

```typescript
import type { EventLogger } from '@classytic/primitives/events';

// Interface: { warn(msg, ...args): void; error(msg, ...args): void }

// Use Fastify's logger
await fastify.register(eventPlugin, {
  transport: new RedisEventTransport(redisClient, {
    logger: fastify.log,    // pino logger
  }),
});

// Use with Memory transport
new MemoryEventTransport({ logger: fastify.log });

// Use with Redis Streams
new RedisStreamTransport(redisClient, { logger: fastify.log });

// Use with retry wrapper
import { withRetry } from '@classytic/arc/events';
const retried = withRetry(handler, { maxRetries: 3, logger: fastify.log });
```

| Component | File | `logger` option |
|-----------|------|-----------------|
| `MemoryEventTransport` | `EventTransport.ts` | `MemoryEventTransportOptions.logger` |
| `withRetry()` | `retry.ts` | `RetryOptions.logger` |
| `RedisEventTransport` | `transports/redis.ts` | `RedisEventTransportOptions.logger` |
| `RedisStreamTransport` | `transports/redis-stream.ts` | `RedisStreamTransportOptions.logger` |

## Typed Events — defineEvent & Event Registry

Declare events with schemas for runtime validation and introspection:

```typescript
import { defineEvent, createEventRegistry } from '@classytic/arc/events';

const OrderCreated = defineEvent({
  name: 'order.created',
  version: 1,
  description: 'Emitted when an order is placed',
  schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      total: { type: 'number' },
    },
    required: ['orderId', 'total'],
  },
});

// Type-safe event creation
const event = OrderCreated.create({ orderId: 'o-1', total: 100 }, { userId: 'user-1' });
await app.events.publish(event.type, event.payload, event.meta);
```

**Event Registry** — catalog + auto-validation on publish:

```typescript
const registry = createEventRegistry();
registry.register(OrderCreated);

const app = await createApp({
  arcPlugins: {
    events: { registry, validateMode: 'warn' },
    // 'warn' (default): log warning, still publish
    // 'reject': throw error, do NOT publish
    // 'off': registry is introspection-only
  },
});

// Introspect at runtime
app.events.registry?.catalog();
// → [{ name: 'order.created', version: 1, schema: {...} }, ...]
```

## QueryCache Integration

QueryCache uses events for auto-invalidation. When `arcPlugins.queryCache` is enabled, all CRUD events automatically bump resource versions, invalidating cached queries — zero config required.

## Retry Logic

Events module includes retry with exponential backoff for failed handlers:

```typescript
import { withRetry } from '@classytic/arc/events';

const retriedHandler = withRetry(async (event) => {
  await processEvent(event);
}, {
  maxRetries: 3,           // default: 3
  backoffMs: 1000,         // initial delay, doubles each retry (default: 1000)
  maxBackoffMs: 30000,     // cap (default: 30000)
  logger: fastify.log,     // default: console
});

await fastify.events.subscribe('order.created', retriedHandler);
```

### Auto-route exhausted events to transport.deadLetter() (v2.9)

For transports with a native DLQ (Kafka DLQ topic, SQS DLQ queue, etc.), pass
`transport` to skip custom `$deadLetter` plumbing:

```typescript
await fastify.events.subscribe(
  'order.created',
  withRetry(handler, {
    maxRetries: 3,
    transport: fastify.events.transport,  // any EventTransport with deadLetter()
    name: 'emailProcessor',                // populates DeadLetteredEvent.handlerName
  }),
);
```

On exhaustion, a typed `DeadLetteredEvent` envelope (original event + error +
attempts + first/last failure timestamps) is handed to `transport.deadLetter()`.
`onDead` still works — both fire when both are configured.

## Transactional Outbox (v2.9)

**Why the outbox exists:** you write a row + publish an event in the same user
request. If the transport (Redis/Kafka) is down at that moment, the row
commits but the event vanishes — silent data divergence. The outbox persists
the event in the **same DB transaction** as the row, then a background relayer
guarantees at-least-once delivery to the transport. Multi-worker claim +
retry/DLQ policy + dedupe make it scale.

`EventOutbox` now offers centralised retry/DLQ and typed DLQ query:

```typescript
import { EventOutbox, MemoryOutboxStore, exponentialBackoff } from '@classytic/arc/events';

const outbox = new EventOutbox({
  store: new MemoryOutboxStore(),   // swap for durable store in prod
  transport: fastify.events.transport,

  // Centralised retry/DLQ — no more hand-rolled exponentialBackoff at every fail site
  failurePolicy: ({ attempts, error }) => {
    if (attempts >= 5) return { deadLetter: true };
    return { retryAt: exponentialBackoff({ attempt: attempts }) };
  },
});

// meta.idempotencyKey auto-maps to OutboxWriteOptions.dedupeKey — duplicate
// saves with the same key are silently absorbed.
await outbox.store(
  createEvent('order.placed', payload, { idempotencyKey: `order:${id}:placed` }),
);

// Rich per-batch outcome — deadLettered is new in v2.9
const result = await outbox.relayBatch();
// { relayed, attempted, publishFailed, ackFailed, ownershipMismatches,
//   malformed, failHookErrors, deadLettered, usedPublishMany }

// Read DLQ state as typed DeadLetteredEvent[]
const dlq = await outbox.getDeadLettered(100);
for (const envelope of dlq) {
  await alertOps(envelope);  // event, error, attempts, firstFailedAt, lastFailedAt
}
```

**Store capability tiers:**

| Method | Required | What you lose without it |
|---|---|---|
| `save`, `getPending`, `acknowledge` | ✅ | — |
| `claimPending` | — | Multi-worker relay safety |
| `fail` | — | Retry / DLQ / per-event failure reporting |
| `getDeadLettered` | — | `outbox.getDeadLettered()` returns `[]` |
| `purge` | — | App owns retention (TTL index, cron DELETE, etc.) |

`MemoryOutboxStore` implements all capabilities — use it as a reference when
writing a durable store for Postgres / DynamoDB / your DB of choice.

### Durable store — pass a `RepositoryLike`

Arc adapts any `Repository` (mongokit / prismakit / your own kit) to the
`OutboxStore` contract — no dedicated subpath, no store class to
instantiate:

```typescript
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { EventOutbox, exponentialBackoff, createEvent } from '@classytic/arc/events';

const OutboxModel = mongoose.model('ArcOutbox', OutboxSchema, 'arc_outbox_events');

const outbox = new EventOutbox({
  repository: new Repository(OutboxModel),
  transport: redisTransport,
  failurePolicy: ({ attempts }) =>
    attempts >= 5 ? { deadLetter: true } : { retryAt: exponentialBackoff({ attempt: attempts }) },
});

// Persist event in the same DB transaction as the row
await mongoose.connection.transaction(async (session) => {
  await Order.create([orderDoc], { session });
  await outbox.store(
    createEvent('order.placed', { orderId }, { idempotencyKey: `order:${orderId}:placed` }),
    { session },
  );
});

// Background relayer
setInterval(async () => {
  const r = await outbox.relayBatch();
  metrics.gauge('outbox.deadLettered', r.deadLettered);
}, 1000);

// Ops: read dead-letter envelopes for alerting / replay
const dlq = await outbox.getDeadLettered(100);
```

**What you get:**

- **Atomic multi-worker claim** — arc's adapter uses `findOneAndUpdate`
  on `{ status: 'pending', visibleAt ≤ now, lease free }`. Two racing
  relayers never see the same event; expired leases auto-recover.
- **Session threading** — `outbox.store(event, { session })` flows
  through `Repository.create(doc, { session })` so the event commits
  with your business write.
- **Dedupe** — `meta.idempotencyKey` maps to `dedupeKey`; your kit's
  unique index (or equivalent) enforces idempotency.
- **DLQ** — `getDeadLettered(limit)` returns typed `DeadLetteredEvent[]`.
  `RelayResult.deadLettered` counts per-batch transitions.
- **Purge** — `outbox.purge(olderThanMs)` deletes delivered rows; define
  retention via a TTL index (`deliveredAt`), a cron, or a scheduler —
  your kit's choice.

You own the schema and indexes. Recommended shape:
`{ eventId (unique), type, payload, meta, status, attempts, leaseOwner,
leaseExpiresAt, visibleAt, dedupeKey (unique sparse), lastError,
createdAt, deliveredAt }` with indexes on `{ status, visibleAt }` and
`{ deliveredAt }` (TTL).
