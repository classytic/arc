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

```typescript
interface DomainEvent<T> {
  type: string;          // e.g., 'order.created'
  payload: T;
  meta: {
    id: string;          // Unique event ID
    timestamp: Date;
    source?: string;
    resource?: string;
    resourceId?: string;
    userId?: string;
    organizationId?: string;
    correlationId?: string;
  };
}
```

## Custom Transport

Implement `EventTransport` for RabbitMQ, Kafka, etc.:

```typescript
import type { EventTransport, DomainEvent } from '@classytic/arc/events';

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

## Injectable Logger

All transports and retry accept a `logger` option — defaults to `console`, compatible with pino/fastify.log:

```typescript
import type { EventLogger } from '@classytic/arc/events';

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
