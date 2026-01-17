# Idempotency Module

Safe retries for mutating operations using idempotency keys.

## Why Idempotency?

Network failures happen. Without idempotency:
- User clicks "Pay" → Network timeout → User retries → Double charge

With idempotency:
- User clicks "Pay" → Network timeout → User retries → Same response (no double charge)

## Setup

```typescript
import { idempotencyPlugin } from '@classytic/arc/idempotency';

await fastify.register(idempotencyPlugin, {
  enabled: true,
  ttlMs: 86400000,  // 24 hours
});
```

## Configuration

```typescript
interface IdempotencyPluginOptions {
  enabled?: boolean;           // Enable (default: false)
  headerName?: string;         // Header name (default: 'idempotency-key')
  ttlMs?: number;              // Cache TTL (default: 24 hours)
  lockTimeoutMs?: number;      // Lock timeout (default: 30 seconds)
  methods?: string[];          // HTTP methods (default: ['POST', 'PUT', 'PATCH'])
  include?: RegExp[];          // URL patterns to include
  exclude?: RegExp[];          // URL patterns to exclude
  store?: IdempotencyStore;    // Storage backend
  retryAfterSeconds?: number;  // 409 retry hint (default: 1)
}
```

## Client Usage

```typescript
// Client sends idempotency key
fetch('/api/orders', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': 'order-abc123-uuid',  // Unique per operation
  },
  body: JSON.stringify({ items: [...] }),
});
```

## How It Works

```
Request 1: POST /orders + Idempotency-Key: abc
  → Process request
  → Cache response
  → Return response + x-idempotency-key: abc

Request 2: POST /orders + Idempotency-Key: abc (retry)
  → Find cached response
  → Return cached response + x-idempotency-replayed: true
```

## Response Headers

| Header | Description |
|--------|-------------|
| `x-idempotency-key` | Echo of the key used |
| `x-idempotency-replayed` | `true` if response was cached |

## Concurrent Requests

If two requests arrive simultaneously with the same key:

```
Request 1: Acquires lock, processing...
Request 2: Lock held → 409 Conflict + Retry-After: 1
```

## Storage Backends

### Memory Store (Default)

```typescript
import { MemoryIdempotencyStore } from '@classytic/arc/idempotency';

await fastify.register(idempotencyPlugin, {
  store: new MemoryIdempotencyStore({
    ttlMs: 86400000,
    maxEntries: 10000,
  }),
});
```

**Characteristics:**
- Fast, no external dependencies
- Lost on restart
- Not shared across instances
- **Use for:** Development, single-instance deployment

### Redis Store (Production)

```typescript
import { createClient } from 'redis';
import { RedisIdempotencyStore } from '@classytic/arc/idempotency';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

await fastify.register(idempotencyPlugin, {
  enabled: true,
  store: new RedisIdempotencyStore({
    client: redis,
    prefix: 'idem:',
    ttlMs: 86400000,
  }),
});
```

**Characteristics:**
- Shared across instances
- Survives restarts
- Atomic lock operations
- **Use for:** Production, multi-instance, Kubernetes

### MongoDB Store (Production)

```typescript
import mongoose from 'mongoose';
import { MongoIdempotencyStore } from '@classytic/arc/idempotency';

await fastify.register(idempotencyPlugin, {
  enabled: true,
  store: new MongoIdempotencyStore({
    connection: mongoose.connection,
    collection: 'arc_idempotency',
    createIndex: true,  // Auto-create TTL index
  }),
});
```

**Characteristics:**
- Shared across instances
- Uses TTL index for auto-cleanup
- Good for MongoDB-only stacks
- **Use for:** Production, multi-instance

## Best Practices

### Key Generation

```typescript
// Good: Unique per logical operation
`order-${userId}-${cartId}-${timestamp}`
`payment-${orderId}-${attemptNumber}`

// Bad: Too broad or reusable
`user-123`  // Same key for all user operations
`random`    // No retry correlation
```

### Scope Appropriately

```typescript
await fastify.register(idempotencyPlugin, {
  methods: ['POST'],        // Only creation
  include: [/\/orders/],    // Only order routes
  exclude: [/\/health/],    // Skip health checks
});
```

### TTL Considerations

| TTL | Use Case |
|-----|----------|
| 5 minutes | Quick retries only |
| 24 hours | Standard operations |
| 7 days | Long-running processes |

## Deployment Guide

| Environment | Store | Notes |
|-------------|-------|-------|
| Development | Memory | Fast iteration |
| Single instance | Memory | Simple, no deps |
| Multi-instance | Redis/MongoDB | Shared state required |
| Kubernetes | Redis | Survives pod restarts |

## IdempotencyStore Interface

```typescript
interface IdempotencyStore {
  readonly name: string;

  // Result caching
  get(key: string): Promise<IdempotencyResult | undefined>;
  set(key: string, result: Omit<IdempotencyResult, 'key'>): Promise<void>;

  // Distributed locking
  tryLock(key: string, requestId: string, ttlMs: number): Promise<boolean>;
  unlock(key: string, requestId: string): Promise<void>;
  isLocked(key: string): Promise<boolean>;

  // Management
  delete(key: string): Promise<void>;
  close?(): Promise<void>;
}
```
