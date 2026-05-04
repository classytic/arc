# Events

**Summary**: `EventPlugin` publishes domain events via pluggable transports. Publishing is fire-and-forget by default. Use the outbox for guaranteed delivery.
**Sources**: src/events/.
**Last updated**: 2026-04-21.

---

## Shape

```ts
import { EventMeta, DomainEvent, createEvent, createChildEvent } from '@classytic/primitives/events';

// EventMeta
{
  id, timestamp,
  schemaVersion?, correlationId?, causationId?, partitionKey?,
  source?, idempotencyKey?,
  resource?, resourceId?, userId?, organizationId?,
  aggregate?: { type: string; id: string },   // NOT inherited by createChildEvent
}
```

- `@classytic/primitives/events` is the source of truth for event types (`EventMeta`, `DomainEvent`, `EventHandler`, `EventLogger`, `EventTransport`, `DeadLetteredEvent`, `PublishManyResult`, `createEvent`, `createChildEvent`, `matchEventPattern`). Arc re-exports the runtime `MemoryEventTransport` only.
- Domain packages narrow `aggregate.type` to a closed union via interface extension.
- `createChildEvent(parent, type, payload)` auto-chains causation + inherits `correlation`, `source`, `idempotencyKey`. `aggregate` is **not** inherited.

## Transports

| Transport | Guarantee | Use |
|---|---|---|
| memory | in-process | dev/test |
| Redis pub/sub | at-most-once | low-latency, lossy OK |
| Redis Streams | at-least-once | durable; consumer groups track offsets |

Redis Streams does **not** dedupe — handlers must be idempotent. See [[gotchas]] #3.

`DeadLetteredEvent<T>` + optional `transport.deadLetter()` added for native-DLQ transports (Kafka/SQS).

## Publishing is fire-and-forget (`failOpen: true`)

If publishing fails, the HTTP request still succeeds. For guaranteed delivery, use the outbox. Don't change the default — it protects user-facing latency. See [[gotchas]] #7.

## Dual-publish dev-warn

Calling `app.events.publish()` manually for the same event type that an `eventStrategy: 'auto'` resource hook also emits triggers a one-shot `console.warn` in development. Pick one path: manual publish OR `eventStrategy`, not both.

## Outbox (v2.9+)

Pattern for exactly-once-effective delivery with DB-level atomicity.

```ts
new EventOutbox({ repository, transport });  // repository is any RepositoryLike — see [[adapters]]
```

- `store()` auto-maps `meta.idempotencyKey` → `OutboxWriteOptions.dedupeKey`.
- `failurePolicy({ event, error, attempts }) => { retryAt?, deadLetter? }` centralises retry/DLQ.
- `store.getDeadLettered?(limit)` returns `DeadLetteredEvent[]`.
- `RelayResult.deadLettered` counts per batch.

v2.10.3 fixed a plugin onSend race + idempotency lock-leak (closures captured stale reply state). See [[plugins]] and [[gotchas]] #15.

## WAL skips `arc.*` internal events

Prevents startup timeout with durable stores. See [[gotchas]] #7-8.

## Related
- [[adapters]] — outbox consumes `RepositoryLike`
- [[hooks]] — after hooks typically publish events
- [[plugins]] — idempotency plugin pairs with outbox
