# Streamline workflows

```typescript
import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
```

Peer: `@classytic/streamline`. Workflows come from `createWorkflow` there.

```typescript
await app.register(streamlinePlugin, {
  workflows: [orderWorkflow],
  prefix: '/api/workflows',          // default '/workflows'
  auth: true,                        // default
  bridgeEvents: true,                // default: workflow.<id>.started|resumed|cancelled
  bridgeBusEvents: false,            // true: every engine event as workflow.<id>.<eventName>
  enableStreaming: false,            // true: SSE run stream
  enableHookEndpoint: false,         // true: POST <prefix>/hooks/:token
  tenantResolver: (req) => req.user?.organizationId,       // from auth, never the body
  bypassTenantResolver: (req) => false,
  permissions: { start: (req) => true, cancel: (req) => true },   // also resume, list, get, execute, pause, rewind
  idempotency: { required: ['start'], workflows: ['order'] },     // needs idempotencyPlugin
});
```

`execute` falls back to the `start` permission; `pause` and `rewind` fall back to `cancel`.

## Routes (per workflow `<prefix>/<id>`)

| Route | Purpose |
|---|---|
| `GET <prefix>` | List workflows |
| `POST <prefix>/<id>/start` | Start a run |
| `GET <prefix>/<id>/runs`, `GET .../runs/:runId` | List, get runs |
| `POST .../runs/:runId/resume` | Resume a waiting run (`{ payload }`) |
| `POST .../runs/:runId/cancel`, `/execute`, `/pause`, `/rewind` | Run control (`pause`, `rewind`, `wait` depend on the engine) |
| `DELETE .../runs/:runId` | Cancel then delete, when the repository supports it |
| `GET .../runs/:runId/wait` | Poll until terminal, when the engine supports it |
| `GET .../runs/:runId/stream` | SSE with `enableStreaming`; closes on terminal state |
| `POST <prefix>/hooks/:token` | Resume via hook with `enableHookEndpoint`; workflow must pass `{ hookToken: hook.token }` to `ctx.wait` |

## Events and decorators

- Bridge payload: `{ runId, workflowId, status }` for started and resumed, `{ runId, workflowId }` for cancelled.
- Constants: `STREAMLINE_BUS_EVENTS`, `STREAMLINE_STREAM_EVENTS`, `STREAMLINE_TERMINAL_EVENTS`, `STREAMLINE_FAILURE_CODES`, `TERMINAL_RUN_STATUSES`, `isStreamTerminal(eventOrStatus, compensates, kind)`.
- Decorators: `app.workflows` (Map), `app.getWorkflow(id)`.
- A failed run with compensation keeps streaming its rollback; without it, `failed` is terminal.
- If `fastify.authenticate` is missing, auth middleware is skipped. A permission left unset allows.
