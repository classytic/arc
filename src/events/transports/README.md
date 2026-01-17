# Event Transports

Arc uses pluggable event transports for domain events. The core package includes `MemoryEventTransport` for development/testing. For production, implement your own or use official adapters.

## Built-in Transports

| Transport | Package | Use Case |
|-----------|---------|----------|
| `MemoryEventTransport` | `@classytic/arc` | Development, testing, single-instance |

## Official Adapters (Coming Soon)

| Transport | Package | Use Case |
|-----------|---------|----------|
| `RedisEventTransport` | `@classytic/arc-redis` | Multi-instance, pub/sub |
| `SQSEventTransport` | `@classytic/arc-sqs` | AWS serverless, durable |
| `KafkaEventTransport` | `@classytic/arc-kafka` | High-throughput streaming |

## Implementing Your Own Transport

The `EventTransport` interface is simple. Here's how to implement a Redis transport:

```typescript
import type { EventTransport, DomainEvent, EventHandler } from '@classytic/arc/events';
import Redis from 'ioredis';

export class RedisEventTransport implements EventTransport {
  readonly name = 'redis';
  private pub: Redis;
  private sub: Redis;
  private handlers = new Map<string, Set<EventHandler>>();

  constructor(private redisUrl: string) {
    this.pub = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);

    // Handle incoming messages
    this.sub.on('pmessage', (pattern, channel, message) => {
      const handlers = this.handlers.get(pattern);
      if (!handlers) return;

      const event = JSON.parse(message) as DomainEvent;
      for (const handler of handlers) {
        handler(event).catch(console.error);
      }
    });
  }

  async publish(event: DomainEvent): Promise<void> {
    await this.pub.publish(event.type, JSON.stringify(event));
  }

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
      await this.sub.psubscribe(pattern);
    }
    this.handlers.get(pattern)!.add(handler);

    return () => {
      this.handlers.get(pattern)?.delete(handler);
    };
  }

  async close(): Promise<void> {
    await this.pub.quit();
    await this.sub.quit();
    this.handlers.clear();
  }
}
```

## Usage

```typescript
import { eventPlugin } from '@classytic/arc/events';
import { RedisEventTransport } from './your-transport';

await fastify.register(eventPlugin, {
  transport: new RedisEventTransport(process.env.REDIS_URL),
});

// Publish events (same API regardless of transport)
await fastify.events.publish('order.created', { orderId: '123' });

// Subscribe to events
await fastify.events.subscribe('order.*', async (event) => {
  console.log('Order event:', event.type, event.payload);
});
```

## Transport Interface

```typescript
interface EventTransport {
  /** Transport name for logging */
  readonly name: string;

  /** Publish an event */
  publish(event: DomainEvent): Promise<void>;

  /** Subscribe to events matching a pattern */
  subscribe(pattern: string, handler: EventHandler): Promise<() => void>;

  /** Close connections (optional) */
  close?(): Promise<void>;
}
```

## Event Structure

```typescript
interface DomainEvent<T = unknown> {
  type: string;       // e.g., 'order.created'
  payload: T;         // Your event data
  meta: {
    id: string;       // Unique event ID
    timestamp: Date;
    resource?: string;
    resourceId?: string;
    userId?: string;
    organizationId?: string;
    correlationId?: string;
  };
}
```

## Best Practices

1. **Development**: Use `MemoryEventTransport` (default)
2. **Multi-instance**: Use Redis for pub/sub across instances
3. **Serverless**: Use SQS for durable message delivery
4. **High-throughput**: Use Kafka for streaming workloads

## Why Not Bundle Redis?

Arc keeps the core package lightweight:

- **No forced dependencies** - You choose your message broker
- **Tree-shakeable** - Only import what you use
- **Flexibility** - Implement for any transport (RabbitMQ, NATS, etc.)
- **Version independence** - Update adapters without Arc releases
