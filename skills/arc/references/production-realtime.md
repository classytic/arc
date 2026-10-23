# Production: SSE, realtime change feed, streaming routes

Pick by need:

| Need | Use |
|---|---|
| Per-user live views of a resource (list permission, row filter, field masking) | `arcPlugins.realtime` |
| Raw domain-event firehose | `arcPlugins.sse` |
| Bidirectional or geo rooms | `integrations/websocket` (its CRUD bridge is org-coarse: never expose row-permissioned resources through it) |
| Massive fan-out (viral feeds, live scores) | Publish once via `app.events.subscribe(...)` to a dedicated edge fan-out tier |

Both feeds need the event plugin (on by default).

## Realtime change feed

```typescript
const app = await createApp({
  arcPlugins: { realtime: { path: '/realtime/:resource', heartbeat: 30_000, resources: ['order'], maxConnectionMs: 30 * 60_000 } },
});
```

- `GET /realtime/:resource` (resource name) and multiplexed `GET /realtime?resources=a,b,c` (max 20).
- Gated by the resource's own `list` permission; per-event row filtering, tenant guard, field masking.
- Client: plain `EventSource` with `?token=` (`tokenQueryParam`, default `token`, `null` disables).
- No replay: on reconnect, refetch the list.
- Permission filters are snapshotted at connect. The feed closes at token `exp` and at `maxConnectionMs` (default 30 min) to bound staleness.

## SSE plugin

```typescript
const app = await createApp({
  arcPlugins: {
    sse: {
      path: '/events/stream',            // default
      requireAuth: true,                 // default; throws at registration if fastify.authenticate is missing
      patterns: ['order.*', 'product.*'],// default ['*']
      orgScoped: true,                   // default: events with organizationId reach only that org
      heartbeat: 30_000,
      filter: (event, request) => true,
      audience: (event) => [(event.payload as { ownerId: string }).ownerId],   // keyed delivery; connections key on scope user id
    },
  },
});
// Manual: import { ssePlugin } from '@classytic/arc/plugins';
```

- Events without `organizationId` reach every caller. An elevated admin with no active org sees all tenants.
- `orgScoped: false` only for a deliberately cross-tenant stream; keep `requireAuth` and add a `filter`.
- `fastify.sseStats()` returns `{ connections, keys }`.

## Streaming custom routes

```typescript
import { requireAuth } from '@classytic/arc/permissions';
import { pipeUIMessageStreamToReply } from '@classytic/arc/utils';

routes: [{
  method: 'POST', path: '/chat',
  streamResponse: true,                  // SSE headers, bypasses response serialization
  permissions: requireAuth(),
  preAuth: [(req) => { const t = (req.query as { token?: string }).token; if (t) req.headers.authorization = `Bearer ${t}`; }],
  handler: async (req, reply) => {
    await pipeUIMessageStreamToReply(reply, result.toUIMessageStream());
  },
}]
```

- `preAuth` handlers run before authentication; use them to promote `?token=` because `EventSource` cannot set headers. `promoteStreamTokenToHeader(request, 'token')` from `@classytic/arc/utils` does this safely (no-op when `Authorization` exists, token still fully authenticated).
- `openSseStream` (utils) takes over the socket after every gate has passed; no JSON error can be sent afterwards.
- Edge `toFetchHandler` cannot stream.
