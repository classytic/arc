# Plugins Module

Production-ready plugins for observability and reliability.

## Health Plugin

Kubernetes-ready health checks.

```typescript
import { healthPlugin } from '@classytic/arc/plugins';

await fastify.register(healthPlugin, {
  prefix: '/_health',
  version: '1.0.0',
  checks: [
    {
      name: 'database',
      check: () => mongoose.connection.readyState === 1,
      critical: true,  // Affects readiness
    },
    {
      name: 'redis',
      check: async () => await redis.ping() === 'PONG',
      timeout: 3000,
    },
  ],
});
```

**Endpoints:**

| Endpoint | Purpose | Use Case |
|----------|---------|----------|
| `/_health/live` | Liveness probe | Process is running |
| `/_health/ready` | Readiness probe | Can accept traffic |

**Responses:**
```json
// /_health/live
{ "status": "ok", "timestamp": "...", "version": "1.0.0" }

// /_health/ready (all checks pass)
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok", "latency": 5 },
    "redis": { "status": "ok", "latency": 12 }
  }
}

// /_health/ready (check fails)
{ "status": "error", "checks": { "database": { "status": "error" } } }
// Returns 503 status code
```

---

## Request ID Plugin

Distributed tracing via request IDs.

```typescript
import { requestIdPlugin } from '@classytic/arc/plugins';

await fastify.register(requestIdPlugin, {
  header: 'x-request-id',
  setResponseHeader: true,
  generator: () => crypto.randomUUID(),
});
```

**Configuration:**
```typescript
interface RequestIdOptions {
  header?: string;          // Header name (default: 'x-request-id')
  generator?: () => string; // Custom ID generator
  setResponseHeader?: boolean; // Echo in response (default: true)
}
```

**Usage:**
```typescript
// Access in handlers
fastify.get('/', async (request) => {
  const requestId = request.id;
  logger.info({ requestId }, 'Processing request');
});
```

**For Logging:**
```typescript
// Integrate with pino
const fastify = Fastify({
  logger: {
    serializers: {
      req(request) {
        return { id: request.id, method: request.method, url: request.url };
      },
    },
  },
});
```

---

## Graceful Shutdown Plugin

Handles shutdown signals cleanly.

```typescript
import { gracefulShutdownPlugin } from '@classytic/arc/plugins';

await fastify.register(gracefulShutdownPlugin, {
  timeout: 30000,  // Max wait time (ms)
  signals: ['SIGTERM', 'SIGINT'],
  logEvents: true,
  onShutdown: async () => {
    // Custom cleanup
    await mongoose.disconnect();
    await redis.quit();
  },
});
```

**Configuration:**
```typescript
interface GracefulShutdownOptions {
  timeout?: number;         // Max wait time in ms (default: 30000)
  signals?: NodeJS.Signals[]; // Signals to handle (default: ['SIGTERM', 'SIGINT'])
  logEvents?: boolean;      // Log shutdown events (default: true)
  onShutdown?: () => Promise<void>; // Custom cleanup function
}
```

**Shutdown Sequence:**
1. Receive signal (SIGTERM/SIGINT)
2. Stop accepting new connections
3. Wait for in-flight requests to complete
4. Run `onShutdown` callback
5. Close Fastify server
6. Exit process

**Kubernetes Deployment:**
```yaml
spec:
  terminationGracePeriodSeconds: 30
  containers:
    - name: api
      lifecycle:
        preStop:
          exec:
            command: ["sh", "-c", "sleep 5"]  # Allow time for deregistration
```

---

## Combined Setup

Typical production setup:

```typescript
import Fastify from 'fastify';
import {
  healthPlugin,
  requestIdPlugin,
  gracefulShutdownPlugin,
} from '@classytic/arc/plugins';

const fastify = Fastify({ logger: true });

// Request tracing
await fastify.register(requestIdPlugin);

// Health checks
await fastify.register(healthPlugin, {
  checks: [
    { name: 'mongodb', check: () => mongoose.connection.readyState === 1 },
  ],
});

// Graceful shutdown
await fastify.register(gracefulShutdownPlugin, {
  onShutdown: async () => {
    await mongoose.disconnect();
  },
});
```
