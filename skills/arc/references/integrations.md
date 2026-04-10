# Arc Integrations

Pluggable adapters for BullMQ jobs, WebSocket real-time, Streamline workflows, and MCP tools.
All are separate subpath imports — only loaded when explicitly used.

> **MCP** has its own dedicated reference: [mcp.md](mcp.md) — auto-generate tools from resources (including actions, v2.8), custom tools, Better Auth OAuth 2.1.

## Job Queue (BullMQ)

```typescript
import { jobsPlugin, defineJob } from '@classytic/arc/integrations/jobs';
```

**Requires:** `bullmq` (peer dependency), Redis

### Define Jobs

```typescript
const sendEmail = defineJob({
  name: 'send-email',
  handler: async (data: { to: string; subject: string; body: string }, meta: JobMeta) => {
    await emailService.send(data.to, data.subject, data.body);
    return { sent: true };
  },
  retries: 3,
  backoff: { type: 'exponential', delay: 1000 },
  timeout: 30000,
  concurrency: 5,
  rateLimit: { max: 100, duration: 60000 },  // 100/min
  deadLetterQueue: 'send-email:dead',
});

const processImage = defineJob({
  name: 'process-image',
  handler: async (data: { url: string; width: number }) => {
    return await sharp(data.url).resize(data.width).toBuffer();
  },
  retries: 2,
  timeout: 60000,
});
```

### Register Plugin

```typescript
await fastify.register(jobsPlugin, {
  connection: { host: 'localhost', port: 6379, password: '...' },
  jobs: [sendEmail, processImage],
  prefix: '/jobs',            // Stats endpoint: GET /jobs/stats
  bridgeEvents: true,         // Emit job.{name}.completed / job.{name}.failed
  defaults: {
    retries: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,    // Keep last 100 completed
    removeOnFail: 500,        // Keep last 500 failed
  },
});
```

### Dispatch Jobs

```typescript
// Basic dispatch
await fastify.jobs.dispatch('send-email', { to: 'user@example.com', subject: 'Hi', body: 'Hello' });

// With options
await fastify.jobs.dispatch('process-image', { url: '...', width: 800 }, {
  delay: 5000,              // Delay 5s
  priority: 1,              // Lower = higher priority
  jobId: 'unique-123',     // Deduplication
  removeOnComplete: true,
});

// Get stats
const stats = await fastify.jobs.getStats();
// { 'send-email': { waiting: 5, active: 2, completed: 100, failed: 3, delayed: 0 } }
```

### Timeout & DLQ

Job timeout via `Promise.race` (timer always cleaned up). DLQ queues tracked and closed on shutdown:

```typescript
defineJob({ name: 'x', handler, timeout: 60000, deadLetterQueue: 'x:dead', retries: 3 });
```

### Event Bridge

When `bridgeEvents: true` (default), job events fire-and-forget (never fail the worker):
- `job.send-email.completed` — `{ jobId, data, result }`
- `job.send-email.failed` — `{ jobId, data, error, attemptsMade }`

### Types

```typescript
interface JobMeta { jobId: string; attemptsMade: number; timestamp: number; }
interface JobDispatchOptions { delay?; priority?; jobId?; removeOnComplete?; removeOnFail?; }
interface QueueStats { waiting; active; completed; failed; delayed; }
```

---

## WebSocket

```typescript
import { websocketPlugin } from '@classytic/arc/integrations/websocket';
```

**Requires:** `@fastify/websocket` (peer dependency), persistent runtime (not serverless)

### Setup

```typescript
import fastifyWebsocket from '@fastify/websocket';

await fastify.register(fastifyWebsocket);
await fastify.register(websocketPlugin, {
  path: '/ws',
  auth: true,                    // Fail-closed: throws if authenticate not registered
  resources: ['product', 'order'],  // Auto-broadcast CRUD events
  heartbeatInterval: 30000,      // Ping every 30s (0 to disable)
  maxClientsPerRoom: 10000,

  // Security controls
  roomPolicy: (client, room) => {       // Authorize room subscriptions (default: allow all)
    return ['product', 'order'].includes(room);
  },
  maxMessageBytes: 16384,               // Max message size from client (default: 16KB)
  maxSubscriptionsPerClient: 100,       // Max rooms per client (default: 100)
  exposeStats: 'authenticated',         // Stats at /ws/stats (false | true | 'authenticated')

  // Lifecycle hooks
  authenticate: async (request) => {    // Custom auth (optional)
    const { getOrgId } = await import('@classytic/arc/scope');
    return { userId: request.user?.id, organizationId: getOrgId(request.scope) };
  },
  onConnect: async (client) => { console.log('Connected:', client.id); },
  onDisconnect: async (client) => { console.log('Disconnected:', client.id); },
  onMessage: async (client, msg) => { /* custom message handler */ },
});
```

**Fail-closed auth:** When `auth: true` (default), registration throws if `fastify.authenticate` is not available and no custom `authenticate` function is provided. This prevents accidentally exposing WebSocket without auth.

### Client Protocol

```javascript
const ws = new WebSocket('ws://localhost:3000/ws');

// Server sends on connect:
// { type: 'connected', clientId: 'ws_1_...', resources: ['product', 'order'] }

// Subscribe to resource events
ws.send(JSON.stringify({ type: 'subscribe', resource: 'product' }));
// → { type: 'subscribed', channel: 'product' }

// Server pushes CRUD events:
// { type: 'product.created', data: { ... }, meta: { timestamp, userId, organizationId } }

// Unsubscribe
ws.send(JSON.stringify({ type: 'unsubscribe', resource: 'product' }));

// Heartbeat: server sends { type: 'ping' }, client responds { type: 'pong' }
```

### Server-Side Broadcasting

```typescript
// Broadcast to room
fastify.ws.broadcast('product', { action: 'price-updated', productId: '123' });

// Org-scoped broadcast (only clients in same org)
fastify.ws.broadcastToOrg('org-456', 'product', { ... });

// Stats
fastify.ws.getStats(); // { clients: 150, rooms: 5, subscriptions: { product: 80, order: 70 } }
```

### RoomManager

```typescript
// Access room manager directly
const rooms = fastify.ws.rooms;
rooms.subscribe(clientId, 'custom-room');
rooms.broadcast('custom-room', JSON.stringify({ type: 'custom', data: {} }));
rooms.broadcastToOrg(orgId, 'custom-room', JSON.stringify({ ... }));
```

### Multi-Tenant Auto-Scoping

When Arc events include `organizationId`, WebSocket broadcasts are automatically scoped:
- Client with `organizationId: 'org-A'` only receives events for org-A
- No cross-tenant data leakage

---

## EventGateway (Unified SSE + WebSocket)

```typescript
import { eventGatewayPlugin } from '@classytic/arc/integrations/event-gateway';
```

Single configuration point for both SSE and WebSocket with shared auth, org-scoping, and room policy:

```typescript
await fastify.register(eventGatewayPlugin, {
  auth: true,                     // Fail-closed for both SSE and WebSocket
  orgScoped: true,                // Filter events by org
  roomPolicy: (client, room) => {
    return ['product', 'order', 'invoice'].includes(room);
  },
  maxMessageBytes: 8192,          // WS message size cap
  maxSubscriptionsPerClient: 50,  // WS subscription limit

  sse: {                          // false to disable SSE
    path: '/api/events',
    patterns: ['order.*', 'product.*'],
  },
  ws: {                           // false to disable WebSocket
    path: '/ws',
    resources: ['product', 'order'],
    exposeStats: 'authenticated',
  },
});
```

**`@fastify/websocket` auto-registration:** EventGateway auto-registers `@fastify/websocket` if not present. Throws with install instructions if package missing (or use `ws: false`).

**When to use:** Prefer EventGateway over separate SSE + WebSocket registration when you want consistent auth, org-scoping, and security policy across both transports.

---

## Streamline Workflows

```typescript
import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
```

**Requires:** `@classytic/streamline` (peer dependency)

### Setup

```typescript
import { createWorkflow } from '@classytic/streamline';

const orderWorkflow = createWorkflow({ id: 'order', name: 'Order Processing', steps: { ... } });

await fastify.register(streamlinePlugin, {
  workflows: [orderWorkflow],
  prefix: '/api/workflows',
  auth: true,              // Require authentication (default, gracefully degrades)
  bridgeEvents: true,      // Publish workflow.{id}.started/resumed/cancelled
  permissions: {           // Per-operation permissions (all optional, default: allow)
    start: (request) => request.user?.role === 'admin',
    cancel: (request) => request.user?.role === 'admin',
  },
});
```

### Auto-Generated Routes

| Route | Description |
|-------|-------------|
| `GET /api/workflows` | List all registered workflows |
| `POST /api/workflows/:id/start` | Start a new run (`{ input, meta }`) |
| `GET /api/workflows/:id/runs/:runId` | Get run status |
| `POST /api/workflows/:id/runs/:runId/resume` | Resume waiting run (`{ payload }`) |
| `POST /api/workflows/:id/runs/:runId/cancel` | Cancel a run |
| `POST /api/workflows/:id/runs/:runId/pause` | Pause (if engine supports) |
| `POST /api/workflows/:id/runs/:runId/rewind` | Rewind to step (`{ stepId }`) |

### Fastify Decorators

```typescript
fastify.workflows;          // Map<string, WorkflowLike>
fastify.getWorkflow('order'); // Get specific workflow
```

### Event Bridge

- `workflow.order.started` — `{ runId, workflowId, status }`
- `workflow.order.resumed` — `{ runId, workflowId, status }`
- `workflow.order.cancelled` — `{ runId, workflowId }`

### Auth & Permissions

All optional, gracefully degrade:
- `auth: false` — No authentication required
- If `fastify.authenticate` is not registered, auth middleware is skipped
- If no permission check defined for an operation, defaults to allow

---

## Webhooks (Outbound)

```typescript
import { webhookPlugin } from '@classytic/arc/integrations/webhooks';
```

Fastify plugin that auto-dispatches Arc events to customer webhook endpoints with HMAC-SHA256 signing, delivery logging, bounded concurrency, and pluggable persistence.

### Setup

```typescript
await fastify.register(webhookPlugin);

// With custom store (MongoDB, Redis, etc.)
await fastify.register(webhookPlugin, {
  store: myMongoWebhookStore,  // implements WebhookStore { getAll, save, remove }
  timeout: 5000,               // delivery timeout (default: 10000ms)
  maxLogEntries: 500,          // ring buffer cap (default: 1000)
  concurrency: 10,             // max parallel deliveries per event (default: 5)
});
```

**Requires:** `arc-events` plugin (auto-registered by `createApp`).

### Register Webhooks

```typescript
await app.webhooks.register({
  id: 'wh-1',
  url: 'https://customer.com/webhook',
  events: ['order.created', 'order.shipped'],
  secret: 'whsec_abc123',
});

// Patterns: exact ('order.created'), prefix ('order.*'), global ('*')
```

### Auto-Dispatch

Events published via `fastify.events.publish()` auto-deliver to matching webhooks — no manual wiring:

```typescript
await app.events.publish('order.created', { orderId: '123' });
// → POST https://customer.com/webhook
//   Headers: x-webhook-signature, x-webhook-id, x-webhook-event
//   Body: { type, payload, meta }
```

Deliveries run with bounded concurrency (default: 5) — one slow endpoint won't block the rest. Set `concurrency: 1` for sequential delivery.

### HMAC Signing & Verification

**Outbound** — every delivery is signed with the subscription's secret:

```
x-webhook-signature: sha256=a1b2c3...
```

**Inbound** — verify with `verifySignature()` (timing-safe, never throws):

```typescript
import { verifySignature } from '@classytic/arc/integrations/webhooks';

fastify.post('/webhooks/incoming', async (req, reply) => {
  const sig = req.headers['x-webhook-signature'] as string;
  if (!verifySignature(req.rawBody, secret, sig)) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }
  // handle event via req.headers['x-webhook-event']
});
```

Accepts `string | Buffer` body, `string | undefined` signature. Configurable for non-Arc senders:

```typescript
// GitHub (same prefix, same algorithm — works with defaults)
verifySignature(body, secret, req.headers['x-hub-signature-256']);

// Custom algorithm / bare hex
verifySignature(body, secret, req.headers['x-custom-sig'], {
  prefix: '',           // bare hex, no prefix
  algorithm: 'sha512',  // non-default algorithm
});
```

**Note:** `req.rawBody` requires `fastify-raw-body` — JSON re-serialization breaks HMAC since field ordering differs.

### Delivery Log

```typescript
const log = app.webhooks.deliveryLog();     // all entries
const recent = app.webhooks.deliveryLog(10); // last 10

// Each entry: { subscriptionId, eventType, success, status?, error?, timestamp }
```

### WebhookStore Interface

Implement for persistent subscriptions (default: in-memory):

```typescript
interface WebhookStore {
  readonly name: string;
  getAll(): Promise<WebhookSubscription[]>;
  save(sub: WebhookSubscription): Promise<void>;
  remove(id: string): Promise<void>;
}
```

### Fastify Decorators

```typescript
app.webhooks.register(sub)    // Add/replace subscription
app.webhooks.unregister(id)   // Remove subscription
app.webhooks.list()           // All subscriptions (copy)
app.webhooks.deliveryLog(n?)  // Delivery history (ring buffer)
```
