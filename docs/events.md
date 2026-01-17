# Events Module

Domain event system with pluggable transports for external integration.

## Hooks vs Events

Arc has two complementary event systems:

| Aspect | Hooks | Events |
|--------|-------|--------|
| **Purpose** | Internal lifecycle callbacks | External integration layer |
| **Scope** | Same process, synchronous flow | Cross-service, async by design |
| **Use when** | Validating, transforming, auditing within service | Notifying other services, building event-driven systems |
| **Transport** | In-process only | Pluggable (Memory → Redis/RabbitMQ/Kafka) |
| **Pattern** | `beforeCreate`, `afterUpdate` | `product.created`, `order.updated` |

**Rule of thumb:**
- **Hooks** = internal domain logic (validation, cache invalidation, derived data)
- **Events** = public integration (notify external subscribers, event sourcing)

## Auto-Emitted Events

`BaseController` automatically emits events on CRUD operations when the event plugin is registered:

| Operation | Event Type | Payload |
|-----------|------------|---------|
| `create()` | `{resource}.created` | Created document |
| `update()` | `{resource}.updated` | Updated document |
| `delete()` | `{resource}.deleted` | Deleted document |
| `restore()` | `{resource}.restored` | Restored document |

```typescript
// Automatic - no code needed!
// When you create a product via POST /products:
// → Event 'product.created' is published automatically

// Subscribe to auto-emitted events
await fastify.events.subscribe('product.created', async (event) => {
  console.log('New product:', event.payload.name);
  await indexForSearch(event.payload);
});
```

To disable auto-emission for a specific controller:

```typescript
class ProductController extends BaseController {
  constructor() {
    super({ disableEvents: true });
  }
}
```

## Setup

```typescript
import { eventPlugin } from '@classytic/arc/events';

// Development (in-memory, default)
await fastify.register(eventPlugin);

// Production (custom transport)
await fastify.register(eventPlugin, {
  transport: new RedisEventTransport({ client: redis }),
  logEvents: true,
});
```

## Configuration

```typescript
interface EventPluginOptions {
  transport?: EventTransport;  // Default: MemoryEventTransport
  logEvents?: boolean;         // Log event publishing (default: false)
}
```

## Publishing Events

```typescript
// Publish a domain event
await fastify.events.publish('order.created', {
  orderId: 'order-123',
  total: 99.99,
  items: [...],
}, {
  userId: request.user._id,
  organizationId: request.context?.organizationId,
  correlationId: request.id,
});
```

## Subscribing to Events

```typescript
// Subscribe to specific event
await fastify.events.subscribe('order.created', async (event) => {
  console.log('Order created:', event.payload.orderId);
  await sendConfirmationEmail(event.payload);
});

// Subscribe to pattern (all order events)
await fastify.events.subscribe('order.*', async (event) => {
  await updateAnalytics(event.type, event.payload);
});

// Subscribe to all events
await fastify.events.subscribe('*', async (event) => {
  await auditLog.create(event);
});
```

## Event Structure

```typescript
interface DomainEvent<T> {
  type: string;        // e.g., 'order.created'
  payload: T;          // Event data
  meta: {
    id: string;        // Unique event ID
    timestamp: Date;
    resource?: string;
    resourceId?: string;
    userId?: string;
    organizationId?: string;
    correlationId?: string;
  };
}
```

## Transports

### Memory Transport (Default)

```typescript
import { MemoryEventTransport } from '@classytic/arc/events';

await fastify.register(eventPlugin, {
  transport: new MemoryEventTransport(),
});
```

- In-process delivery
- Events lost on restart
- Not shared across instances
- **Use for:** Development, testing

### Custom Transport (Production)

Implement `EventTransport` interface for durable transports:

```typescript
import type { EventTransport, DomainEvent } from '@classytic/arc/events';

class RedisEventTransport implements EventTransport {
  readonly name = 'redis';

  async publish(event: DomainEvent): Promise<void> {
    await this.redis.publish(event.type, JSON.stringify(event));
  }

  async subscribe(pattern: string, handler): Promise<() => void> {
    const client = this.redis.duplicate();
    await client.pSubscribe(pattern, (message, channel) => {
      handler(JSON.parse(message));
    });
    return () => client.pUnsubscribe(pattern);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
```

## Use Cases

### Order Processing

```typescript
// After creating order
await fastify.events.publish('order.created', order, {
  resourceId: order._id,
});

// Subscribers handle side effects
fastify.events.subscribe('order.created', async (event) => {
  await reserveInventory(event.payload.items);
  await sendOrderConfirmation(event.payload.customer);
  await notifyWarehouse(event.payload);
});
```

### Cross-Service Communication

```typescript
// Service A: Publish event
await fastify.events.publish('user.verified', {
  userId: user._id,
  verifiedAt: new Date(),
});

// Service B: Subscribe (via shared transport)
await fastify.events.subscribe('user.verified', async (event) => {
  await enablePremiumFeatures(event.payload.userId);
});
```

## Multi-Instance Deployment

| Transport | Use Case |
|-----------|----------|
| Memory | Development, single-instance |
| Redis Pub/Sub | Multi-instance, real-time |
| RabbitMQ | Guaranteed delivery, queuing |
| Kafka | High-throughput, streaming |

## Interface

```typescript
interface EventTransport {
  readonly name: string;
  publish(event: DomainEvent): Promise<void>;
  subscribe(pattern: string, handler: EventHandler): Promise<() => void>;
  close?(): Promise<void>;
}
```
