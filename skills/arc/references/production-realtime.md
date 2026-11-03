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
- No replay: on reconnect, refetch the list. For a resumable stream use `createReplayHub` (below).
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
- `fastify.sseStats()` returns `{ connections, keys }`, summed over ssePlugin, realtime feeds, replay hubs and `createSseConnectionGauge(app)` (custom routes call `gauge.track(stream)`). Register at boot: `decorate` after ready throws.

## Resumable custom stream (replay over a ChangeLogStore)

```typescript
import { createReplayHub, lastEventIdOf, openSseStream } from '@classytic/arc/utils';

const hub = createReplayHub(app, {                  // at boot, before ready
  store,                                            // repo-core ChangeLogStore (mongokit createChangeLogStore, MemoryChangeLogStore)
  readScope: (ctx) => ({ tenantId: ctx.orgId, scopes: ['alerts'] }),   // tail partition + since() filter
  toFrame: (entry, ctx) => (canSee(ctx, entry) ? { event: 'alert', data: entry.doc } : null),
  isValidCursor: (c) => /^\d{16}$/.test(c),
  compareCursors: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  revalidate: { everyMs: 15_000, check: (ctx, { memo }) => stillAllowed(ctx, memo), maxConsecutiveFailures: 3 },   // null/undefined/false → revoked; { close: 'revoke' | 'retry', reason }
  identify: (ctx) => ({ userId: ctx.userId, sessionId: ctx.sessionId }),
  revokeVia: { secret: env.REALTIME_REVOKE_SECRET }, // hub.revoke() reaches every replica, sealed (AES-GCM)
});
await app.events.subscribe('alert.*', () => hub.notify());   // the bus only WAKES the tail
// route, after every gate:
await hub.attach(openSseStream(req, reply), ctx, lastEventIdOf(req));
```

- Frames: `ready {cursor, resumed}` first, then the replay or one `resync {cursor, reason}`, then live (`id:` = cursor). `revoked {reason}` then close (final). `retry {reason}` then close (not final: reconnect now). Names: `STREAM_FRAMES`, same literals as `@classytic/arc-next/sse`.
- `openSseStream` waits for `drain` (`maxBufferedBytes` 1 MiB, `drainTimeoutMs` 10 s; `0` bytes = old fail-fast); the hub paces a replay on `needsDrain`/`drain()`, so a large resume is not cut.
- A live entry the replay already sent goes out once. Entries hidden by `toFrame` are followed by an id-only frame, so the client cursor keeps up.
- Gap over `maxReplay` (500) → `gap_too_large`; `CursorExpiredError` → `cursor_expired`; invalid or ahead → `cursor_invalid`. Other store errors close with no frame.
- mongokit `compactSuperseded` keeps only the latest entry per doc, so replay yields latest state; a foreign cursor throws there, so set `isValidCursor`.

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
