# WebSocket and event gateway

Peer: `@fastify/websocket`. Needs a persistent runtime (not serverless).

## websocketPlugin

```typescript
import fastifyWebsocket from '@fastify/websocket';
import { websocketPlugin } from '@classytic/arc/integrations/websocket';

await app.register(fastifyWebsocket);
await app.register(websocketPlugin, {
  path: '/ws',
  auth: true,                     // default; fails at boot if no fastify.authenticate and no authenticate()
  resources: ['product', 'order'],   // auto-broadcast <resource>.created|updated|deleted to the room of that name
  roomPolicy: (client, room) => ['product', 'order'].includes(room),   // default allow all
  authenticate: async (request) => ({ userId, organizationId }),       // returns AuthResult | null
  heartbeatInterval: 30000,       // 0 disables
  reauthInterval: 300000,         // 0 disables; expired token closes with 4003
  maxClientsPerRoom: 10000,
  maxMessageBytes: 16384,
  maxSubscriptionsPerClient: 100,
  maxOutboundBytes: 5 * 1024 * 1024,
  exposeStats: 'authenticated',   // false (default) | true | 'authenticated'; route {path}/stats
  onConnect, onDisconnect, onMessage,
});
```

Org-scoped events (`meta.organizationId`) reach only clients of that org.

## Client protocol

| Direction | Message |
|---|---|
| server to client on connect | `{ type: 'connected', clientId, pushRef, resources }` |
| client to server | `{ type: 'subscribe', resource }` (or `channel`), `{ type: 'unsubscribe', resource }` |
| server reply | `{ type: 'subscribed', channel }`, `{ type: 'unsubscribed', channel }`, `{ type: 'error', error }` |
| CRUD push | `{ type: 'product.created', data, meta }` |
| room broadcast | `{ type: 'broadcast', channel, data }` |
| direct send | `{ type: 'direct', data }` |

Heartbeat uses RFC 6455 ping frames. `?pushRef=` on the upgrade URL resumes a session.

## Server API

```typescript
app.ws.broadcast('product', { productId: '1' });
app.ws.broadcastToOrg('org-1', 'product', {});
app.ws.send({ userId }, data);                    // or { pushRef }; critical, ordered
app.ws.sendRealtime({ userId }, data, 'coalesce-key');   // droppable, coalesced
app.ws.getStats();
app.ws.rooms;                                     // RoomManager
```

## Resume and scale-out

| Need | Option |
|---|---|
| Replay after reconnect | `messageEnvelope: 'seq'` (wraps critical sends as `{ seq, t, msg }`; client sends `{ type: 'resume', lastSeq }`), `deadQueueSize` (128), `pushRefTtlMs` (60000), `pushRefMaxEntries` (10000) |
| Multi-instance broadcast | `adapter: new RedisWebSocketAdapter(redis, { channel: 'arc-ws' })` from `@classytic/arc/integrations/websocket-redis` |
| Resume across nodes | `pushRefStore: new RedisPushRefStore(redis, { keyPrefix, graceMs })` from `@classytic/arc/integrations/websocket-pushref-redis` |

The default `LocalWebSocketAdapter` is single-instance. Also exported: `RoomManager`, `GeoRoom`, `PushRefRegistry`, `MemoryPushRefStore`.

## eventGatewayPlugin (SSE plus WebSocket)

One config for both transports with shared auth, tenant scoping and room policy.

```typescript
import { eventGatewayPlugin } from '@classytic/arc/integrations/event-gateway';

await app.register(eventGatewayPlugin, {
  auth: true,                      // default; boot fails without fastify.authenticate or authenticate()
  roomPolicy: (client, room) => ['product', 'order'].includes(room),
  maxMessageBytes: 8192,
  maxSubscriptionsPerClient: 50,
  sse: { path: '/api/events', patterns: ['order.*'], heartbeat: 30000, filter: (event, request) => true },   // false disables
  ws: { path: '/ws', resources: ['product', 'order'], exposeStats: 'authenticated' },                      // false disables
});
```

- `orgScoped` is forwarded to SSE only when set; SSE defaults to tenant-scoped. Set `false` only for a cross-tenant ops stream.
- Registers `@fastify/websocket` itself; throws with install instructions if missing (or pass `ws: false`).
- Prefer it over registering SSE and WebSocket separately.
